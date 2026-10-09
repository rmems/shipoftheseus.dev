import { DEMO_TICK_MS } from './demo-stimulus';

/**
 * Adaptive presentation quality for the live neuromorphic demo (GitHub #10 /
 * Linear RM-1646).
 *
 * **Presentation only.** Every knob here changes how much of the simulation is
 * drawn or displayed, never what the simulation computes: the renderer's
 * device-pixel-ratio cap, how many propagation pulses it draws, how often it
 * draws, and how often telemetry/DOM consumers refresh. The WASM session, its
 * fixed 50 ms tick, the pointer/scripted input packets, and the spike-event
 * buffer never read this module, so the same seed and inputs produce the same
 * snapshots at every level (`test/performance-semantics.test.mjs` proves it against
 * the real WASM package).
 *
 * **Pressure signal.** The renderer reports every animation-frame callback:
 * the interval since the previous callback and the CPU time it spent drawing.
 * Frames are grouped into ~1 s windows. A window is under *pressure* when its
 * 90th-percentile interval is slower than {@link DEFAULT_PRESSURE_INTERVAL_MS}
 * (below ~45 fps) or its mean draw time exceeds the CPU budget; it is
 * *relieved* when the p90 interval beats {@link DEFAULT_RELIEF_INTERVAL_MS}
 * and the draw time is under half the budget. Two pressured windows in a row
 * step quality down one level; five relieved windows in a row step it back
 * up. A downshift soon after an upshift doubles the relief needed next time
 * (up to {@link MAX_UPSHIFT_WINDOWS}), so quality cannot oscillate.
 *
 * GPU work is only visible through the interval (the browser delays animation
 * frames when the GPU falls behind), so a display or power mode that caps
 * animation frames below ~45 Hz also reads as pressure and holds a lower
 * level. That trade is deliberate: such devices are the ones that need it.
 */

export type QualityLevelName = 'full' | 'balanced' | 'reduced' | 'minimal';

export interface QualitySettings {
  /** `0` is full quality; higher levels shed more presentation work. */
  readonly level: number;
  readonly name: QualityLevelName;
  /** Upper bound applied to `devicePixelRatio` for the WebGL drawing buffer. */
  readonly maxPixelRatio: number;
  /**
   * Most propagation pulses drawn per frame. `Infinity` means the spike-event
   * buffer's capacity; `0` turns pulses off. Events are buffered (and
   * delivered to telemetry subscribers) identically at every level.
   */
  readonly maxPulses: number;
  /** Minimum wall-clock gap between drawn frames; `0` draws on every animation frame. */
  readonly minFrameIntervalMs: number;
  /**
   * Telemetry/DOM consumers (the spike raster panel, homepage counters) should
   * refresh on every `telemetryCadenceSteps`-th completed simulation step; see
   * {@link shouldSampleTelemetry}. This never changes how often the
   * simulation steps or samples pointer input.
   */
  readonly telemetryCadenceSteps: number;
}

/**
 * The quality ladder, best first. Values are design targets (see
 * `docs/architecture/performance-budgets.md`), not measurements.
 */
export const QUALITY_LADDER: readonly QualitySettings[] = Object.freeze([
  Object.freeze({
    level: 0,
    name: 'full',
    maxPixelRatio: 2,
    maxPulses: Number.POSITIVE_INFINITY,
    minFrameIntervalMs: 0,
    telemetryCadenceSteps: 1,
  }),
  Object.freeze({
    level: 1,
    name: 'balanced',
    maxPixelRatio: 1.5,
    maxPulses: 256,
    minFrameIntervalMs: 0,
    telemetryCadenceSteps: 2,
  }),
  Object.freeze({
    level: 2,
    name: 'reduced',
    maxPixelRatio: 1,
    maxPulses: 96,
    minFrameIntervalMs: 1000 / 30,
    telemetryCadenceSteps: 10,
  }),
  Object.freeze({
    level: 3,
    name: 'minimal',
    maxPixelRatio: 1,
    maxPulses: 0,
    // One frame per simulation step: with pulses off nothing moves faster.
    minFrameIntervalMs: DEMO_TICK_MS,
    telemetryCadenceSteps: 20,
  }),
] satisfies QualitySettings[]);

/** p90 frame interval above which a window counts as pressured (≈45 fps). */
export const DEFAULT_PRESSURE_INTERVAL_MS = 1000 / 45;
/** p90 frame interval below which a window counts as relieved (≈55 fps). */
export const DEFAULT_RELIEF_INTERVAL_MS = 1000 / 55;
/** Mean main-thread draw time per drawn frame regarded as the CPU budget. */
export const DEFAULT_FRAME_WORK_BUDGET_MS = 8;
/** Minimum span of one evaluation window. */
export const DEFAULT_WINDOW_MS = 1000;
/** Consecutive pressured windows before stepping down. */
export const DEFAULT_DOWNSHIFT_WINDOWS = 2;
/** Consecutive relieved windows before stepping up (before backoff). */
export const DEFAULT_UPSHIFT_WINDOWS = 5;
/** Ceiling for the upshift backoff. */
export const MAX_UPSHIFT_WINDOWS = 40;
/** An interval longer than this is a stall or a resume, not a frame. */
export const MAX_FRAME_INTERVAL_MS = 1000;
/** Fewest frames a window needs before it is judged. */
const MIN_WINDOW_FRAMES = 10;
/** Frames retained per window; a window never grows past this. */
const MAX_WINDOW_FRAMES = 512;

/** Wall-clock refresh period telemetry consumers get at a cadence. */
export function telemetryCadenceMs(settings: Pick<QualitySettings, 'telemetryCadenceSteps'>): number {
  return settings.telemetryCadenceSteps * DEMO_TICK_MS;
}

/**
 * The same cadence as a maximum refresh rate in hertz. The live telemetry
 * panel (#9) uses it as a ceiling on its own rate, so quality can only lower
 * how often the panel redraws.
 */
export function telemetryCadenceHz(settings: Pick<QualitySettings, 'telemetryCadenceSteps'>): number {
  return 1000 / telemetryCadenceMs(settings);
}

/**
 * Whether a telemetry/DOM consumer should refresh for `step` at a cadence.
 * Keyed on the simulation step, so every consumer samples the same steps and
 * the choice never depends on frame timing.
 */
export function shouldSampleTelemetry(step: bigint, cadenceSteps: number): boolean {
  if (!Number.isInteger(cadenceSteps) || cadenceSteps < 1) {
    throw new RangeError('telemetry cadence must be a positive integer');
  }
  return step % BigInt(cadenceSteps) === 0n;
}

/** Device pixel ratio the renderer should use at a quality level. */
export function cappedPixelRatio(devicePixelRatio: number, settings: Pick<QualitySettings, 'maxPixelRatio'>): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(ratio, settings.maxPixelRatio);
}

export interface AdaptiveQualityOptions {
  initialLevel?: number;
  /** Highest level index the controller may reach (default: the last rung). */
  maxLevel?: number;
  pressureIntervalMs?: number;
  reliefIntervalMs?: number;
  frameWorkBudgetMs?: number;
  windowMs?: number;
  downshiftWindows?: number;
  upshiftWindows?: number;
}

export interface AdaptiveQualityStats {
  level: number;
  name: QualityLevelName;
  /** A level pinned through `force`, or `null` while adapting. */
  pinned: number | null;
  windows: number;
  downshifts: number;
  upshifts: number;
  /** Relieved windows currently required to step up (grows with flapping). */
  upshiftWindowsRequired: number;
  /** Summary of the most recently judged window, or `null` before one. */
  lastWindow: {
    frames: number;
    drawnFrames: number;
    p90IntervalMs: number;
    meanWorkMs: number;
    verdict: 'pressure' | 'relief' | 'steady';
  } | null;
}

/** Read side, safe to hand to telemetry and homepage consumers. */
export interface AdaptiveQualityReader {
  current: () => QualitySettings;
  subscribe: (listener: (settings: QualitySettings) => void) => () => void;
  stats: () => AdaptiveQualityStats;
}

export interface AdaptiveQualityController extends AdaptiveQualityReader {
  /**
   * Report one animation-frame callback: `intervalMs` since the previous
   * callback, `workMs` spent drawing, and whether the frame was drawn at all
   * (`false` when the frame-interval cap skipped it). `drawn` defaults to
   * `workMs > 0`; pass it explicitly, because a coarse clock can time a real
   * draw at 0 ms. Returns `true` when the level changed.
   */
  recordFrame: (intervalMs: number, workMs: number, drawn?: boolean) => boolean;
  /** Discard the open window (after pause, resume, resize, or a level change). */
  resetWindow: () => void;
  /** Pin a level for inspection/benchmarks; `null` resumes adapting. */
  force: (level: number | null) => void;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!(resolved > 0) || !Number.isFinite(resolved)) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return resolved;
}

function count(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function percentile(sorted: Float64Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export function createAdaptiveQuality(options: AdaptiveQualityOptions = {}): AdaptiveQualityController {
  const maxLevel = options.maxLevel ?? QUALITY_LADDER.length - 1;
  if (!Number.isInteger(maxLevel) || maxLevel < 0 || maxLevel >= QUALITY_LADDER.length) {
    throw new RangeError('maxLevel must index the quality ladder');
  }
  const initialLevel = options.initialLevel ?? 0;
  if (!Number.isInteger(initialLevel) || initialLevel < 0 || initialLevel > maxLevel) {
    throw new RangeError('initialLevel must be between 0 and maxLevel');
  }
  const pressureIntervalMs = positive(options.pressureIntervalMs, DEFAULT_PRESSURE_INTERVAL_MS, 'pressureIntervalMs');
  const reliefIntervalMs = positive(options.reliefIntervalMs, DEFAULT_RELIEF_INTERVAL_MS, 'reliefIntervalMs');
  if (reliefIntervalMs >= pressureIntervalMs) {
    throw new RangeError('reliefIntervalMs must be below pressureIntervalMs (hysteresis)');
  }
  const frameWorkBudgetMs = positive(options.frameWorkBudgetMs, DEFAULT_FRAME_WORK_BUDGET_MS, 'frameWorkBudgetMs');
  const windowMs = positive(options.windowMs, DEFAULT_WINDOW_MS, 'windowMs');
  const downshiftWindows = count(options.downshiftWindows, DEFAULT_DOWNSHIFT_WINDOWS, 'downshiftWindows');
  const baseUpshiftWindows = count(options.upshiftWindows, DEFAULT_UPSHIFT_WINDOWS, 'upshiftWindows');

  const listeners = new Set<(settings: QualitySettings) => void>();
  // Fixed-size window storage: no per-frame allocation, never unbounded.
  const intervals = new Float64Array(MAX_WINDOW_FRAMES);
  let frames = 0;
  let windowSpan = 0;
  let workTotal = 0;
  let drawnFrames = 0;

  let level = initialLevel;
  let pinned: number | null = null;
  let pressureStreak = 0;
  let reliefStreak = 0;
  let upshiftWindowsRequired = baseUpshiftWindows;
  let windowsSinceUpshift = Number.POSITIVE_INFINITY;
  const totals = { windows: 0, downshifts: 0, upshifts: 0 };
  let lastWindow: AdaptiveQualityStats['lastWindow'] = null;

  const resetWindow = () => {
    frames = 0;
    windowSpan = 0;
    workTotal = 0;
    drawnFrames = 0;
  };

  const emit = () => {
    const settings = QUALITY_LADDER[pinned ?? level];
    for (const listener of [...listeners]) {
      listener(settings);
    }
  };

  const setLevel = (next: number) => {
    if (next === level) {
      return false;
    }
    level = next;
    pressureStreak = 0;
    reliefStreak = 0;
    resetWindow();
    if (pinned === null) {
      emit();
    }
    return true;
  };

  const judgeWindow = (): boolean => {
    const sorted = intervals.slice(0, frames).sort();
    const p90IntervalMs = percentile(sorted, 0.9);
    const meanWorkMs = drawnFrames > 0 ? workTotal / drawnFrames : 0;
    const pressured = p90IntervalMs > pressureIntervalMs || meanWorkMs > frameWorkBudgetMs;
    const relieved = p90IntervalMs < reliefIntervalMs && meanWorkMs < frameWorkBudgetMs / 2;
    const verdict = pressured ? 'pressure' : relieved ? 'relief' : 'steady';
    lastWindow = { frames, drawnFrames, p90IntervalMs, meanWorkMs, verdict };
    totals.windows += 1;
    windowsSinceUpshift += 1;
    resetWindow();

    if (pinned !== null) {
      return false;
    }
    pressureStreak = pressured ? pressureStreak + 1 : 0;
    reliefStreak = relieved ? reliefStreak + 1 : 0;

    if (pressureStreak >= downshiftWindows && level < maxLevel) {
      // Flap guard: falling back soon after an upshift makes the next
      // upshift wait longer.
      if (windowsSinceUpshift <= upshiftWindowsRequired) {
        upshiftWindowsRequired = Math.min(MAX_UPSHIFT_WINDOWS, upshiftWindowsRequired * 2);
      }
      totals.downshifts += 1;
      return setLevel(level + 1);
    }
    if (reliefStreak >= upshiftWindowsRequired && level > 0) {
      totals.upshifts += 1;
      windowsSinceUpshift = 0;
      return setLevel(level - 1);
    }
    return false;
  };

  return {
    current: () => QUALITY_LADDER[pinned ?? level],
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    recordFrame(intervalMs, workMs, drawn = workMs > 0) {
      if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > MAX_FRAME_INTERVAL_MS) {
        // A stall, a resume after a pause, or the first frame: not a sample.
        resetWindow();
        return false;
      }
      if (frames < MAX_WINDOW_FRAMES) {
        intervals[frames] = intervalMs;
        frames += 1;
      }
      windowSpan += intervalMs;
      if (drawn) {
        // A draw the clock rounded to 0 ms still counts toward the mean.
        workTotal += Number.isFinite(workMs) && workMs > 0 ? workMs : 0;
        drawnFrames += 1;
      }
      if (windowSpan >= windowMs && frames >= MIN_WINDOW_FRAMES) {
        return judgeWindow();
      }
      return false;
    },
    resetWindow,
    force(next) {
      if (next !== null && (!Number.isInteger(next) || next < 0 || next >= QUALITY_LADDER.length)) {
        throw new RangeError('forced level must index the quality ladder');
      }
      const before = QUALITY_LADDER[pinned ?? level];
      pinned = next;
      pressureStreak = 0;
      reliefStreak = 0;
      resetWindow();
      if (QUALITY_LADDER[pinned ?? level] !== before) {
        emit();
      }
    },
    stats() {
      const settings = QUALITY_LADDER[pinned ?? level];
      return {
        level: settings.level,
        name: settings.name,
        pinned,
        windows: totals.windows,
        downshifts: totals.downshifts,
        upshifts: totals.upshifts,
        upshiftWindowsRequired,
        lastWindow,
      };
    },
  };
}

/**
 * Track `devicePixelRatio` changes (zoom, moving between displays) with
 * exactly one live media-query listener. The previous query's listener is
 * removed before a new one is added, so repeated changes cannot accumulate
 * listeners. Returns a function that removes the last listener.
 */
export function watchDevicePixelRatio(
  host: {
    devicePixelRatio?: number;
    matchMedia?: (query: string) => Pick<MediaQueryList, 'addEventListener' | 'removeEventListener'>;
  },
  onChange: () => void,
): () => void {
  let query: Pick<MediaQueryList, 'addEventListener' | 'removeEventListener'> | null = null;
  let stopped = false;
  const listen = () => {
    query?.removeEventListener('change', handle);
    query = null;
    if (stopped || typeof host.matchMedia !== 'function') {
      return;
    }
    query = host.matchMedia(`(resolution: ${host.devicePixelRatio || 1}dppx)`);
    query.addEventListener('change', handle);
  };
  function handle() {
    listen();
    onChange();
  }
  listen();
  return () => {
    stopped = true;
    query?.removeEventListener('change', handle);
    query = null;
  };
}
