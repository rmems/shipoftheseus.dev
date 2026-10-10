/**
 * Opt-in timing probe for the live demo's performance budgets (GitHub #10 /
 * Linear RM-1646). See `docs/architecture/performance-budgets.md`.
 *
 * The probe exists only under `astro dev` or when the page URL carries
 * `?neuromorphic-perf` ({@link perfProbeRequested}). Otherwise the live seams
 * pass `null` and every instrumented site is a single null check, so a normal
 * production visit pays nothing measurable.
 *
 * Every stage keeps a fixed-size ring of its most recent samples plus lifetime
 * count/total/max, so a probe left running for hours stays bounded.
 *
 * Timestamps come from `performance.now()`, which browsers coarsen (Chrome:
 * 100 µs without cross-origin isolation). Sub-100 µs stages therefore read as
 * 0 or 0.1 ms per sample; use the batched microbenchmarks in
 * `scripts/perf/` for those, and this probe for end-to-end and frame timing.
 */

/** URL query parameter that opts a production page into the probe. */
export const PERF_PROBE_QUERY = 'neuromorphic-perf';

/** Samples kept per stage. */
export const DEFAULT_PERF_PROBE_WINDOW = 2048;

export type PerfStage =
  /** Driver tick: telemetry sample → input → step → publish. */
  | 'tick'
  /** `engine.input` (main thread: WASM call; worker: request round trip). */
  | 'tick-input'
  /** `engine.step` (main thread: WASM step + snapshot; worker: round trip + transfer). */
  | 'tick-step'
  /** `channel.publish`: renderer latch, spike-event ingestion, listeners. */
  | 'publish'
  /** `SpikeEventBuffer.ingest` alone. */
  | 'spike-ingest'
  /** The live session's per-tick telemetry hook (`onFrame`). */
  | 'telemetry'
  /** Main-thread time spent drawing one frame. */
  | 'frame-work'
  /** Interval between animation-frame callbacks. */
  | 'frame-interval';

export interface PerfStageSummary {
  /** Lifetime samples. */
  count: number;
  /** Lifetime mean and max. */
  meanMs: number;
  maxMs: number;
  /** Percentiles over the retained window. */
  windowCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface PerfSummary {
  stages: Partial<Record<PerfStage, PerfStageSummary>>;
  counters: Record<string, number>;
  /** Milliseconds since the probe was created, keyed by mark name (first occurrence). */
  marks: Record<string, number>;
  /** The probe's creation time on the `now()` clock (page: `performance.now()`). */
  originMs: number;
  timerResolutionMs: number;
}

export interface PerfProbe {
  readonly now: () => number;
  record: (stage: PerfStage, ms: number) => void;
  increment: (counter: string, by?: number) => void;
  /** Record the first time `name` happens. */
  mark: (name: string) => void;
  summary: () => PerfSummary;
  /** Drop samples and counters; marks are kept. */
  reset: () => void;
}

interface StageRing {
  samples: Float64Array;
  next: number;
  filled: number;
  count: number;
  total: number;
  max: number;
}

function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** Smallest non-zero step of the clock, observed (bounded busy loop). */
function observedResolution(now: () => number): number {
  let smallest = Number.POSITIVE_INFINITY;
  let previous = now();
  for (let attempt = 0; attempt < 10_000 && smallest === Number.POSITIVE_INFINITY; attempt += 1) {
    const current = now();
    if (current > previous) {
      smallest = current - previous;
    }
    previous = current;
  }
  return Number.isFinite(smallest) ? smallest : 0;
}

export function createPerfProbe(
  options: { windowSize?: number; now?: () => number } = {},
): PerfProbe {
  const windowSize = options.windowSize ?? DEFAULT_PERF_PROBE_WINDOW;
  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new RangeError('perf probe window must be a positive integer');
  }
  const now = options.now ?? (() => performance.now());
  const origin = now();
  const stages = new Map<PerfStage, StageRing>();
  const counters = new Map<string, number>();
  const marks = new Map<string, number>();
  let resolution: number | null = null;

  const ring = (stage: PerfStage): StageRing => {
    let entry = stages.get(stage);
    if (!entry) {
      entry = { samples: new Float64Array(windowSize), next: 0, filled: 0, count: 0, total: 0, max: 0 };
      stages.set(stage, entry);
    }
    return entry;
  };

  return {
    now,
    record(stage, ms) {
      if (!Number.isFinite(ms) || ms < 0) {
        return;
      }
      const entry = ring(stage);
      entry.samples[entry.next] = ms;
      entry.next = (entry.next + 1) % windowSize;
      entry.filled = Math.min(windowSize, entry.filled + 1);
      entry.count += 1;
      entry.total += ms;
      entry.max = Math.max(entry.max, ms);
    },
    increment(counter, by = 1) {
      counters.set(counter, (counters.get(counter) ?? 0) + by);
    },
    mark(name) {
      if (!marks.has(name)) {
        marks.set(name, now() - origin);
      }
    },
    summary() {
      resolution ??= observedResolution(now);
      const stageSummaries: Partial<Record<PerfStage, PerfStageSummary>> = {};
      for (const [stage, entry] of stages) {
        const sorted = entry.samples.slice(0, entry.filled).sort();
        stageSummaries[stage] = {
          count: entry.count,
          meanMs: entry.count > 0 ? entry.total / entry.count : 0,
          maxMs: entry.max,
          windowCount: entry.filled,
          p50Ms: quantile(sorted, 0.5),
          p95Ms: quantile(sorted, 0.95),
          p99Ms: quantile(sorted, 0.99),
        };
      }
      return {
        stages: stageSummaries,
        counters: Object.fromEntries(counters),
        marks: Object.fromEntries(marks),
        originMs: origin,
        timerResolutionMs: resolution,
      };
    },
    reset() {
      stages.clear();
      counters.clear();
    },
  };
}

/** Whether this page asked for the probe (`?neuromorphic-perf`). */
export function perfProbeRequested(host: { location?: { search?: string } } = globalThis): boolean {
  const search = host.location?.search;
  if (typeof search !== 'string' || search.length === 0) {
    return false;
  }
  try {
    return new URLSearchParams(search).has(PERF_PROBE_QUERY);
  } catch {
    return false;
  }
}

/**
 * Time a function into `stage` when a probe is present; otherwise just call
 * it. Kept for call sites that are not hot enough to inline the check.
 */
export function timed<T>(probe: PerfProbe | null, stage: PerfStage, run: () => T): T {
  if (!probe) {
    return run();
  }
  const start = probe.now();
  try {
    return run();
  } finally {
    probe.record(stage, probe.now() - start);
  }
}
