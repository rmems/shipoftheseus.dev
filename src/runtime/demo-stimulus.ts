/**
 * Deterministic scripted telemetry for the live demo. When nobody is
 * interacting (or interaction is unavailable), the demo traces this Lissajous
 * path as if a pointer were moving across the island. Packets are a pure
 * function of the monotonically increasing input sequence — never of
 * wall-clock time, device state, or entropy — so identical seeds and steps
 * replay byte-equal simulation state per the adapter contract.
 *
 * Packets use the contract-5 `[x, y, pressure]` layout; feature extraction and
 * spike encoding happen in Rust (`kinetic-signals` → `axon-encoder`).
 */
export const DEMO_SEED = 20260916n;
export const DEMO_TICK_MS = 50;

export function scriptedTelemetry(sequence: bigint): Float32Array {
  // Exact for 2^53 ticks; no wraparound jump that would read as a fast swipe.
  const step = Number(sequence);
  const x = 0.5 + 0.38 * Math.sin(step * 0.09);
  const y = 0.5 + 0.3 * Math.sin(step * 0.13 + 0.8);
  // A periodic "press" every ~6 s gives the pressure channels structure.
  const pressure = step % 120 < 24 ? 0.5 : 0;
  return new Float32Array([x, y, pressure]);
}
