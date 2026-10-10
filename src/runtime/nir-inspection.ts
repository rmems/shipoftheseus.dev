/**
 * NIR inspection projection types, static diagram layout, and the browser
 * bridge to the `WasmNirInspection` export of the neuromorphic adapter.
 *
 * `nir-rs` (inside Rust/WASM) owns NIR graph semantics. This module never
 * interprets operator parameters: it lays out the projection Rust produced and
 * displays the Rust-formatted values verbatim.
 */

/**
 * The labs build of the adapter (`--features nir`). The homepage loads the
 * lean default package at `/wasm/neuromorphic-adapter/` instead, which does
 * not contain `WasmNirInspection`.
 */
export const NIR_WASM_MODULE_URL = '/wasm/neuromorphic-adapter-labs/neuromorphic_adapter.js';
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
      let view: unknown;
      try {
        view = JSON.parse(handle.node_json(name));
      } catch (error) {
        throw new NirInspectionUnavailableError('invalid-node', errorMessage(error));
      }
      if (!isNirNodeView(view) || view.name !== name) {
        throw new NirInspectionUnavailableError('invalid-node', `The Rust/WASM view of ${name} is malformed.`);
      }
      return view;
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
  if (error instanceof Error) return error.message;
  // wasm-bindgen surfaces Rust errors as thrown JavaScript strings.
  if (typeof error === 'string') return error;
  return 'unexpected non-error exception';
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

function isNirFieldView(value: unknown): value is NirFieldView {
  if (typeof value !== 'object' || value === null) return false;
  const field = value as Record<string, unknown>;
  return (
    isString(field.name) &&
    isString(field.kind) &&
    (field.dtype === null || isString(field.dtype)) &&
    Array.isArray(field.shape) &&
    field.shape.every(isCount) &&
    isCount(field.value_count) &&
    isStringArray(field.values)
  );
}

/** Cheap structural check before a node view reaches the DOM. */
export function isNirNodeView(value: unknown): value is NirNodeView {
  if (typeof value !== 'object' || value === null) return false;
  const node = value as Record<string, unknown>;
  return (
    isString(node.name) &&
    isString(node.operator) &&
    isCount(node.layer) &&
    isCount(node.row) &&
    isStringArray(node.inputs) &&
    isStringArray(node.outputs) &&
    Array.isArray(node.parameters) &&
    node.parameters.every(isNirFieldView) &&
    Array.isArray(node.metadata) &&
    node.metadata.every(isNirFieldView)
  );
}

/**
 * Decode the projection text the page embedded as a JSON string literal.
 * `JSON.parse` only decodes data; the result must be a string, which is then
 * compared byte for byte with the Rust/WASM output and never rendered itself.
 */
export function decodeStaticProjection(embedded: string | null): string {
  let value: unknown;
  try {
    value = JSON.parse(embedded ?? '');
  } catch (error) {
    throw new NirInspectionUnavailableError('invalid-static-projection', errorMessage(error));
  }
  if (!isString(value) || !value.startsWith('{')) {
    throw new NirInspectionUnavailableError(
      'invalid-static-projection',
      'The embedded projection is not a JSON document string.',
    );
  }
  return value;
}
