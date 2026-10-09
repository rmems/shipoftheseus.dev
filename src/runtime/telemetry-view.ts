import { executionOriginData, executionOriginLabel } from '../native-evidence/view';
import {
  createTelemetryController,
  telemetryDigestLabel,
  type NeuronInspection,
  type SynapseInspection,
  type TelemetryClock,
  type TelemetryController,
  type TelemetryViewModel,
} from './demo-telemetry';
import { ENCODER_FEATURE_COUNT } from './neuromorphic-adapter';
import { liveTelemetrySources, registerDemoTelemetry } from './telemetry-entry';

/**
 * DOM half of the demo telemetry panel (`src/components/DemoTelemetry.astro`).
 * It only writes what the controller in `demo-telemetry.ts` hands it, during
 * throttled flushes; it never reads simulation state on its own. Loaded on
 * first open by `bindDemoTelemetryPanel` in `telemetry-entry.ts`.
 */

export interface DemoTelemetryOptions {
  /** Initial refresh rate in hertz (default 4). */
  cadenceHz?: number;
  /** Steps the raster keeps (default 120). */
  rasterSteps?: number;
  clock?: TelemetryClock;
}

let panelCount = 0;

interface RasterPalette {
  background: string;
  spike: string;
  highlight: string;
  lane: string;
  rule: string;
}

function readPalette(): RasterPalette {
  const style = globalThis.getComputedStyle?.(document.documentElement);
  const token = (name: string, fallback: string) => style?.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--paper', '#f1f0e9'),
    spike: token('--signal', '#a94422'),
    highlight: token('--signal-soft', '#e8cabc'),
    lane: token('--muted', '#62635c'),
    rule: token('--line', '#c5c4b9'),
  };
}

interface PanelElements {
  panel: HTMLDetailsElement;
  origin: HTMLElement;
  status: HTMLElement;
  live: HTMLElement;
  provenance: HTMLElement;
  canvas: HTMLCanvasElement;
  rasterSummary: HTMLElement;
  propagation: HTMLElement;
  neurons: HTMLFieldSetElement;
  neuronTitle: HTMLElement;
  membrane: HTMLElement;
  spiked: HTMLElement;
  recent: HTMLElement;
  outgoing: HTMLTableSectionElement;
  incoming: HTMLTableSectionElement;
  source: HTMLElement;
  mode: HTMLElement;
  encoded: HTMLElement;
  encodedTotal: HTMLElement;
  features: HTMLElement;
  featuresMissing: HTMLElement;
  featureBars: HTMLElement[];
  featureValues: HTMLElement[];
}

function collectElements(panel: HTMLDetailsElement): PanelElements | null {
  const one = <T extends Element>(selector: string) => panel.querySelector<T>(selector);
  const field = (name: string) => one<HTMLElement>(`[data-telemetry-field="${name}"]`);
  const elements = {
    panel,
    origin: one<HTMLElement>('[data-telemetry-origin]'),
    status: one<HTMLElement>('[data-telemetry-status]'),
    live: one<HTMLElement>('[data-telemetry-live]'),
    provenance: one<HTMLElement>('[data-telemetry-provenance]'),
    canvas: one<HTMLCanvasElement>('canvas[data-telemetry-raster]'),
    rasterSummary: one<HTMLElement>('[data-telemetry-raster-summary]'),
    propagation: one<HTMLElement>('[data-telemetry-propagation]'),
    neurons: one<HTMLFieldSetElement>('fieldset[data-telemetry-neurons]'),
    neuronTitle: field('neuron'),
    membrane: field('membrane'),
    spiked: field('spiked'),
    recent: field('recent'),
    outgoing: one<HTMLTableSectionElement>('[data-telemetry-outgoing] tbody'),
    incoming: one<HTMLTableSectionElement>('[data-telemetry-incoming] tbody'),
    source: field('source'),
    mode: field('encoder-mode'),
    encoded: field('encoded'),
    encodedTotal: field('encoded-total'),
    features: one<HTMLElement>('[data-telemetry-features]'),
    featuresMissing: one<HTMLElement>('[data-telemetry-features-missing]'),
    featureBars: Array.from(panel.querySelectorAll<HTMLElement>('[data-feature-bar]')),
    featureValues: Array.from(panel.querySelectorAll<HTMLElement>('[data-feature-value]')),
  };
  for (const value of Object.values(elements)) {
    if (value === null) {
      return null;
    }
  }
  if (elements.featureBars.length !== ENCODER_FEATURE_COUNT || elements.featureValues.length !== ENCODER_FEATURE_COUNT) {
    return null;
  }
  return elements as PanelElements;
}

/** Write only on change, so an idle flush costs no layout or mutation. */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

function setData(element: HTMLElement, key: string, value: string): void {
  if (element.dataset[key] !== value) {
    element.dataset[key] = value;
  }
}

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function formatSigned(value: number, digits: number): string {
  const negative = value < 0 || Object.is(value, -0);
  return `${negative ? '−' : '+'}${Math.abs(value).toFixed(digits)}`;
}

function formatDelay(synapse: SynapseInspection): string {
  return `${synapse.delaySteps} ${synapse.delaySteps === 1 ? 'step' : 'steps'} · ${synapse.delayMs} ms`;
}

function spikedText(inspection: NeuronInspection): string {
  if (inspection.spikedAtStep === null) {
    return `Not sampled at step ${integer.format(inspection.step)}`;
  }
  return inspection.spikedAtStep
    ? `Yes, at step ${integer.format(inspection.step)}`
    : `No spike at step ${integer.format(inspection.step)}`;
}

function recentText(inspection: NeuronInspection, windowSteps: number): string {
  if (inspection.recentSpikeSteps.length === 0) {
    return `None in the last ${windowSteps} sampled steps`;
  }
  return inspection.recentSpikeSteps.map((step) => integer.format(step)).join(', ');
}

const SOURCE_TEXT = {
  pointer: 'pointer · your input over the demo',
  scripted: 'scripted · the deterministic path (no recent pointer input)',
} as const;

function synapseRow(synapse: SynapseInspection, peerPrefix: string): HTMLTableRowElement {
  const row = document.createElement('tr');
  const edge = document.createElement('th');
  edge.scope = 'row';
  edge.textContent = `#${synapse.edgeIndex}`;
  row.append(edge);
  for (const text of [
    `${peerPrefix}${synapse.peer}`,
    formatSigned(synapse.weight, 4),
    formatDelay(synapse),
    synapse.polarity,
  ]) {
    const cell = document.createElement('td');
    cell.textContent = text;
    row.append(cell);
  }
  row.dataset.polarity = synapse.polarity;
  return row;
}

function drawRaster(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  model: TelemetryViewModel,
  palette: RasterPalette,
): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!(width > 0 && height > 0)) {
    return;
  }
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = palette.background;
  context.fillRect(0, 0, width, height);

  const { raster } = model;
  const neurons = raster.neuronCount();
  if (neurons === 0 || raster.size() === 0) {
    return;
  }
  const gap = 4;
  const laneHeight = Math.max(10, Math.round(height * 0.16));
  const rowHeight = (height - laneHeight - gap) / neurons;
  const columnWidth = width / raster.capacity;
  // Newest step on the right edge; a partly filled ring leaves the left empty.
  const firstColumn = raster.capacity - raster.size();
  const laneTop = height - laneHeight;

  if (model.selectedNeuron !== null && model.selectedNeuron < neurons) {
    context.fillStyle = palette.highlight;
    context.fillRect(0, model.selectedNeuron * rowHeight, width, rowHeight);
  }
  context.fillStyle = palette.rule;
  context.fillRect(0, laneTop - gap / 2 - 0.5, width, 1);

  raster.forEachRow((column, _step, sampled, encodedSpikes) => {
    const x = (firstColumn + column) * columnWidth;
    if (!sampled) {
      context.fillStyle = palette.rule;
      context.fillRect(x, 0, columnWidth, laneTop - gap);
      return;
    }
    if (encodedSpikes > 0) {
      // Height is the share of the 16 encoder channels, with a visible floor.
      const bar = Math.max(3, laneHeight * Math.min(1, encodedSpikes / ENCODER_FEATURE_COUNT));
      context.fillStyle = palette.lane;
      context.fillRect(x, height - bar, Math.max(1, columnWidth - 0.5), bar);
    }
  });

  context.fillStyle = palette.spike;
  const inset = rowHeight > 4 ? 1 : 0;
  raster.forEachSpike((column, neuron) => {
    context.fillRect(
      (firstColumn + column) * columnWidth,
      neuron * rowHeight + inset,
      Math.max(1, columnWidth - 0.5),
      Math.max(1, rowHeight - 2 * inset),
    );
  });
}

/**
 * Bind the telemetry panel inside `island`, if the island has one. Returns
 * `null` when it does not (tests, other islands); the panel then keeps its
 * static explanation.
 */
export function bindDemoTelemetry(island: HTMLElement, options: DemoTelemetryOptions = {}): TelemetryController | null {
  const panel = island.querySelector?.<HTMLDetailsElement>('details[data-demo-telemetry]');
  if (!panel || typeof document === 'undefined') {
    return null;
  }
  const elements = collectElements(panel);
  if (!elements) {
    return null;
  }

  const context = elements.canvas.getContext('2d');
  const palette = readPalette();
  panelCount += 1;
  const groupName = `demo-telemetry-neuron-${panelCount}`;
  const motionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const chips = new Map<number, HTMLLabelElement>();
  let chipKey = '';
  let synapseKey = '';
  let controller: TelemetryController | null = null;

  const onNeuronChange = (event: Event) => {
    const input = event.target as HTMLInputElement | null;
    if (input && input.name === groupName) {
      controller?.select(Number(input.value));
    }
  };
  elements.neurons.addEventListener('change', onNeuronChange);

  const renderChips = (nodeIds: readonly number[]) => {
    const key = nodeIds.join(',');
    if (key === chipKey) {
      return;
    }
    chipKey = key;
    for (const chip of chips.values()) {
      chip.remove();
    }
    chips.clear();
    for (const id of nodeIds) {
      const label = document.createElement('label');
      label.className = 'demo-telemetry-chip';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = groupName;
      input.value = String(id);
      const text = document.createElement('span');
      text.textContent = String(id);
      label.append(input, text);
      elements.neurons.append(label);
      chips.set(id, label);
    }
  };

  const renderNeuron = (model: TelemetryViewModel) => {
    for (const [id, chip] of chips) {
      const input = chip.firstElementChild as HTMLInputElement;
      const checked = id === model.selectedNeuron;
      if (input.checked !== checked) input.checked = checked;
      const spiked = model.snapshot ? model.raster.spiked(model.snapshot.step, id) === true : false;
      setData(chip, 'spiked', String(spiked));
    }
    const inspection = model.neuron;
    if (!inspection) {
      setText(elements.neuronTitle, '—');
      setText(elements.membrane, '—');
      setText(elements.spiked, '—');
      setText(elements.recent, '—');
      elements.outgoing.replaceChildren();
      elements.incoming.replaceChildren();
      synapseKey = '';
      return;
    }
    setText(elements.neuronTitle, `NeuronId ${inspection.neuron}`);
    setText(elements.membrane, `${inspection.membranePotential.toFixed(4)} at step ${integer.format(inspection.step)}`);
    setText(elements.spiked, spikedText(inspection));
    setText(elements.recent, recentText(inspection, model.raster.size()));
    // The topology is fixed per digest, so the tables change only with the selection.
    const key = `${inspection.topologyDigest}:${inspection.neuron}`;
    if (key !== synapseKey) {
      synapseKey = key;
      elements.outgoing.replaceChildren(...inspection.outgoing.map((synapse) => synapseRow(synapse, '→ ')));
      elements.incoming.replaceChildren(...inspection.incoming.map((synapse) => synapseRow(synapse, '← ')));
    }
  };

  const renderEncoder = (model: TelemetryViewModel) => {
    const encoder = model.encoder;
    if (!encoder) {
      for (const element of [elements.source, elements.mode, elements.encoded, elements.encodedTotal]) {
        setText(element, '—');
      }
      elements.features.hidden = true;
      elements.featuresMissing.hidden = false;
      return;
    }
    setText(elements.source, encoder.inputSource ? SOURCE_TEXT[encoder.inputSource] : '—');
    setText(elements.mode, `${encoder.name} (mode ${encoder.mode})`);
    setText(
      elements.encoded,
      `${encoder.encodedSpikeCount} ${encoder.encodedSpikeCount === 1 ? 'spike' : 'spikes'} on ${encoder.encodedSpikeChannels} ${encoder.encodedSpikeChannels === 1 ? 'channel' : 'channels'}`,
    );
    setText(elements.encodedTotal, integer.format(encoder.encodedSpikeTotal));
    const features = encoder.features;
    elements.features.hidden = features === null;
    elements.featuresMissing.hidden = features !== null;
    if (features) {
      for (const feature of features) {
        const transform = `scaleX(${feature.value})`;
        const bar = elements.featureBars[feature.index];
        if (bar.style.transform !== transform) bar.style.transform = transform;
        setText(elements.featureValues[feature.index], feature.value.toFixed(3));
      }
    }
  };

  const render = (model: TelemetryViewModel) => {
    setData(panel, 'telemetryState', model.state);
    setData(panel, 'telemetryStep', model.snapshot ? model.snapshot.step.toString() : '');
    setText(elements.origin, executionOriginLabel(model.origin));
    setData(elements.origin, 'origin', executionOriginData(model.origin));
    setText(elements.status, model.status);
    const showData = model.snapshot !== null;
    if (elements.live.hidden === showData) {
      elements.live.hidden = !showData;
    }
    if (!showData || !model.snapshot) {
      return;
    }
    setText(
      elements.provenance,
      `neuromorphic-adapter contract ${model.snapshot.contractVersion} · topology ${telemetryDigestLabel(model.snapshot.topologyDigest)} · spike events: ${model.provenance ?? 'none'}`,
    );
    if (context) {
      drawRaster(elements.canvas, context, model, palette);
    }
    setText(elements.rasterSummary, model.rasterSummary);
    if (model.propagation) {
      setText(
        elements.propagation,
        `${model.propagation.inFlight} propagation ${model.propagation.inFlight === 1 ? 'event' : 'events'} in flight along synaptic-wiring edges (${integer.format(model.propagation.emitted)} mapped since the buffer started).`,
      );
    }
    renderChips(model.nodeIds);
    renderNeuron(model);
    renderEncoder(model);
  };

  const created = createTelemetryController({
    sources: liveTelemetrySources(island),
    panel: {
      isOpen: () => panel.open,
      onToggle(listener) {
        panel.addEventListener('toggle', listener);
        return () => panel.removeEventListener('toggle', listener);
      },
      demoMode: () => island.dataset.mode,
      onDemoModeChange(listener) {
        if (typeof MutationObserver !== 'function') {
          return () => {};
        }
        const observer = new MutationObserver(listener);
        observer.observe(island, { attributes: true, attributeFilter: ['data-mode'] });
        return () => observer.disconnect();
      },
      prefersReducedMotion: () => Boolean(motionQuery?.matches),
    },
    render,
    cadenceHz: options.cadenceHz,
    rasterSteps: options.rasterSteps,
    clock: options.clock,
  });
  controller = created;

  let unregister = () => {};
  const bound: TelemetryController = {
    ...created,
    dispose() {
      created.dispose();
      elements.neurons.removeEventListener('change', onNeuronChange);
      unregister();
    },
  };
  unregister = registerDemoTelemetry(island, bound);

  if (import.meta.env?.DEV) {
    (globalThis as { __neuromorphicTelemetryPanel?: Pick<TelemetryController, 'inspect' | 'setCadenceHz' | 'setEnabled'> }).__neuromorphicTelemetryPanel = {
      inspect: () => created.inspect(),
      setCadenceHz: (hz) => created.setCadenceHz(hz),
      setEnabled: (enabled) => created.setEnabled(enabled),
    };
  }

  return bound;
}
