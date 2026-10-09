/**
 * Provenance for the homepage's live Rust/WASM simulation: the upstream
 * crates the adapter composes, in pipeline order, pinned exactly as in
 * `crates/neuromorphic-adapter/Cargo.toml` and `Cargo.lock`.
 * `test/hero-live-mesh.test.mjs` fails when a pin here drifts from the
 * manifest or the lockfile.
 */
import { PORTFOLIO_DEFAULT_REF, PORTFOLIO_REPOSITORY_URL } from '../native-evidence/view';

export interface LiveCrateLayer {
  name: 'kinetic-signals' | 'axon-encoder' | 'neuromod' | 'synaptic-wiring';
  /** What the crate does in this demo, in a few words. */
  role: string;
  /** Resolved version from `Cargo.lock`. */
  version: string;
  /** Git dependencies are pinned by revision; registry ones by exact version. */
  source: { kind: 'git'; repository: string; revision: string } | { kind: 'crates.io' };
}

export const liveCrateLayers: readonly LiveCrateLayer[] = [
  {
    name: 'kinetic-signals',
    role: 'pointer features',
    version: '0.5.0',
    source: {
      kind: 'git',
      repository: 'https://github.com/rmems/kinetic-signals',
      revision: 'e829a0d5826c0d1175b8878b024a69ce4e1d538b',
    },
  },
  {
    name: 'axon-encoder',
    role: 'spike encoding',
    version: '0.4.0',
    source: {
      kind: 'git',
      repository: 'https://github.com/Limen-Neural/axon-encoder',
      revision: 'a56276746569e5ecaa78e50882064858835b2438',
    },
  },
  { name: 'neuromod', role: 'LIF neurons', version: '0.7.0', source: { kind: 'crates.io' } },
  { name: 'synaptic-wiring', role: 'synapses and delays', version: '0.3.0', source: { kind: 'crates.io' } },
];

/** Static link for a crate layer: its pinned source tree or its crates.io release. */
export function crateLayerHref(layer: LiveCrateLayer): string {
  return layer.source.kind === 'git'
    ? `${layer.source.repository}/tree/${layer.source.revision}`
    : `https://crates.io/crates/${layer.name}/${layer.version}`;
}

/** Short pin shown next to the crate name. */
export function crateLayerPin(layer: LiveCrateLayer): string {
  return layer.source.kind === 'git' ? `${layer.version} @ ${layer.source.revision.slice(0, 7)}` : layer.version;
}

/** The site's adapter crate that composes the layers and owns the WASM boundary. */
export const ADAPTER_SOURCE_URL = `${PORTFOLIO_REPOSITORY_URL}/tree/${PORTFOLIO_DEFAULT_REF}/crates/neuromorphic-adapter`;
