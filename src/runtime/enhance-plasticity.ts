import { executionOriginData, executionOriginLabel } from '../native-evidence/view';
import { createFlushScheduler, type FlushScheduler, type SpikeRaster } from './demo-telemetry';
import {
  MODULATOR_NAMES,
  PLASTICITY_REDUCED_MOTION_RUN_HZ,
  PLASTICITY_RUN_HZ,
  PLASTICITY_WASM_MODULE_URL,
  PlasticityLabUnavailableError,
  REWARD_EVENT_LABELS,
  STIMULUS_LABELS,
  createModulatorHistory,
  createPlasticityRaster,
  createPlasticitySession,
  createRewardInputQueue,
  decodeEmbeddedGolden,
  formatModulator,
  formatSignedDelta,
  formatWeight,
  formatWeightChangeSummary,
  isStimulusName,
  largestWeightChange,
  plasticityErrorCode,
  recordPlasticitySpikes,
  replayGolden,
  stepWithRewardInput,
  type ModulatorHistory,
  type PlasticityGolden,
  type PlasticityProbeView,
  type PlasticitySession,
  type PlasticityStepView,
  type PlasticityWasmModule,
  type StimulusName,
} from './plasticity-lab';

/**
 * DOM half of the reward-modulated learning lab (`/labs/plasticity/`). The
 * static page is complete on its own; this binds the controls to a Rust/WASM
 * session and writes what the session returns. It never computes a learning
 * value. Rendering is throttled through the telemetry flush scheduler, the
 * run loop pauses when the tab is hidden or the lab is off-screen, and
 * `prefers-reduced-motion` caps the run cadence.
 */

export const PLASTICITY_STATIC_STATUS =
  'The live lab needs JavaScript and WebAssembly. Without them, the scripted session below is the complete record: it is the same Rust code’s output, rendered at build time.';
export const PLASTICITY_LOADING_STATUS = 'Loading the labs Rust/WASM package…';
export const PLASTICITY_UNAVAILABLE_STATUS =
  'The live lab is unavailable here. The scripted session below stays available: it was rendered from the committed golden at build time.';
export const PLASTICITY_READY_STATUS =
  'Live in Rust/WASM. Pick a pattern, step or run it, then reward or penalize. “Run scripted session” replays the golden below and checks every value.';

export type PlasticityLabState = 'static' | 'loading' | 'ready' | 'unavailable';

export interface BoundPlasticityLab {
  /** Settles once the lab is live or has fallen back to static. */
  ready: Promise<void>;
  dispose: () => void;
}

export interface BindPlasticityLabOptions {
  loadModule?: () => Promise<PlasticityWasmModule>;
  initModule?: (module: PlasticityWasmModule) => Promise<unknown>;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`plasticity lab is missing ${selector}`);
  }
  return element;
}

/** Write only on change, so an idle render costs no layout. */
function setText(element: Element, text: string): void {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

interface Palette {
  background: string;
  input: string;
  neuron: string;
  rule: string;
  dopamine: string;
  norepinephrine: string;
}

function readPalette(): Palette {
  const style = globalThis.getComputedStyle?.(document.documentElement);
  const token = (name: string, fallback: string) => style?.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--paper', '#f1f0e9'),
    input: token('--muted', '#62635c'),
    neuron: token('--signal', '#a94422'),
    rule: token('--line', '#c5c4b9'),
    dopamine: token('--signal', '#a94422'),
    norepinephrine: token('--ink', '#171816'),
  };
}

/** Size a canvas to its CSS box at up to 2× device pixels; null when hidden. */
function prepareCanvas(canvas: HTMLCanvasElement): { context: CanvasRenderingContext2D; width: number; height: number } | null {
  const context = canvas.getContext('2d');
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!context || !(width > 0 && height > 0)) return null;
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function drawRaster(canvas: HTMLCanvasElement, raster: SpikeRaster, channels: number, palette: Palette): void {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { context, width, height } = prepared;
  context.fillStyle = palette.background;
  context.fillRect(0, 0, width, height);
  const rows = raster.neuronCount();
  if (rows === 0) return;
  const rowHeight = height / rows;
  const columnWidth = width / raster.capacity;
  const firstColumn = raster.capacity - raster.size();
  context.fillStyle = palette.rule;
  context.fillRect(0, channels * rowHeight - 0.5, width, 1);
  raster.forEachSpike((column, row) => {
    context.fillStyle = row < channels ? palette.input : palette.neuron;
    context.fillRect((firstColumn + column) * columnWidth, row * rowHeight + 2, Math.max(1, columnWidth - 1), Math.max(1, rowHeight - 4));
  });
}

function drawModulatorStrip(canvas: HTMLCanvasElement, history: ModulatorHistory, palette: Palette): void {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { context, width, height } = prepared;
  context.fillStyle = palette.background;
  context.fillRect(0, 0, width, height);
  const lane = (height - 1) / 2;
  context.fillStyle = palette.rule;
  context.fillRect(0, lane, width, 1);
  const columnWidth = width / history.capacity;
  const firstColumn = history.capacity - history.size();
  history.forEach((row, column) => {
    const x = (firstColumn + column) * columnWidth;
    const barWidth = Math.max(1, columnWidth - 1);
    const dopamine = Math.max(0, Math.min(1, row.modulators[0]));
    const norepinephrine = Math.max(0, Math.min(1, row.modulators[3]));
    if (dopamine > 0) {
      context.fillStyle = palette.dopamine;
      context.fillRect(x, lane - dopamine * (lane - 2), barWidth, dopamine * (lane - 2));
    }
    if (norepinephrine > 0) {
      context.fillStyle = palette.norepinephrine;
      context.fillRect(x, lane + 1, barWidth, norepinephrine * (lane - 2));
    }
  });
}

function probeRows(root: ParentNode): HTMLTableRowElement[] {
  return Array.from(root.querySelectorAll<HTMLTableRowElement>('[data-plasticity-probe]'));
}

/**
 * Progressive enhancement for one `[data-plasticity-lab]` island. Any
 * failure leaves the static page as it was and reports `unavailable`.
 */
export function bindPlasticityLab(root: HTMLElement, options: BindPlasticityLabOptions = {}): BoundPlasticityLab {
  const status = required<HTMLElement>(root, '[data-plasticity-status]');
  const origin = required<HTMLElement>(root, '[data-demo-origin]');
  const controls = required<HTMLElement>(root, '[data-plasticity-controls]');
  const live = required<HTMLElement>(root, '[data-plasticity-live]');
  const goldenSource = required<HTMLScriptElement>(root, '[data-plasticity-golden-source]');
  const runButton = required<HTMLButtonElement>(root, '[data-plasticity-action="run"]');
  const rasterCanvas = required<HTMLCanvasElement>(root, 'canvas[data-plasticity-raster]');
  const stripCanvas = required<HTMLCanvasElement>(root, 'canvas[data-plasticity-modulator-strip]');
  const eventLog = required<HTMLOListElement>(root, '[data-plasticity-event-log]');
  const eventEmpty = required<HTMLElement>(root, '[data-plasticity-event-empty]');
  const field = (name: string) => required<HTMLElement>(root, `[data-plasticity-field="${name}"]`);
  const fields = {
    lastStep: field('last-step'),
    lastEvent: field('last-event'),
    observation: field('observation'),
    rasterSummary: field('raster-summary'),
    weightChange: field('weight-change'),
    probeCaption: field('probe-caption'),
    goldenCheck: field('golden-check'),
    queued: field('queued'),
  };
  const modulatorItems = MODULATOR_NAMES.map((name) => {
    const item = required<HTMLElement>(root, `[data-modulator="${name}"]`);
    return { item, bar: required<HTMLElement>(item, '[data-modulator-bar]'), value: required<HTMLElement>(item, '[data-modulator-value]') };
  });
  const neuronRows = Array.from(root.querySelectorAll<HTMLTableRowElement>('[data-plasticity-neuron]'));
  const weightRows = Array.from(root.querySelectorAll<HTMLTableRowElement>('[data-plasticity-weights]'));
  const traceRows = Array.from(root.querySelectorAll<HTMLTableRowElement>('[data-plasticity-traces]'));
  const actionButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-plasticity-action]'));

  const motionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const reducedMotion = () => Boolean(motionQuery?.matches);
  const runHz = () => (reducedMotion() ? PLASTICITY_REDUCED_MOTION_RUN_HZ : PLASTICITY_RUN_HZ);

  let module: PlasticityWasmModule | null = null;
  let golden: PlasticityGolden | null = null;
  let session: PlasticitySession | null = null;
  let initialWeights: Float32Array | null = null;
  let lastStep: PlasticityStepView | null = null;
  let probe: { view: PlasticityProbeView; atStep: bigint } | null = null;
  let history = createModulatorHistory();
  let raster = createPlasticityRaster();
  let palette: Palette | null = null;
  let disposed = false;
  let running = false;
  let inViewport = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const rewardInput = createRewardInputQueue();
  let observer: IntersectionObserver | null = null;

  const setState = (state: PlasticityLabState, message: string, reason?: string) => {
    root.dataset.plasticityState = state;
    if (reason) root.dataset.plasticityReason = reason;
    else delete root.dataset.plasticityReason;
    setText(status, message);
    const originKind = state === 'ready' ? 'live-wasm' : 'unavailable-wasm';
    setText(origin, executionOriginLabel(originKind));
    origin.dataset.origin = executionOriginData(originKind);
  };

  const selectedStimulus = (): StimulusName => {
    const checked = root.querySelector<HTMLInputElement>('input[name="plasticity-stimulus"]:checked');
    return checked && isStimulusName(checked.value) ? checked.value : 'quiet';
  };

  const renderQueued = () => {
    const queued = rewardInput.pending();
    root.dataset.plasticityQueued = queued;
    setText(fields.queued, queued === 'none' ? 'nothing queued' : `${REWARD_EVENT_LABELS[queued]}, applied to the next step`);
  };

  const renderReward = () => {
    renderQueued();
    const latest = history.latest();
    setText(fields.lastStep, latest ? `${latest.step} (episode ${latest.episode}, ${STIMULUS_LABELS[latest.stimulus]})` : '—');
    setText(fields.lastEvent, latest ? (latest.event === 'none' ? 'none' : REWARD_EVENT_LABELS[latest.event]) : '—');
    setText(fields.observation, latest ? `objective ${formatModulator(latest.objective)}, stress ${formatModulator(latest.stress)}` : '—');
    root.dataset.plasticityLastEvent = latest?.event ?? '';
    const vector = session?.state().modulators ?? null;
    modulatorItems.forEach(({ item, bar, value }, index) => {
      const level = vector ? vector[index] : 0;
      const transform = `scaleX(${Math.max(0, Math.min(1, level))})`;
      if (bar.style.transform !== transform) bar.style.transform = transform;
      setText(value, vector ? formatModulator(level) : '—');
      item.dataset.level = vector ? String(level) : '';
    });
    const events = history.events();
    eventLog.replaceChildren(
      ...events.map((row) => {
        const entry = document.createElement('li');
        entry.dataset.event = row.event;
        entry.textContent = `Step ${row.step}: ${REWARD_EVENT_LABELS[row.event]} → dopamine ${formatModulator(row.modulators[0])}, norepinephrine ${formatModulator(row.modulators[3])}`;
        return entry;
      }),
    );
    eventEmpty.hidden = events.length > 0;
    if (palette) drawModulatorStrip(stripCanvas, history, palette);
  };

  const renderNetwork = () => {
    if (!session) return;
    const state = session.state();
    const channels = session.channels;
    neuronRows.forEach((row, neuron) => {
      const spiked = lastStep ? Array.from(lastStep.outputSpikes).includes(neuron) : null;
      setText(required(row, '[data-cell="spiked"]'), spiked === null ? '—' : spiked ? 'yes' : 'no');
      setText(required(row, '[data-cell="membrane"]'), formatWeight(state.membranePotentials[neuron]));
      setText(required(row, '[data-cell="threshold"]'), formatWeight(state.thresholds[neuron]));
    });
    weightRows.forEach((row, neuron) => {
      for (let channel = 0; channel < channels; channel += 1) {
        const index = neuron * channels + channel;
        const weight = state.weights[index];
        const start = initialWeights ? initialWeights[index] : weight;
        setText(required(row, `[data-channel="${channel}"]`), `${formatWeight(weight)} (${formatSignedDelta(weight - start)})`);
      }
    });
    traceRows.forEach((row, neuron) => {
      for (let channel = 0; channel < channels; channel += 1) {
        setText(required(row, `[data-channel="${channel}"]`), state.eligibility[neuron * channels + channel].toFixed(5));
      }
    });
    setText(
      fields.weightChange,
      lastStep ? `Step ${lastStep.step}: ${formatWeightChangeSummary(lastStep.weightChanges.length / 4, largestWeightChange(lastStep))}.` : 'No step yet.',
    );
    const totals = raster.totals();
    setText(fields.rasterSummary, raster.size() === 0 ? '' : `${totals.spikes} spikes in the last ${raster.size()} steps.`);
    if (palette) drawRaster(rasterCanvas, raster, channels, palette);
  };

  const renderProbe = () => {
    for (const row of probeRows(root)) {
      const neuron = Number(row.dataset.plasticityProbe);
      setText(required(row, '[data-cell="a"]'), probe ? String(probe.view.patternA[neuron]) : '—');
      setText(required(row, '[data-cell="b"]'), probe ? String(probe.view.patternB[neuron]) : '—');
    }
    setText(fields.probeCaption, probe ? `Frozen probe after step ${probe.atStep}` : 'Not probed yet');
  };

  const render = () => {
    if (!session || disposed) return;
    root.dataset.plasticitySteps = String(session.state().completedSteps);
    renderReward();
    renderNetwork();
    renderProbe();
  };

  let scheduler: FlushScheduler = createFlushScheduler(render, { cadenceHz: runHz() });

  const stopTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const setRunning = (next: boolean) => {
    running = next;
    runButton.setAttribute('aria-pressed', String(next));
    setText(runButton, next ? 'Pause' : 'Run');
    stopTimer();
    if (next) schedule();
  };

  const canTick = () => running && !disposed && session !== null && !document.hidden && inViewport;

  function schedule() {
    stopTimer();
    if (!canTick()) return;
    timer = setTimeout(() => {
      timer = null;
      if (!canTick()) return;
      if (stepOnce(selectedStimulus())) {
        scheduler.request();
        schedule();
      }
    }, 1000 / runHz());
  }

  /**
   * One step through Rust/WASM with the queued reward input, which it
   * consumes; false (and static fallback) on failure. Run and Step both
   * advance only through here.
   */
  function stepOnce(stimulus: StimulusName): boolean {
    if (!session) return false;
    try {
      const view = stepWithRewardInput(session, stimulus, rewardInput);
      lastStep = view;
      history.record(view);
      recordPlasticitySpikes(raster, view, session.channels, session.neurons);
      return true;
    } catch (error) {
      fallBack(error);
      return false;
    }
  }

  const freshSession = () => {
    if (!module || !golden) throw new PlasticityLabUnavailableError('not-ready', 'The lab is not ready.');
    session?.dispose();
    session = createPlasticitySession(module, BigInt(golden.seed));
    initialWeights = session.state().weights;
    lastStep = null;
    probe = null;
    rewardInput.clear();
    history = createModulatorHistory();
    raster = createPlasticityRaster();
  };

  function fallBack(error: unknown) {
    setRunning(false);
    rewardInput.clear();
    scheduler.cancel();
    session?.dispose();
    session = null;
    controls.hidden = true;
    live.hidden = true;
    const reason = error instanceof PlasticityLabUnavailableError ? error.code : plasticityErrorCode(error);
    setState('unavailable', PLASTICITY_UNAVAILABLE_STATUS, reason);
  }

  const runScripted = () => {
    if (!golden) return;
    setRunning(false);
    freshSession();
    if (!session) return;
    const replay = replayGolden(session, golden, (view) => {
      lastStep = view;
      history.record(view);
      recordPlasticitySpikes(raster, view, session?.channels ?? 0, session?.neurons ?? 0);
    });
    probe = replay.probeAfter ? { view: replay.probeAfter, atStep: BigInt(replay.steps.length) } : null;
    if (replay.mismatch) {
      root.dataset.plasticityGolden = 'mismatch';
      const where = replay.mismatch.step === null ? '' : ` at step ${replay.mismatch.step}`;
      setText(fields.goldenCheck, `The replay differs from the committed golden${where} (${replay.mismatch.field}).`);
    } else {
      root.dataset.plasticityGolden = 'match';
      setText(
        fields.goldenCheck,
        `Scripted session replayed in Rust/WASM: all ${replay.steps.length} steps, the final weights, thresholds, traces, and both probes match the committed golden exactly.`,
      );
    }
  };

  const onAction = (event: Event) => {
    const action = (event.currentTarget as HTMLButtonElement | null)?.dataset.plasticityAction;
    if (!session || !action) return;
    try {
      switch (action) {
        case 'step':
          if (!stepOnce(selectedStimulus())) return;
          break;
        case 'run':
          setRunning(!running);
          return;
        case 'reward':
        case 'penalty':
          // Queued for exactly the next step: the next Run tick while
          // running, or this click's own step while paused.
          rewardInput.queue(action);
          if (running) {
            renderQueued();
            return;
          }
          if (!stepOnce(selectedStimulus())) return;
          break;
        case 'new-episode':
          // The step a queued input was meant for belongs to the old episode.
          rewardInput.clear();
          session.newEpisode();
          break;
        case 'reset':
          setRunning(false);
          freshSession();
          root.dataset.plasticityGolden = '';
          setText(fields.goldenCheck, '');
          break;
        case 'scripted':
          runScripted();
          break;
        case 'probe':
          probe = { view: session.probe(), atStep: session.state().completedSteps };
          break;
        default:
          return;
      }
      scheduler.flushNow();
    } catch (error) {
      fallBack(error);
    }
  };

  const onVisibility = () => schedule();
  const onMotionChange = () => {
    scheduler.cancel();
    scheduler = createFlushScheduler(render, { cadenceHz: runHz() });
    schedule();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopTimer();
    scheduler.cancel();
    observer?.disconnect();
    for (const button of actionButtons) button.removeEventListener('click', onAction);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('astro:before-swap', dispose);
    motionQuery?.removeEventListener?.('change', onMotionChange);
    window.removeEventListener('pagehide', onPageHide);
    session?.dispose();
    session = null;
  };

  function onPageHide(event: Event) {
    if ('persisted' in event && event.persisted) {
      setRunning(false);
      return;
    }
    dispose();
  }

  document.addEventListener('astro:before-swap', dispose);
  window.addEventListener('pagehide', onPageHide);

  setState('loading', PLASTICITY_LOADING_STATUS);

  const ready = (async () => {
    try {
      if (typeof WebAssembly === 'undefined') {
        throw new PlasticityLabUnavailableError('no-wasm', 'WebAssembly is unavailable in this browser.');
      }
      golden = decodeEmbeddedGolden(goldenSource.textContent);
      let loaded: PlasticityWasmModule;
      try {
        loaded = await (options.loadModule ?? (() => import(/* @vite-ignore */ PLASTICITY_WASM_MODULE_URL) as Promise<PlasticityWasmModule>))();
        await (options.initModule ?? ((candidate) => candidate.default()))(loaded);
      } catch (error) {
        throw new PlasticityLabUnavailableError('wasm-init-failed', error instanceof Error ? error.message : String(error));
      }
      if (disposed) return;
      module = loaded;
      freshSession();
      palette = readPalette();
      for (const button of actionButtons) button.addEventListener('click', onAction);
      document.addEventListener('visibilitychange', onVisibility);
      motionQuery?.addEventListener?.('change', onMotionChange);
      if (typeof IntersectionObserver === 'function') {
        observer = new IntersectionObserver((entries) => {
          inViewport = entries.some((entry) => entry.isIntersecting);
          schedule();
        });
        observer.observe(root);
      }
      controls.hidden = false;
      live.hidden = false;
      setState('ready', PLASTICITY_READY_STATUS);
      scheduler.flushNow();
    } catch (error) {
      if (!disposed) fallBack(error);
    }
  })();

  return { ready, dispose };
}

export function enhancePlasticityLabs(scope: ParentNode = document): BoundPlasticityLab[] {
  const bound: BoundPlasticityLab[] = [];
  for (const root of scope.querySelectorAll<HTMLElement>('[data-plasticity-lab]')) {
    try {
      bound.push(bindPlasticityLab(root));
    } catch {
      // A malformed island keeps its static content.
    }
  }
  return bound;
}
