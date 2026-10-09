import {
  NIR_WASM_MODULE_URL,
  NirInspectionUnavailableError,
  decodeStaticProjection,
  formatNirFieldValues,
  formatNirShape,
  openNirInspection,
  type NirFieldView,
  type NirInspectionSession,
  type NirNodeView,
  type NirWasmModule,
  type OpenNirInspectionOptions,
} from './nir-inspection';

export const NIR_STATIC_STATUS =
  'Static render of the build-time nir-rs projection. Interactive inspection loads when JavaScript and WebAssembly are available.';
export const NIR_LOADING_STATUS = 'Loading the Rust/WASM adapter to parse this graph with nir-rs…';
export const NIR_UNAVAILABLE_STATUS =
  'Interactive inspection is unavailable here. The diagram and operator list stay available: they come from the same nir-rs projection, produced at build time.';

export function nirReadyStatus(nirRsVersion: string): string {
  return `Parsed and validated by nir-rs ${nirRsVersion} inside the Rust/WASM adapter. Select an operator to inspect it.`;
}

export interface BoundNirLab {
  /** Settles once the lab is interactive or has fallen back to static. */
  ready: Promise<void>;
  dispose: () => void;
}

export interface BindNirLabOptions {
  open?: (options: OpenNirInspectionOptions) => Promise<NirInspectionSession>;
  loadModule?: OpenNirInspectionOptions['loadModule'];
  fetchText?: (url: string) => Promise<string>;
}

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`NIR lab is missing ${selector}`);
  }
  return element;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`could not load ${url} (${response.status})`);
  }
  return response.text();
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  if (text !== undefined) created.textContent = text;
  if (className) created.className = className;
  return created;
}

function fieldTable(caption: string, fields: readonly NirFieldView[]): HTMLTableElement {
  const table = element('table', undefined, 'nir-field-table');
  table.append(element('caption', caption));
  const head = element('thead');
  const headRow = element('tr');
  for (const label of ['Field', 'dtype', 'Shape', 'Values']) {
    const cell = element('th', label);
    cell.scope = 'col';
    headRow.append(cell);
  }
  head.append(headRow);
  const body = element('tbody');
  for (const field of fields) {
    const row = element('tr');
    const name = element('th');
    name.scope = 'row';
    name.append(element('code', field.name));
    row.append(
      name,
      element('td', field.dtype ?? '—'),
      element('td', field.kind === 'absent' ? '—' : formatNirShape(field.shape)),
      element('td', formatNirFieldValues(field), 'nir-field-values'),
    );
    body.append(row);
  }
  table.append(head, body);
  return table;
}

function linkList(label: string, names: readonly string[]): HTMLDivElement {
  const group = element('div');
  group.append(element('dt', label), element('dd', names.length > 0 ? names.join(', ') : 'none'));
  return group;
}

/** Replace the inspector body with one node exactly as Rust reported it. */
export function renderNirInspector(body: HTMLElement, node: NirNodeView, nirRsVersion: string): void {
  const header = element('header');
  header.append(element('p', 'Selected operator', 'eyebrow'), element('h3', node.name));
  const operator = element('p', undefined, 'nir-inspector-operator');
  operator.append(element('code', node.operator), ` · parsed by nir-rs ${nirRsVersion} in Rust/WASM`);
  header.append(operator);

  const links = element('dl', undefined, 'nir-links');
  links.append(linkList('Receives from', node.inputs), linkList('Sends to', node.outputs));

  const parts: Node[] = [header, links, fieldTable('Parameters', node.parameters)];
  if (node.metadata.length > 0) {
    parts.push(fieldTable('Metadata', node.metadata));
  }
  body.replaceChildren(...parts);
}

/**
 * Progressive enhancement for one `[data-nir-lab]` island. The static SVG and
 * operator list are already complete; this only adds selection backed by the
 * `nir-rs` parse in Rust/WASM, and leaves the page untouched on any failure.
 */
export function bindNirLab(root: HTMLElement, options: BindNirLabOptions = {}): BoundNirLab {
  const status = requiredElement<HTMLElement>(root, '[data-nir-status]');
  const inspector = requiredElement<HTMLElement>(root, '[data-nir-inspector]');
  const inspectorBody = requiredElement<HTMLElement>(inspector, '[data-nir-inspector-body]');
  const selection = requiredElement<HTMLElement>(inspector, '[data-nir-selection]');
  const projectionScript = requiredElement<HTMLScriptElement>(root, '[data-nir-static-projection]');
  const envelopeUrl = root.dataset.nirEnvelope;
  const anchors = Array.from(root.querySelectorAll<SVGAElement>('[data-nir-node]'));
  const edges = Array.from(root.querySelectorAll<SVGPathElement>('[data-nir-edge-source]'));

  let session: NirInspectionSession | null = null;
  let disposed = false;

  const setState = (state: 'loading' | 'ready' | 'unavailable', message: string, reason?: string) => {
    root.dataset.nirState = state;
    if (reason) root.dataset.nirReason = reason;
    else delete root.dataset.nirReason;
    status.textContent = message;
  };

  const clearSelection = () => {
    for (const anchor of anchors) {
      anchor.removeAttribute('data-selected');
      anchor.removeAttribute('aria-current');
    }
    for (const edge of edges) edge.removeAttribute('data-active');
  };

  /** Return to the complete static page and release the WASM session. */
  const fallBack = (error: unknown) => {
    for (const anchor of anchors) anchor.removeEventListener('click', onNodeClick);
    session?.dispose();
    session = null;
    clearSelection();
    inspector.hidden = true;
    inspectorBody.replaceChildren();
    selection.textContent = '';
    const reason = error instanceof NirInspectionUnavailableError ? error.code : 'enhancement-failed';
    setState('unavailable', NIR_UNAVAILABLE_STATUS, reason);
  };

  const select = (name: string) => {
    if (!session) return;
    let node: NirNodeView;
    try {
      node = session.node(name);
    } catch (error) {
      fallBack(error);
      return;
    }
    for (const anchor of anchors) {
      const selected = anchor.dataset.nirNode === name;
      anchor.toggleAttribute('data-selected', selected);
      if (selected) anchor.setAttribute('aria-current', 'true');
      else anchor.removeAttribute('aria-current');
    }
    for (const edge of edges) {
      edge.toggleAttribute(
        'data-active',
        edge.dataset.nirEdgeSource === name || edge.dataset.nirEdgeTarget === name,
      );
    }
    renderNirInspector(inspectorBody, node, session.nirRsVersion);
    selection.textContent = `Showing ${node.name} (${node.operator}).`;
  };

  function onNodeClick(event: Event) {
    const name = (event.currentTarget as SVGAElement | null)?.dataset.nirNode;
    if (!session || !name) return;
    event.preventDefault();
    select(name);
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const anchor of anchors) anchor.removeEventListener('click', onNodeClick);
    document.removeEventListener('astro:before-swap', dispose);
    window.removeEventListener('pagehide', onPageHide);
    session?.dispose();
    session = null;
  };

  function onPageHide(event: Event) {
    if (!('persisted' in event && event.persisted)) dispose();
  }

  document.addEventListener('astro:before-swap', dispose);
  window.addEventListener('pagehide', onPageHide);

  const open = options.open ?? openNirInspection;
  const load = options.fetchText ?? fetchText;
  setState('loading', NIR_LOADING_STATUS);

  const ready = (async () => {
    try {
      if (!envelopeUrl) {
        throw new NirInspectionUnavailableError('asset-unavailable', 'no NIR asset is configured');
      }
      const opened = await open({
        loadModule:
          options.loadModule ??
          (() => import(/* @vite-ignore */ NIR_WASM_MODULE_URL) as Promise<NirWasmModule>),
        loadEnvelope: () => load(envelopeUrl),
        // Build-emitted JSON string literal of the committed projection; only
        // compared byte for byte with the WASM output, never rendered.
        staticProjection: decodeStaticProjection(projectionScript.textContent),
      });
      if (disposed) {
        opened.dispose();
        return;
      }
      session = opened;
      for (const anchor of anchors) anchor.addEventListener('click', onNodeClick);
      inspector.hidden = false;
      setState('ready', nirReadyStatus(opened.nirRsVersion));
      const first = anchors[0]?.dataset.nirNode;
      if (first) select(first);
    } catch (error) {
      if (!disposed) fallBack(error);
    }
  })();

  return { ready, dispose };
}

export function enhanceNirLabs(scope: ParentNode = document): BoundNirLab[] {
  const bound: BoundNirLab[] = [];
  for (const root of scope.querySelectorAll<HTMLElement>('[data-nir-lab]')) {
    try {
      bound.push(bindNirLab(root));
    } catch {
      // A malformed island keeps its static content.
    }
  }
  return bound;
}
