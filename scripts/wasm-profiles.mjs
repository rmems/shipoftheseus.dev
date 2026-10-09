// Browser build profiles of crates/neuromorphic-adapter.
//
// One crate and one adapter boundary, compiled once per profile with different
// cargo features. `default` is the lean package the homepage loads. `labs`
// serves every off-homepage interactive surface: a new surface adds its cargo
// feature to `labs.features`, lists the crates it must bring in under
// `labs.requiredCrates`, and adds them to `default.excludedCrates` so the
// homepage package never grows with it.
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
  }),
  Object.freeze({
    name: 'labs',
    features: Object.freeze(['nir']),
    targetDirectory: 'target/labs',
    outputDirectory: 'public/wasm/neuromorphic-adapter-labs',
    requiredCrates: Object.freeze(['corpus-ipc', 'nir-rs']),
    excludedCrates: Object.freeze([]),
  }),
]);

/** Extra cargo arguments that select a profile's features. */
export function profileFeatureArgs(profile) {
  return profile.features.length > 0 ? ['--features', profile.features.join(',')] : [];
}
