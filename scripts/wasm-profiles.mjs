// Browser build profiles of crates/neuromorphic-adapter.
//
// One crate and one adapter boundary, compiled once per profile with different
// cargo features. `default` is the lean package the homepage loads. `labs`
// serves every off-homepage interactive surface: a new surface adds its cargo
// feature to `labs.features`, lists the crates it must bring in under
// `labs.requiredCrates`, and adds them to `default.excludedCrates` so the
// homepage package never grows with it. Crates that stay in the default graph
// transitively (sha2 via synaptic-wiring, serde_json via corpus-ipc) are pinned
// one level up instead: the adapter's own enabled features and its direct
// dependencies must match the profile.
//
// scripts/build-neuromorphic-web.mjs builds and drift-checks every profile;
// scripts/verify-browser-dependencies.mjs applies the native-dependency
// policy and these crate expectations to every profile's resolved graph.
export const WASM_PROFILES = Object.freeze([
  Object.freeze({
    name: 'default',
    features: Object.freeze([]),
    /** Cargo target directory, relative to the crate. */
    targetDirectory: 'target',
    outputDirectory: 'public/wasm/neuromorphic-adapter',
    requiredCrates: Object.freeze(['corpus-ipc']),
    excludedCrates: Object.freeze(['nir-rs']),
    requiredDirectDependencies: Object.freeze([]),
    /** Optional adapter dependencies only the labs features may enable. */
    excludedDirectDependencies: Object.freeze(['nir-rs', 'serde', 'serde_json', 'sha2']),
  }),
  Object.freeze({
    name: 'labs',
    features: Object.freeze(['nir', 'protocol']),
    targetDirectory: 'target/labs',
    outputDirectory: 'public/wasm/neuromorphic-adapter-labs',
    requiredCrates: Object.freeze(['corpus-ipc', 'nir-rs']),
    excludedCrates: Object.freeze([]),
    requiredDirectDependencies: Object.freeze(['nir-rs', 'serde_json', 'sha2']),
    excludedDirectDependencies: Object.freeze([]),
  }),
]);

/** Extra cargo arguments that select a profile's features. */
export function profileFeatureArgs(profile) {
  return profile.features.length > 0 ? ['--features', profile.features.join(',')] : [];
}
