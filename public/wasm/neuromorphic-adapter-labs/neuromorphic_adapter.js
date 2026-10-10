/* @ts-self-types="./neuromorphic_adapter.d.ts" */

export class WasmAdapter {
    static __wrap(ptr) {
        const obj = Object.create(WasmAdapter.prototype);
        obj.__wbg_ptr = ptr;
        WasmAdapterFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmAdapterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmadapter_free(ptr, 0);
    }
    dispose() {
        wasm.wasmadapter_dispose(this.__wbg_ptr);
    }
    /**
     * `config` is `[3]` for the legacy delta-only contract, `[4]` for the
     * default v1 encoder mode, or `[4, mode]` to select it explicitly
     * (`0 = delta`, `1 = temporal`, `2 = rate`). `[5]` and `[5, mode]` select
     * the same encoder modes behind `kinetic-signals` telemetry extraction.
     * @param {bigint} seed
     * @param {Uint8Array} config
     * @returns {WasmAdapter}
     */
    static init(seed, config) {
        const ptr0 = passArray8ToWasm0(config, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmadapter_init(seed, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmAdapter.__wrap(ret[0]);
    }
    /**
     * @param {bigint} sequence
     * @param {Float32Array} samples
     */
    input(sequence, samples) {
        const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmadapter_input(this.__wbg_ptr, sequence, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {WasmState}
     */
    state() {
        const ret = wasm.wasmadapter_state(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmState.__wrap(ret[0]);
    }
    /**
     * @returns {WasmState}
     */
    step() {
        const ret = wasm.wasmadapter_step(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmState.__wrap(ret[0]);
    }
}
if (Symbol.dispose) WasmAdapter.prototype[Symbol.dispose] = WasmAdapter.prototype.free;

/**
 * Browser handle for one parsed NIR graph. Construction parses and validates
 * the envelope with `nir-rs` inside Rust/WASM; JavaScript only reads the
 * projection back as canonical JSON whose numbers are small layout integers
 * and whose parameter values are Rust-formatted strings.
 */
export class WasmNirInspection {
    static __wrap(ptr) {
        const obj = Object.create(WasmNirInspection.prototype);
        obj.__wbg_ptr = ptr;
        WasmNirInspectionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmNirInspectionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmnirinspection_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get edge_count() {
        const ret = wasm.wasmnirinspection_edge_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The full projection; byte-identical to the committed static projection
     * generated from the same envelope.
     * @returns {string}
     */
    inspection_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmnirinspection_inspection_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get nir_rs_version() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmnirinspection_nir_rs_version(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get node_count() {
        const ret = wasm.wasmnirinspection_node_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * One node's projection as canonical JSON.
     * @param {string} name
     * @returns {string}
     */
    node_json(name) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmnirinspection_node_json(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Parse a `shipoftheseus.nir-graph` v1 envelope. Errors are
     * `"<code>: <message>"` strings.
     * @param {string} envelope_json
     * @returns {WasmNirInspection}
     */
    static parse(envelope_json) {
        const ptr0 = passStringToWasm0(envelope_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmnirinspection_parse(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmNirInspection.__wrap(ret[0]);
    }
}
if (Symbol.dispose) WasmNirInspection.prototype[Symbol.dispose] = WasmNirInspection.prototype.free;

/**
 * The lab session exported to JavaScript (labs package only).
 */
export class WasmPlasticityLab {
    static __wrap(ptr) {
        const obj = Object.create(WasmPlasticityLab.prototype);
        obj.__wbg_ptr = ptr;
        WasmPlasticityLabFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmPlasticityLabFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmplasticitylab_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get channel_count() {
        const ret = wasm.wasmplasticitylab_channel_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {bigint}
     */
    get completed_steps() {
        const ret = wasm.wasmplasticitylab_completed_steps(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * A fresh session seeded with `seed` (a JavaScript `bigint`).
     * @param {bigint} seed
     * @returns {WasmPlasticityLab}
     */
    static create(seed) {
        const ret = wasm.wasmplasticitylab_create(seed);
        return WasmPlasticityLab.__wrap(ret);
    }
    /**
     * @returns {Float32Array}
     */
    get eligibility() {
        const ret = wasm.wasmplasticitylab_eligibility(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {bigint}
     */
    get engine_step() {
        const ret = wasm.wasmplasticitylab_engine_step(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get episode() {
        const ret = wasm.wasmplasticitylab_episode(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get lab_version() {
        const ret = wasm.wasmplasticitylab_lab_version(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    get membrane_potentials() {
        const ret = wasm.wasmplasticitylab_membrane_potentials(this.__wbg_ptr);
        return ret;
    }
    /**
     * Dopamine, serotonin, acetylcholine, norepinephrine.
     * @returns {Float32Array}
     */
    get modulators() {
        const ret = wasm.wasmplasticitylab_modulators(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get neuron_count() {
        const ret = wasm.wasmplasticitylab_neuron_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    newEpisode() {
        wasm.wasmplasticitylab_newEpisode(this.__wbg_ptr);
    }
    /**
     * @returns {WasmPlasticityProbe}
     */
    probe() {
        const ret = wasm.wasmplasticitylab_probe(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmPlasticityProbe.__wrap(ret[0]);
    }
    /**
     * @returns {bigint}
     */
    get seed() {
        const ret = wasm.wasmplasticitylab_seed(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * `stimulus`: 0 quiet, 1 pattern A, 2 pattern B. `event`: 0 none,
     * 1 reward, 2 penalty. Errors are `"<code>: <message>"` strings.
     * @param {number} stimulus
     * @param {number} event
     * @returns {WasmPlasticityStep}
     */
    step(stimulus, event) {
        const ret = wasm.wasmplasticitylab_step(this.__wbg_ptr, stimulus, event);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmPlasticityStep.__wrap(ret[0]);
    }
    /**
     * @returns {Float32Array}
     */
    get thresholds() {
        const ret = wasm.wasmplasticitylab_thresholds(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Float32Array}
     */
    get weights() {
        const ret = wasm.wasmplasticitylab_weights(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) WasmPlasticityLab.prototype[Symbol.dispose] = WasmPlasticityLab.prototype.free;

/**
 * One frozen probe's per-neuron spike counts.
 */
export class WasmPlasticityProbe {
    static __wrap(ptr) {
        const obj = Object.create(WasmPlasticityProbe.prototype);
        obj.__wbg_ptr = ptr;
        WasmPlasticityProbeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmPlasticityProbeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmplasticityprobe_free(ptr, 0);
    }
    /**
     * @returns {Uint32Array}
     */
    get pattern_a_spikes() {
        const ret = wasm.wasmplasticityprobe_pattern_a_spikes(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint32Array}
     */
    get pattern_b_spikes() {
        const ret = wasm.wasmplasticityprobe_pattern_b_spikes(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get steps_per_pattern() {
        const ret = wasm.wasmplasticityprobe_steps_per_pattern(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) WasmPlasticityProbe.prototype[Symbol.dispose] = WasmPlasticityProbe.prototype.free;

/**
 * One step's result. Numeric rows are typed arrays copied out of Rust.
 */
export class WasmPlasticityStep {
    static __wrap(ptr) {
        const obj = Object.create(WasmPlasticityStep.prototype);
        obj.__wbg_ptr = ptr;
        WasmPlasticityStepFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmPlasticityStepFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmplasticitystep_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get episode() {
        const ret = wasm.wasmplasticitystep_episode(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {string}
     */
    get event() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmplasticitystep_event(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {Uint32Array}
     */
    get input_spikes() {
        const ret = wasm.wasmplasticitystep_input_spikes(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Float32Array}
     */
    get membrane_potentials() {
        const ret = wasm.wasmplasticitystep_membrane_potentials(this.__wbg_ptr);
        return ret;
    }
    /**
     * Dopamine, serotonin, acetylcholine, norepinephrine from `limbic-critic`.
     * @returns {Float32Array}
     */
    get modulators() {
        const ret = wasm.wasmplasticitystep_modulators(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get objective() {
        const ret = wasm.wasmplasticitystep_objective(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint32Array}
     */
    get output_spikes() {
        const ret = wasm.wasmplasticitystep_output_spikes(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {bigint}
     */
    get step() {
        const ret = wasm.wasmplasticitystep_step(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {string}
     */
    get stimulus() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmplasticitystep_stimulus(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get stress() {
        const ret = wasm.wasmplasticitystep_stress(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Float32Array}
     */
    get thresholds() {
        const ret = wasm.wasmplasticitystep_thresholds(this.__wbg_ptr);
        return ret;
    }
    /**
     * Flattened `[neuron, channel, before_bits, after_bits]` per changed weight.
     * @returns {Uint32Array}
     */
    get weight_changes() {
        const ret = wasm.wasmplasticitystep_weight_changes(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) WasmPlasticityStep.prototype[Symbol.dispose] = WasmPlasticityStep.prototype.free;

/**
 * Browser view of an accepted recorded envelope. Every `u64` crosses as a
 * `bigint`; numeric rows cross as JS-owned typed arrays.
 */
export class WasmProtocolInspection {
    static __wrap(ptr) {
        const obj = Object.create(WasmProtocolInspection.prototype);
        obj.__wbg_ptr = ptr;
        WasmProtocolInspectionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmProtocolInspectionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmprotocolinspection_free(ptr, 0);
    }
    /**
     * @returns {bigint}
     */
    get batch_id() {
        const ret = wasm.wasmprotocolinspection_batch_id(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {number}
     */
    get byte_length() {
        const ret = wasm.wasmprotocolinspection_byte_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * `identical`, `formatting`, `dropped-fields`, or `differs`.
     * @returns {string}
     */
    get canonical_difference() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmprotocolinspection_canonical_difference(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Dotted paths of input fields the re-encoding dropped (at most 32).
     * @returns {Array<any>}
     */
    get canonical_dropped_fields() {
        const ret = wasm.wasmprotocolinspection_canonical_dropped_fields(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get canonical_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmprotocolinspection_canonical_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {boolean}
     */
    get canonical_matches_input() {
        const ret = wasm.wasmprotocolinspection_canonical_matches_input(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Key-sorted `[key, value]` string pairs.
     * @returns {Array<any>}
     */
    get metadata_custom() {
        const ret = wasm.wasmprotocolinspection_metadata_custom(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    get metadata_present() {
        const ret = wasm.wasmprotocolinspection_metadata_present(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {bigint | undefined}
     */
    get metadata_processing_latency_ns() {
        const ret = wasm.wasmprotocolinspection_metadata_processing_latency_ns(this.__wbg_ptr);
        return ret[0] === 0 ? undefined : BigInt.asUintN(64, ret[1]);
    }
    /**
     * @returns {string | undefined}
     */
    get metadata_source() {
        const ret = wasm.wasmprotocolinspection_metadata_source(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @returns {string | undefined}
     */
    get session_id() {
        const ret = wasm.wasmprotocolinspection_session_id(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @returns {string}
     */
    get sha256() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmprotocolinspection_sha256(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {Uint16Array}
     */
    get spike_channels() {
        const ret = wasm.wasmprotocolinspection_spike_channels(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Float32Array}
     */
    get spike_strengths() {
        const ret = wasm.wasmprotocolinspection_spike_strengths(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint32Array}
     */
    get spike_times() {
        const ret = wasm.wasmprotocolinspection_spike_times(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint8Array | undefined}
     */
    get stimulus_valid_mask() {
        const ret = wasm.wasmprotocolinspection_stimulus_valid_mask(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Float32Array}
     */
    get stimulus_values() {
        const ret = wasm.wasmprotocolinspection_stimulus_values(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {bigint | undefined}
     */
    get timestamp() {
        const ret = wasm.wasmprotocolinspection_timestamp(this.__wbg_ptr);
        return ret[0] === 0 ? undefined : BigInt.asUintN(64, ret[1]);
    }
    /**
     * @returns {Uint16Array}
     */
    get trace_channel_ids() {
        const ret = wasm.wasmprotocolinspection_trace_channel_ids(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint32Array}
     */
    get trace_last_spike_times() {
        const ret = wasm.wasmprotocolinspection_trace_last_spike_times(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Float32Array}
     */
    get trace_values() {
        const ret = wasm.wasmprotocolinspection_trace_values(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get variant() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmprotocolinspection_variant(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get wire_current() {
        const ret = wasm.wasmprotocolinspection_wire_current(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get wire_min_supported() {
        const ret = wasm.wasmprotocolinspection_wire_min_supported(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get wire_version() {
        const ret = wasm.wasmprotocolinspection_wire_version(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) WasmProtocolInspection.prototype[Symbol.dispose] = WasmProtocolInspection.prototype.free;

export class WasmState {
    static __wrap(ptr) {
        const obj = Object.create(WasmState.prototype);
        obj.__wbg_ptr = ptr;
        WasmStateFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmStateFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmstate_free(ptr, 0);
    }
    /**
     * @returns {bigint}
     */
    get completed_step() {
        const ret = wasm.wasmstate_completed_step(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {number}
     */
    get contract_version() {
        const ret = wasm.wasmstate_contract_version(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get encoded_spike_channels() {
        const ret = wasm.wasmstate_encoded_spike_channels(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get encoded_spike_count() {
        const ret = wasm.wasmstate_encoded_spike_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {bigint}
     */
    get encoded_spike_total() {
        const ret = wasm.wasmstate_encoded_spike_total(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {Float32Array}
     */
    get encoder_features() {
        const ret = wasm.wasmstate_encoder_features(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get encoder_mode() {
        const ret = wasm.wasmstate_encoder_mode(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {string}
     */
    get encoder_name() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmstate_encoder_name(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get error_status() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmstate_error_status(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {bigint}
     */
    get last_sequence() {
        const ret = wasm.wasmstate_last_sequence(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {Float32Array}
     */
    get membrane_potentials() {
        const ret = wasm.wasmstate_membrane_potentials(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get protocol_wire_version() {
        const ret = wasm.wasmstate_protocol_wire_version(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {bigint}
     */
    get seed() {
        const ret = wasm.wasmstate_seed(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {Uint32Array}
     */
    get spike_neurons() {
        const ret = wasm.wasmstate_spike_neurons(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint16Array}
     */
    get topology_delays() {
        const ret = wasm.wasmstate_topology_delays(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get topology_digest() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmstate_topology_digest(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {Uint16Array}
     */
    get topology_edge_delays() {
        const ret = wasm.wasmstate_topology_edge_delays(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint32Array}
     */
    get topology_edge_sources() {
        const ret = wasm.wasmstate_topology_edge_sources(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint32Array}
     */
    get topology_edge_targets() {
        const ret = wasm.wasmstate_topology_edge_targets(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Float32Array}
     */
    get topology_edge_weights() {
        const ret = wasm.wasmstate_topology_edge_weights(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint32Array}
     */
    get topology_node_ids() {
        const ret = wasm.wasmstate_topology_node_ids(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint32Array}
     */
    get topology_outgoing_edge_offsets() {
        const ret = wasm.wasmstate_topology_outgoing_edge_offsets(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint8Array}
     */
    get topology_polarities() {
        const ret = wasm.wasmstate_topology_polarities(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint32Array}
     */
    get topology_rows() {
        const ret = wasm.wasmstate_topology_rows(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint32Array}
     */
    get topology_targets() {
        const ret = wasm.wasmstate_topology_targets(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint32Array}
     */
    get topology_weight_bits() {
        const ret = wasm.wasmstate_topology_weight_bits(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Float32Array}
     */
    get topology_weights() {
        const ret = wasm.wasmstate_topology_weights(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) WasmState.prototype[Symbol.dispose] = WasmState.prototype.free;

/**
 * Verify, decode, and validate one recorded envelope. Throws a
 * `ProtocolFixtureError` whose `code` is a [`ProtocolErrorCode`] string.
 * @param {Uint8Array} bytes
 * @param {string} expected_sha256
 * @param {string} expected_variant
 * @returns {WasmProtocolInspection}
 */
export function inspectProtocolFixture(bytes, expected_sha256, expected_variant) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(expected_sha256, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(expected_variant, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.inspectProtocolFixture(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return WasmProtocolInspection.__wrap(ret[0]);
}

/**
 * The pre-parse byte limit, so the browser can bound fixture reads with the
 * adapter's own constant.
 * @returns {number}
 */
export function protocolFixtureByteLimit() {
    const ret = wasm.protocolFixtureByteLimit();
    return ret >>> 0;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_32b398fb48b6d94a: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_b667d279fd5aa943: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_7568ba55b4a7e81f: function(arg0, arg1) {
            const ret = new Uint32Array(getArrayU32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_77cdfb7977362f3c: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_8ba5ff5ce7af1fe8: function(arg0, arg1) {
            const ret = new Uint16Array(getArrayU16FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_ddf8b82c4d6af38e: function(arg0, arg1) {
            const ret = new Float32Array(getArrayF32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_with_length_e1d8c8061ed4e317: function(arg0) {
            const ret = new Float32Array(arg0 >>> 0);
            return ret;
        },
        __wbg_of_5f1b88183ddb5d94: function(arg0, arg1) {
            const ret = Array.of(arg0, arg1);
            return ret;
        },
        __wbg_push_d2ae3af0c1217ae6: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_set_8535240470bf2500: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_name_3bbc583faefa4193: function(arg0, arg1, arg2) {
            arg0.name = getStringFromWasm0(arg1, arg2);
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./neuromorphic_adapter_bg.js": import0,
    };
}

const WasmAdapterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmadapter_free(ptr, 1));
const WasmNirInspectionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmnirinspection_free(ptr, 1));
const WasmPlasticityLabFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmplasticitylab_free(ptr, 1));
const WasmPlasticityProbeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmplasticityprobe_free(ptr, 1));
const WasmPlasticityStepFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmplasticitystep_free(ptr, 1));
const WasmProtocolInspectionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmprotocolinspection_free(ptr, 1));
const WasmStateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmstate_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint16ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('neuromorphic_adapter_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
