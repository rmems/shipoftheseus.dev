/**
 * Deterministic sensory stimulus for the live demo. Samples are a pure function
 * of the monotonically increasing input sequence — never of wall-clock time,
 * device state, or entropy — so identical seeds and steps replay byte-equal
 * simulation state per the adapter contract.
 */
export const DEMO_CHANNEL_COUNT = 16;
export const DEMO_SEED = 20260916n;
export const DEMO_TICK_MS = 50;

export function stimulusSamples(sequence: bigint): Float32Array {
  const step = Number(sequence & 0xffffn);
  const samples = new Float32Array(DEMO_CHANNEL_COUNT);

  for (let channel = 0; channel < DEMO_CHANNEL_COUNT; channel += 1) {
    const carrier = Math.sin(step * 0.11 + channel * 0.7);
    const harmonic = 0.5 * Math.sin(step * 0.031 * ((channel % 3) + 1) + channel);
    samples[channel] = carrier + harmonic;
  }

  return samples;
}
