import type { ExecutionOrigin } from '../native-evidence/view';

/**
 * One entry on the `/labs/` index. Each lab is a focused, self-contained page
 * that states where its data comes from with an execution-origin label.
 * Add new labs by appending an entry; the index renders this list in order.
 */
export interface LabEntry {
  href: string;
  title: string;
  summary: string;
  origin: ExecutionOrigin;
  /** Upstream crates the lab relies on, shown as tags. */
  crates: readonly string[];
}

export const labs: readonly LabEntry[] = [
  {
    href: '/labs/nir/',
    title: 'NIR network inspection',
    summary:
      'A small, hand-authored NIR graph parsed and validated by nir-rs inside the Rust/WASM adapter, with each operator’s type and parameters open for inspection. Structure only: nothing is simulated.',
    origin: 'imported-nir',
    crates: ['nir-rs'],
  },
  {
    href: '/labs/plasticity/',
    title: 'Reward-modulated learning',
    summary:
      'Two input patterns, two LIF neurons, and a reward button. limbic-critic maps reward and penalty to neuromodulators, plasticity-lab steps a neuromod network with them, and reward-modulated STDP changes the weights, live in Rust/WASM with a replayable scripted session.',
    origin: 'live-wasm',
    crates: ['limbic-critic', 'plasticity-lab', 'neuromod'],
  },
];
