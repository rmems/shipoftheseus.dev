/**
 * Progressive enhancement for `/protocol/`. The static page already shows the
 * exact recorded bytes and their provenance. This script fetches the same
 * bytes, decodes them through the real Rust/WASM adapter, and adds the typed
 * view. Any failure leaves the static content in place.
 */
import {
  createProtocolInspector,
  errorMessage,
  formatF32,
  ProtocolFixtureError,
  readBoundedBytes,
  type ProtocolInspection,
  type ProtocolInspector,
  type ProtocolWasmModule,
} from './inspector';
import { PROTOCOL_WASM_MODULE_URL, isProtocolVariant, type ProtocolVariant } from './provenance';

export type ProtocolCheckKind = 'flip-byte' | 'future-version';

interface FixtureCard {
  element: HTMLElement;
  id: string;
  url: string;
  sha256: string;
  variant: ProtocolVariant;
}

export interface ProtocolViewerOptions {
  loadWasmModule?: () => Promise<ProtocolWasmModule>;
  fetchFixture?: (url: string) => Promise<Response>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function failureOf(error: unknown): ProtocolFixtureError {
  if (error instanceof ProtocolFixtureError) return error;
  return new ProtocolFixtureError('adapter-error', errorMessage(error));
}

/**
 * Describe only what the adapter's comparison established about the input
 * versus corpus-ipc's canonical re-encoding.
 */
export function canonicalSummary(inspection: Pick<ProtocolInspection, 'canonicalDifference' | 'droppedFields'>): string {
  switch (inspection.canonicalDifference) {
    case 'identical':
      return 'corpus-ipc re-encodes it byte-for-byte (lossless)';
    case 'formatting':
      return 'accepted; the bytes differ from corpus-ipc’s re-encoding only in JSON formatting (same value)';
    case 'dropped-fields':
      return `accepted; corpus-ipc’s re-encoding omits fields it does not define: ${inspection.droppedFields.join(', ')}`;
    case 'differs':
      return 'accepted; the bytes differ from corpus-ipc’s canonical re-encoding';
  }
}

function validityLabel(validMask: Uint8Array | null, index: number): string {
  if (!validMask) return 'yes';
  return validMask[index] ? 'yes' : 'no';
}

/**
 * Derive a tampered copy for the fail-closed demonstrations. `flip-byte`
 * keeps the published digest, so the adapter must reject it before parsing.
 * `future-version` is re-hashed by the caller, so the rejection comes from
 * `corpus-ipc`'s wire-version window instead.
 */
export function mutateForCheck(kind: ProtocolCheckKind, bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  if (kind === 'future-version') {
    return encoder.encode(text.replace('"wire_version":1', '"wire_version":2'));
  }
  // Change the last digit of batch_id (ASCII fixtures: string index = byte index).
  const copy = new Uint8Array(bytes);
  const batchId = /"batch_id":\d+/.exec(text);
  const index = batchId ? batchId.index + batchId[0].length - 1 : Math.floor(copy.length / 2);
  copy[index] = copy[index] === 0x39 ? 0x38 : (copy[index] + 1) & 0xff;
  return copy;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ProtocolFixtureError('wasm-unavailable', 'Re-hashing needs WebCrypto (HTTPS or localhost).');
  }
  const digest = new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function field(list: HTMLDListElement, term: string, value: string | Node, dataName?: string): void {
  const row = element('div');
  const dd = element('dd');
  if (typeof value === 'string') dd.textContent = value;
  else dd.append(value);
  if (dataName) dd.dataset[dataName] = '';
  row.append(element('dt', term), dd);
  list.append(row);
}

function table(caption: string, headers: string[], rows: string[][]): HTMLElement {
  const wrap = element('div', undefined, 'protocol-table-wrap');
  const tableElement = element('table', undefined, 'protocol-table');
  tableElement.append(element('caption', caption));
  const head = element('thead');
  const headRow = element('tr');
  for (const header of headers) {
    const th = element('th', header);
    th.scope = 'col';
    headRow.append(th);
  }
  head.append(headRow);
  const body = element('tbody');
  for (const row of rows) {
    const tr = element('tr');
    row.forEach((cell, index) => {
      if (index === 0) {
        const th = element('th', cell);
        th.scope = 'row';
        tr.append(th);
      } else {
        tr.append(element('td', cell));
      }
    });
    body.append(tr);
  }
  tableElement.append(head, body);
  wrap.append(tableElement);
  return wrap;
}

function bigintValue(value: bigint): Node {
  const fragment = document.createDocumentFragment();
  const code = element('code', value.toString());
  code.dataset.protocolBigint = value.toString();
  fragment.append(code);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fragment.append(
      element(
        'span',
        ` bigint, exact. A JavaScript Number would read ${String(Number(value))}.`,
        'protocol-note',
      ),
    );
  }
  return fragment;
}

export function renderInspection(container: HTMLElement, inspection: ProtocolInspection): void {
  const fields = element('dl', undefined, 'protocol-fields');
  field(
    fields,
    'Wire version',
    `${inspection.wireVersion} accepted (corpus-ipc window ${inspection.wireWindow.minSupported}–${inspection.wireWindow.current})`,
    'protocolWireVersion',
  );
  field(fields, 'SHA-256', `verified · ${inspection.byteLength} bytes`);
  field(fields, 'session_id', inspection.sessionId ?? 'null');
  field(fields, 'batch_id', bigintValue(inspection.batchId), 'protocolBatchId');
  if (inspection.timestamp !== null) field(fields, 'timestamp', bigintValue(inspection.timestamp));
  if (inspection.metadata) {
    field(fields, 'metadata.source', inspection.metadata.source ?? 'null');
    field(
      fields,
      'processing_latency_ns',
      inspection.metadata.processingLatencyNs === null
        ? 'null (not measured)'
        : bigintValue(inspection.metadata.processingLatencyNs),
    );
    field(
      fields,
      'metadata.custom',
      inspection.metadata.custom.length === 0
        ? 'none'
        : inspection.metadata.custom.map(([key, value]) => `${key} = ${value}`).join(', '),
    );
  }
  field(fields, 'Re-encoding', canonicalSummary(inspection), 'protocolCanonical');

  const parts: Node[] = [fields];
  if (inspection.stimuli) {
    const { values, validMask } = inspection.stimuli;
    parts.push(
      table(
        `values (${values.length} channels)`,
        ['Channel', 'Value', 'Valid'],
        Array.from(values, (value, index) => [
          String(index),
          formatF32(value),
          validityLabel(validMask, index),
        ]),
      ),
    );
  }
  if (inspection.spikes) {
    const { channels, times, strengths } = inspection.spikes;
    parts.push(
      table(
        `spikes (${channels.length} events)`,
        ['Channel', 'Time', 'Strength'],
        Array.from(channels, (channel, index) => [String(channel), String(times[index]), formatF32(strengths[index])]),
      ),
    );
  }
  if (inspection.traces) {
    const { channelIds, values, lastSpikeTimes } = inspection.traces;
    parts.push(
      table(
        `traces (${channelIds.length} rows)`,
        ['channel_id', 'trace_value', 'last_spike_time'],
        Array.from(channelIds, (channel, index) => [
          String(channel),
          formatF32(values[index]),
          String(lastSpikeTimes[index]),
        ]),
      ),
    );
  }
  container.replaceChildren(...parts);
}

function readCards(root: HTMLElement): FixtureCard[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-protocol-fixture]')).flatMap((element) => {
    const { fixtureId, fixtureUrl, fixtureSha256, fixtureVariant } = element.dataset;
    if (!fixtureId || !fixtureUrl || !fixtureSha256 || !isProtocolVariant(fixtureVariant)) return [];
    return [{ element, id: fixtureId, url: fixtureUrl, sha256: fixtureSha256, variant: fixtureVariant }];
  });
}

function setCardStatus(card: FixtureCard, status: 'verified' | 'rejected', text: string, code?: string): void {
  card.element.dataset.protocolStatus = status;
  if (code) card.element.dataset.protocolCode = code;
  const statusElement = card.element.querySelector<HTMLElement>('[data-protocol-fixture-status]');
  if (statusElement) statusElement.textContent = text;
}

function bindChecks(root: HTMLElement, inspector: ProtocolInspector, cards: FixtureCard[], bytesById: Map<string, Uint8Array>): void {
  const checks = root.querySelector<HTMLElement>('[data-protocol-checks]');
  const output = root.querySelector<HTMLElement>('[data-protocol-check-result]');
  const target = cards.find((card) => bytesById.has(card.id));
  if (!checks || !output || !target) return;

  for (const button of checks.querySelectorAll<HTMLButtonElement>('[data-protocol-check]')) {
    const kind = button.dataset.protocolCheck;
    if (kind !== 'flip-byte' && kind !== 'future-version') continue;
    button.addEventListener('click', async () => {
      const original = bytesById.get(target.id);
      if (!original) return;
      const tampered = mutateForCheck(kind, original);
      try {
        const digest = kind === 'flip-byte' ? target.sha256 : await sha256Hex(tampered);
        inspector.inspect(tampered, digest, target.variant);
        output.dataset.protocolCheckCode = 'accepted';
        output.textContent = `${target.id}: the tampered copy was accepted, which should not happen.`;
      } catch (error) {
        const failure = failureOf(error);
        output.dataset.protocolCheckCode = failure.code;
        output.textContent = `${target.id}: rejected · ${failure.code}. ${failure.message}`;
      }
    });
  }
  checks.hidden = false;
}

export async function enhanceProtocolViewer(root: HTMLElement, options: ProtocolViewerOptions = {}): Promise<void> {
  if (root.dataset.protocolState && root.dataset.protocolState !== 'static') return;
  const pageStatus = root.querySelector<HTMLElement>('[data-protocol-page-status]');
  const setPage = (state: string, text: string) => {
    root.dataset.protocolState = state;
    if (pageStatus) pageStatus.textContent = text;
  };
  const cards = readCards(root);
  setPage('loading', 'Loading the Rust/WASM adapter to verify the recorded bytes…');

  let inspector: ProtocolInspector;
  try {
    inspector = await createProtocolInspector(
      options.loadWasmModule ??
        (() => import(/* @vite-ignore */ PROTOCOL_WASM_MODULE_URL) as Promise<ProtocolWasmModule>),
    );
  } catch (error) {
    setPage(
      'unavailable',
      `Rust/WASM unavailable (${failureOf(error).code}). The recorded bytes and digests above remain the reference.`,
    );
    return;
  }

  const fetchFixture = options.fetchFixture ?? ((url: string) => fetch(url, { credentials: 'same-origin' }));
  const bytesById = new Map<string, Uint8Array>();
  let verified = 0;
  for (const card of cards) {
    try {
      const bytes = await readBoundedBytes(await fetchFixture(card.url), inspector.byteLimit);
      const inspection = inspector.inspect(bytes, card.sha256, card.variant);
      const container = card.element.querySelector<HTMLElement>('[data-protocol-decoded]');
      if (container) renderInspection(container, inspection);
      bytesById.set(card.id, bytes);
      verified += 1;
      setCardStatus(card, 'verified', 'Verified, decoded, and validated in this browser by corpus-ipc 0.1.0 (Rust/WASM).');
    } catch (error) {
      const failure = failureOf(error);
      setCardStatus(card, 'rejected', `Rejected · ${failure.code}. ${failure.message}`, failure.code);
    }
  }

  bindChecks(root, inspector, cards, bytesById);
  setPage(
    verified === cards.length ? 'verified' : 'partial',
    `${verified} of ${cards.length} recorded envelopes verified and decoded in this browser.`,
  );
}

export function enhanceProtocolViewers(scope: ParentNode = document): void {
  for (const root of scope.querySelectorAll<HTMLElement>('[data-protocol-viewer]')) {
    void enhanceProtocolViewer(root);
  }
}
