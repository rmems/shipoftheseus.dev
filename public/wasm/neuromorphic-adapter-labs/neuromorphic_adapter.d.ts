/* tslint:disable */
/* eslint-disable */

export class WasmAdapter {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    dispose(): void;
    /**
     * `config` is `[3]` for the legacy delta-only contract, `[4]` for the
     * default v1 encoder mode, or `[4, mode]` to select it explicitly
     * (`0 = delta`, `1 = temporal`, `2 = rate`). `[5]` and `[5, mode]` select
     * the same encoder modes behind `kinetic-signals` telemetry extraction.
     */
    static init(seed: bigint, config: Uint8Array): WasmAdapter;
    input(sequence: bigint, samples: Float32Array): void;
    state(): WasmState;
    step(): WasmState;
}

/**
 * Browser handle for one parsed NIR graph. Construction parses and validates
 * the envelope with `nir-rs` inside Rust/WASM; JavaScript only reads the
 * projection back as canonical JSON whose numbers are small layout integers
 * and whose parameter values are Rust-formatted strings.
 */
export class WasmNirInspection {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The full projection; byte-identical to the committed static projection
     * generated from the same envelope.
     */
    inspection_json(): string;
    /**
     * One node's projection as canonical JSON.
     */
    node_json(name: string): string;
    /**
     * Parse a `shipoftheseus.nir-graph` v1 envelope. Errors are
     * `"<code>: <message>"` strings.
     */
    static parse(envelope_json: string): WasmNirInspection;
    readonly edge_count: number;
    readonly nir_rs_version: string;
    readonly node_count: number;
}

/**
 * Browser view of an accepted recorded envelope. Every `u64` crosses as a
 * `bigint`; numeric rows cross as JS-owned typed arrays.
 */
export class WasmProtocolInspection {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly batch_id: bigint;
    readonly byte_length: number;
    readonly canonical_json: string;
    readonly canonical_matches_input: boolean;
    /**
     * Key-sorted `[key, value]` string pairs.
     */
    readonly metadata_custom: Array<any>;
    readonly metadata_present: boolean;
    readonly metadata_processing_latency_ns: bigint | undefined;
    readonly metadata_source: string | undefined;
    readonly session_id: string | undefined;
    readonly sha256: string;
    readonly spike_channels: Uint16Array;
    readonly spike_strengths: Float32Array;
    readonly spike_times: Uint32Array;
    readonly stimulus_valid_mask: Uint8Array | undefined;
    readonly stimulus_values: Float32Array;
    readonly timestamp: bigint | undefined;
    readonly trace_channel_ids: Uint16Array;
    readonly trace_last_spike_times: Uint32Array;
    readonly trace_values: Float32Array;
    readonly variant: string;
    readonly wire_current: number;
    readonly wire_min_supported: number;
    readonly wire_version: number;
}

export class WasmState {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly completed_step: bigint;
    readonly contract_version: number;
    readonly encoded_spike_channels: number;
    readonly encoded_spike_count: number;
    readonly encoded_spike_total: bigint;
    readonly encoder_features: Float32Array;
    readonly encoder_mode: number;
    readonly encoder_name: string;
    readonly error_status: string;
    readonly last_sequence: bigint;
    readonly membrane_potentials: Float32Array;
    readonly protocol_wire_version: number;
    readonly seed: bigint;
    readonly spike_neurons: Uint32Array;
    readonly topology_delays: Uint16Array;
    readonly topology_digest: string;
    readonly topology_edge_delays: Uint16Array;
    readonly topology_edge_sources: Uint32Array;
    readonly topology_edge_targets: Uint32Array;
    readonly topology_edge_weights: Float32Array;
    readonly topology_node_ids: Uint32Array;
    readonly topology_outgoing_edge_offsets: Uint32Array;
    readonly topology_polarities: Uint8Array;
    readonly topology_rows: Uint32Array;
    readonly topology_targets: Uint32Array;
    readonly topology_weight_bits: Uint32Array;
    readonly topology_weights: Float32Array;
}

/**
 * Verify, decode, and validate one recorded envelope. Throws a
 * `ProtocolFixtureError` whose `code` is a [`ProtocolErrorCode`] string.
 */
export function inspectProtocolFixture(bytes: Uint8Array, expected_sha256: string, expected_variant: string): WasmProtocolInspection;

/**
 * The pre-parse byte limit, so the browser can bound fixture reads with the
 * adapter's own constant.
 */
export function protocolFixtureByteLimit(): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmnirinspection_free: (a: number, b: number) => void;
    readonly wasmnirinspection_edge_count: (a: number) => number;
    readonly wasmnirinspection_inspection_json: (a: number) => [number, number];
    readonly wasmnirinspection_nir_rs_version: (a: number) => [number, number];
    readonly wasmnirinspection_node_count: (a: number) => number;
    readonly wasmnirinspection_node_json: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmnirinspection_parse: (a: number, b: number) => [number, number, number];
    readonly __wbg_wasmprotocolinspection_free: (a: number, b: number) => void;
    readonly inspectProtocolFixture: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly protocolFixtureByteLimit: () => number;
    readonly wasmprotocolinspection_batch_id: (a: number) => bigint;
    readonly wasmprotocolinspection_byte_length: (a: number) => number;
    readonly wasmprotocolinspection_canonical_json: (a: number) => [number, number];
    readonly wasmprotocolinspection_canonical_matches_input: (a: number) => number;
    readonly wasmprotocolinspection_metadata_custom: (a: number) => any;
    readonly wasmprotocolinspection_metadata_present: (a: number) => number;
    readonly wasmprotocolinspection_metadata_processing_latency_ns: (a: number) => [number, bigint];
    readonly wasmprotocolinspection_metadata_source: (a: number) => [number, number];
    readonly wasmprotocolinspection_session_id: (a: number) => [number, number];
    readonly wasmprotocolinspection_sha256: (a: number) => [number, number];
    readonly wasmprotocolinspection_spike_channels: (a: number) => any;
    readonly wasmprotocolinspection_spike_strengths: (a: number) => any;
    readonly wasmprotocolinspection_spike_times: (a: number) => any;
    readonly wasmprotocolinspection_stimulus_valid_mask: (a: number) => any;
    readonly wasmprotocolinspection_stimulus_values: (a: number) => any;
    readonly wasmprotocolinspection_timestamp: (a: number) => [number, bigint];
    readonly wasmprotocolinspection_trace_channel_ids: (a: number) => any;
    readonly wasmprotocolinspection_trace_last_spike_times: (a: number) => any;
    readonly wasmprotocolinspection_trace_values: (a: number) => any;
    readonly wasmprotocolinspection_variant: (a: number) => [number, number];
    readonly wasmprotocolinspection_wire_current: (a: number) => number;
    readonly wasmprotocolinspection_wire_version: (a: number) => number;
    readonly wasmprotocolinspection_wire_min_supported: (a: number) => number;
    readonly __wbg_wasmadapter_free: (a: number, b: number) => void;
    readonly __wbg_wasmstate_free: (a: number, b: number) => void;
    readonly wasmadapter_dispose: (a: number) => void;
    readonly wasmadapter_init: (a: bigint, b: number, c: number) => [number, number, number];
    readonly wasmadapter_input: (a: number, b: bigint, c: number, d: number) => [number, number];
    readonly wasmadapter_state: (a: number) => [number, number, number];
    readonly wasmadapter_step: (a: number) => [number, number, number];
    readonly wasmstate_completed_step: (a: number) => bigint;
    readonly wasmstate_contract_version: (a: number) => number;
    readonly wasmstate_encoded_spike_channels: (a: number) => number;
    readonly wasmstate_encoded_spike_count: (a: number) => number;
    readonly wasmstate_encoded_spike_total: (a: number) => bigint;
    readonly wasmstate_encoder_features: (a: number) => any;
    readonly wasmstate_encoder_mode: (a: number) => number;
    readonly wasmstate_encoder_name: (a: number) => [number, number];
    readonly wasmstate_error_status: (a: number) => [number, number];
    readonly wasmstate_last_sequence: (a: number) => bigint;
    readonly wasmstate_membrane_potentials: (a: number) => any;
    readonly wasmstate_protocol_wire_version: (a: number) => number;
    readonly wasmstate_seed: (a: number) => bigint;
    readonly wasmstate_spike_neurons: (a: number) => any;
    readonly wasmstate_topology_delays: (a: number) => any;
    readonly wasmstate_topology_digest: (a: number) => [number, number];
    readonly wasmstate_topology_edge_delays: (a: number) => any;
    readonly wasmstate_topology_edge_sources: (a: number) => any;
    readonly wasmstate_topology_edge_targets: (a: number) => any;
    readonly wasmstate_topology_edge_weights: (a: number) => any;
    readonly wasmstate_topology_node_ids: (a: number) => any;
    readonly wasmstate_topology_outgoing_edge_offsets: (a: number) => any;
    readonly wasmstate_topology_polarities: (a: number) => any;
    readonly wasmstate_topology_rows: (a: number) => any;
    readonly wasmstate_topology_targets: (a: number) => any;
    readonly wasmstate_topology_weight_bits: (a: number) => any;
    readonly wasmstate_topology_weights: (a: number) => any;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
