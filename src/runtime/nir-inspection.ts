/**
 * NIR inspection projection types, static diagram layout, and the browser
 * bridge to the `WasmNirInspection` export of the neuromorphic adapter.
 *
 * `nir-rs` (inside Rust/WASM) owns NIR graph semantics. This module never
 * interprets operator parameters: it lays out the projection Rust produced and
 * displays the Rust-formatted values verbatim.
 */

/** The generated adapter package that also hosts the live demo runtime. */
export const NIR_WASM_MODULE_URL = '/wasm/neuromorphic-adapter/neuromorphic_adapter.js';
export const NIR_INSPECTION_FORMAT = 'shipoftheseus.nir-inspection';
export const NIR_INSPECTION_VERSION = 1;

export interface NirFieldView {
  dtype: string | null;
  kind: string;
  name: string;
  shape: number[];
  value_count: number;
  values: string[];
}

export interface NirNodeView {
  inputs: string[];
  layer: number;
  metadata: NirFieldView[];
  name: string;
  operator: string;
  outputs: string[];
  parameters: NirFieldView[];
  row: number;
}

export interface NirEdgeView {
  source: string;
  target: string;
}

export interface NirAssetProvenance {
  generator: string;
  id: string;
  origin: string;
  regenerate: string;
  revision: number;
  summary: string;
  title: string;
}

export interface NirInspectionProjection {
  asset: NirAssetProvenance;
  edges: NirEdgeView[];
  format: string;
  format_version: number;
  graph_metadata: NirFieldView[];
  layer_count: number;
  max_rows: number;
  nir_rs_version: string;
  nir_version: string | null;
  nodes: NirNodeView[];
}

/** Diagram geometry in SVG user units. Layers run top to bottom. */
export const NIR_DIAGRAM = {
  boxWidth: 220,
  boxHeight: 56,
  layerSpacing: 96,
  rowSpacing: 244,
  margin: 20,
  loopAllowance: 48,
} as const;

export interface NirDiagramNode {
  name: string;
  operator: string;
  summary: string;
  anchorId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NirDiagramEdge {
  source: string;
  target: string;
  path: string;
}

export interface NirDiagramLayout {
  width: number;
  height: number;
  nodes: NirDiagramNode[];
  edges: NirDiagramEdge[];
}

/** Stable fragment id for a node's static detail entry. */
export function nirNodeAnchorId(name: string): string {
  const slug = Array.from(name, (character) =>
    /[A-Za-z0-9_-]/.test(character) ? character : `-${character.codePointAt(0)?.toString(16)}-`,
  ).join('');
  return `nir-node-${slug}`;
}

export function formatNirShape(shape: readonly number[]): string {
  return shape.length === 0 ? 'scalar' : shape.join(' × ');
}

/** One-line description of a field as Rust reported it. */
export function nirFieldSummary(field: NirFieldView): string {
  switch (field.kind) {
    case 'tensor':
      return `${field.name} ${formatNirShape(field.shape)}`;
    case 'absent':
      return `${field.name} absent`;
    default:
      return `${field.name} ${field.values.join(' × ')}`;
  }
}

/** Rust-formatted values, noting when Rust truncated the preview. */
export function formatNirFieldValues(field: NirFieldView): string {
  if (field.kind === 'absent') {
    return 'absent';
  }
  const shown = field.values.join(', ');
  return field.values.length < field.value_count
    ? `${shown}, … (first ${field.values.length} of ${field.value_count})`
    : shown;
}

export function nirNodeSummary(node: NirNodeView): string {
  const first = node.parameters[0];
  return first ? `${node.operator} · ${nirFieldSummary(first)}` : node.operator;
}

/**
 * Deterministic layered layout from the Rust projection's `layer`/`row`.
 * Edges that do not point to a later layer (NIR allows cycles) loop around
 * the right-hand side instead of crossing boxes.
 */
export function layoutNirDiagram(projection: NirInspectionProjection): NirDiagramLayout {
  const { boxWidth, boxHeight, layerSpacing, rowSpacing, margin, loopAllowance } = NIR_DIAGRAM;
  const nodes = projection.nodes.map((node) => ({
    name: node.name,
    operator: node.operator,
    summary: nirNodeSummary(node),
    anchorId: nirNodeAnchorId(node.name),
    x: margin + node.row * rowSpacing,
    y: margin + node.layer * layerSpacing,
    width: boxWidth,
    height: boxHeight,
  }));
  const byName = new Map(nodes.map((node) => [node.name, node]));
  let loops = false;
  const edges = projection.edges.flatMap((edge) => {
    const source = byName.get(edge.source);
    const target = byName.get(edge.target);
    if (!source || !target) {
      return [];
    }
    if (target.y > source.y) {
      const sx = source.x + source.width / 2;
      const sy = source.y + source.height;
      const tx = target.x + target.width / 2;
      const ty = target.y;
      const bend = (ty - sy) / 2;
      return [{ ...edge, path: `M${sx} ${sy}C${sx} ${sy + bend} ${tx} ${ty - bend} ${tx} ${ty}` }];
    }
    loops = true;
    const sx = source.x + source.width;
    const sy = source.y + source.height / 2;
    const tx = target.x + target.width;
    const ty = target.y + target.height / 2;
    const reach = loopAllowance - 8;
    return [{ ...edge, path: `M${sx} ${sy}C${sx + reach} ${sy} ${tx + reach} ${ty} ${tx} ${ty}` }];
  });
  const columns = Math.max(projection.max_rows, 1);
  const layers = Math.max(projection.layer_count, 1);
  return {
    width: margin * 2 + (columns - 1) * rowSpacing + boxWidth + (loops ? loopAllowance : 0),
    height: margin * 2 + (layers - 1) * layerSpacing + boxHeight,
    nodes,
    edges,
  };
}

export interface NirWasmHandle {
  readonly node_count: number;
  readonly edge_count: number;
  readonly nir_rs_version: string;
  inspection_json(): string;
  node_json(name: string): string;
  free(): void;
}

export interface NirWasmModule {
  default: (input?: unknown) => Promise<unknown>;
  WasmNirInspection: { parse(envelopeJson: string): NirWasmHandle };
}

export class NirInspectionUnavailableError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NirInspectionUnavailableError';
    this.code = code;
  }
}

export interface NirInspectionSession {
  nirRsVersion: string;
  nodeCount: number;
  edgeCount: number;
  /** One node as parsed by `nir-rs` in Rust/WASM. */
  node(name: string): NirNodeView;
  dispose(): void;
}

export interface OpenNirInspectionOptions {
  loadModule: () => Promise<NirWasmModule>;
  /** Initializes the generated package; defaults to `module.default()`. */
  initModule?: (module: NirWasmModule) => Promise<unknown>;
  loadEnvelope: () => Promise<string>;
  /** Exact projection text the static page was rendered from. */
  staticProjection: string;
}

/**
 * Loads the adapter, parses the envelope with `nir-rs` in Rust/WASM, and
 * confirms the WASM projection is byte-identical to the one the static page
 * was built from before any interactive view is offered.
 */
export async function openNirInspection(options: OpenNirInspectionOptions): Promise<NirInspectionSession> {
  if (typeof WebAssembly === 'undefined') {
    throw new NirInspectionUnavailableError('no-wasm', 'WebAssembly is unavailable in this browser.');
  }

  let module: NirWasmModule;
  try {
    module = await options.loadModule();
    await (options.initModule ?? ((loaded) => loaded.default()))(module);
  } catch (error) {
    throw new NirInspectionUnavailableError('wasm-init-failed', errorMessage(error));
  }

  let envelope: string;
  try {
    envelope = await options.loadEnvelope();
  } catch (error) {
    throw new NirInspectionUnavailableError('asset-unavailable', errorMessage(error));
  }

  let handle: NirWasmHandle;
  try {
    handle = module.WasmNirInspection.parse(envelope);
  } catch (error) {
    throw new NirInspectionUnavailableError('nir-parse-failed', errorMessage(error));
  }

  if (handle.inspection_json() !== options.staticProjection) {
    handle.free();
    throw new NirInspectionUnavailableError(
      'projection-mismatch',
      'The Rust/WASM parse does not match the static render.',
    );
  }

  let disposed = false;
  return {
    nirRsVersion: handle.nir_rs_version,
    nodeCount: handle.node_count,
    edgeCount: handle.edge_count,
    node(name) {
      if (disposed) {
        throw new NirInspectionUnavailableError('disposed', 'The NIR inspection has been disposed.');
      }
      return JSON.parse(handle.node_json(name)) as NirNodeView;
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        handle.free();
      }
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
