/**
 * friday-perf-metric-instances.locked.mjs
 *
 * The OPERATOR-LOCKED R7 performance-metric denominator for R13 stress
 * TEST-STRESS-PERF-SOAK-AUTHORITY-001 (#47).
 *
 * PROVENANCE (not invented here): every rule below is transcribed VERBATIM from
 * `FRIDAY_ENDBAR_PRODUCT_POLICY.yaml -> performance_policy.metric_matrix_rules`
 * (contract_revision ENDBAR-*, `performance_policy.frozen_at = 2026-07-11T13:34:32Z`).
 * That product policy is the operator-frozen source of the "96 locked metric
 * instances" the R13 overlay's `performance_preservation.locked_metric_instances`
 * (=96) and repair-prompt §35.2/§35.10 refer to. The product policy lives OUTSIDE
 * this repo (in the Handoff-Log), so a committed, CI-hermetic slice must vendor it.
 *
 * The vendored copy is NOT trusted on its word: `deriveLockedMetricInstances()`
 * (in the generator) re-expands these rules with the EXACT algorithm the
 * authoritative `tools/endbar-product-policy/product-policy-validator.mjs` uses
 * (`instanceRowsForRule` + `sha256(stableJson(...))`) and REQUIRES that
 *   (a) each rule's expansion reproduces its own `expanded_instance_set_sha256`,
 *   (b) the sorted global set reproduces `LOCKED_METRIC_INSTANCE_SET_SHA256`, and
 *   (c) the count is exactly `LOCKED_METRIC_INSTANCE_COUNT` (96).
 * A single mis-transcribed field breaks (a); a mis-implemented algorithm breaks
 * (b). So the 96 `perf:<40hex>` instance ids are self-authenticating against the
 * operator-locked hash `399d88f0...` — they can ONLY be the real locked set, never
 * a "plausible 96". If any check fails the generator goes RED (LOCKED_METRIC_SET_DRIFT).
 *
 * This module is DATA + provenance only; the derivation/verification lives in the
 * generator so a single expansion implementation is exercised by both the CLI and
 * the unit test.
 */

// Operator-frozen global oracle from `performance_policy.metric_instance_set_sha256`.
export const LOCKED_METRIC_INSTANCE_SET_SHA256 =
  "399d88f018db7448b660e75e8128b94c6af9e69b307e7dc8b60923b34304d414"; // pragma: allowlist secret
// Operator-frozen from `performance_policy.expected_metric_instance_count`.
export const LOCKED_METRIC_INSTANCE_COUNT = 96;
export const PERFORMANCE_POLICY_FROZEN_AT = "2026-07-11T13:34:32Z";

// Operator-frozen statistics policy from `performance_policy.statistics`. These are
// the EXACT R7 recompute constants (quantile_algorithm=linear_r7, seeded percentile
// bootstrap, confidence 0.95, 10000 iterations, max relative CI width 0.15). Pinned
// here as locked constants so a caller can NEVER weaken them (fewer iterations / a
// looser CI cap / a non-R7 quantile) — a weakened estimator is a false green.
export const LOCKED_STATISTICS_POLICY = Object.freeze({
  quantile_algorithm: "linear_r7",
  confidence_level: 0.95,
  ci_algorithm: "percentile_bootstrap",
  bootstrap_seed: 20260711,
  bootstrap_iterations: 10000,
  maximum_relative_ci_width: 0.15,
  gate_uses_p95_ci_upper: true,
});

// The EXACT recompute-opts triple actually consumed by the seeded percentile-bootstrap
// estimator (`percentileBootstrapCi` reads `{ seed, iterations, confidence }`). It is
// DERIVED from `LOCKED_STATISTICS_POLICY` (single source of truth), frozen, and
// SELF-AUTHENTICATED against a pinned canonical sha256 below. The report-producing path
// accepts a caller `statsOpts` ONLY if it is byte-for-byte deep-equal to this object
// (no omitted/extra/weakened field). A weakened estimator (fewer iterations => a
// degenerate zero-width CI, a looser confidence, a different seed) is a FALSE GREEN, so
// a drifting `statsOpts` must go RED (LOCKED_STATS_POLICY_DRIFT) BEFORE any report is
// emitted. The pinned sha lets a tamper of THIS constant itself be caught (the guard
// re-derives sha256(canonical(...)) and compares).
export const LOCKED_STATS_RECOMPUTE_OPTS = Object.freeze({
  seed: LOCKED_STATISTICS_POLICY.bootstrap_seed,
  iterations: LOCKED_STATISTICS_POLICY.bootstrap_iterations,
  confidence: LOCKED_STATISTICS_POLICY.confidence_level,
});
// sha256 of the validator-dialect canonical form of LOCKED_STATS_RECOMPUTE_OPTS
// (`{"confidence":0.95,"iterations":10000,"seed":20260711}`). Self-authentication anchor.
export const LOCKED_STATS_RECOMPUTE_OPTS_SHA256 =
  "ae1fa453272a2789f5e754ae8831c94b5bff7441051957892947b213f8ede485"; // pragma: allowlist secret

// The 20 operator-frozen metric-matrix rules (sum of profile_ids = 96 instances).
// Transcribed verbatim from `performance_policy.metric_matrix_rules`.
export const LOCKED_METRIC_MATRIX_RULES = Object.freeze([
  { rule_id: "r-desktop-home-cold", metric_id: "desktop_home_interactive_ms", profile_ids: ["mac-arm64-m1-8g", "mac-x86-intel-8g"], scenario_id: "desktop-home-cold", unit: "milliseconds", p95_budget: 2500, measurement_semantics_id: "sem-desktop-home", expanded_instance_count: 2, expanded_instance_set_sha256: "e2e3efe339d4c7d8c15fdfcba95f80286a505827070b705b481834f2205b3b50" },
  { rule_id: "r-desktop-home-warm", metric_id: "desktop_home_interactive_ms", profile_ids: ["mac-arm64-m1-8g", "mac-x86-intel-8g"], scenario_id: "desktop-home-warm", unit: "milliseconds", p95_budget: 1000, measurement_semantics_id: "sem-desktop-home", expanded_instance_count: 2, expanded_instance_set_sha256: "ba624ca8f72acaecc2cfdd3579552d1190fad14956d00f8003e845615169367a" },
  { rule_id: "r-mobile-home-cold", metric_id: "mobile_home_interactive_ms", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g", "android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "mobile-home-cold", unit: "milliseconds", p95_budget: 3000, measurement_semantics_id: "sem-mobile-home", expanded_instance_count: 6, expanded_instance_set_sha256: "3efa54a5413622f39c0abe2c323213ae2b979a19cc30a3fa38ee04c4b7f0968c" },
  { rule_id: "r-mobile-home-warm", metric_id: "mobile_home_interactive_ms", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g", "android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "mobile-home-warm", unit: "milliseconds", p95_budget: 1200, measurement_semantics_id: "sem-mobile-home", expanded_instance_count: 6, expanded_instance_set_sha256: "93c51b3d6da4c488fc14731fe010c45bf63530ae0d5f00b0f7076896e966e2e9" },
  { rule_id: "r-input-desktop", metric_id: "input_response_ms", profile_ids: ["mac-arm64-m1-8g", "mac-x86-intel-8g"], scenario_id: "desktop-input-warm", unit: "milliseconds", p95_budget: 100, measurement_semantics_id: "sem-input-response", expanded_instance_count: 2, expanded_instance_set_sha256: "86e22f4fc9681a265d9a8040aeaf0a091a9d80ea3f1285eda82e597747f10f9a" },
  { rule_id: "r-input-mobile", metric_id: "input_response_ms", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g", "android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "mobile-input-warm", unit: "milliseconds", p95_budget: 100, measurement_semantics_id: "sem-input-response", expanded_instance_count: 6, expanded_instance_set_sha256: "a0bb54a3a478003077771a50a85059a7d6730bf0e26b105291c1f2e4e19442ab" },
  { rule_id: "r-voice-listen", metric_id: "voice_listen_ready_ms", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g", "android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "voice-constrained-fair", unit: "milliseconds", p95_budget: 500, measurement_semantics_id: "sem-voice-listen", expanded_instance_count: 6, expanded_instance_set_sha256: "7704fb4bafa7d1d21cca081578473a7111522ca85445f521890aa8c93ca905f2" },
  { rule_id: "r-voice-transcript", metric_id: "voice_transcript_first_token_ms", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g", "android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "voice-constrained-fair", unit: "milliseconds", p95_budget: 1200, measurement_semantics_id: "sem-voice-transcript", expanded_instance_count: 6, expanded_instance_set_sha256: "7074beb19537b19b0426bf15f0acf31b94d14f0f88f5f459e27d9adb869ee9ec" },
  { rule_id: "r-voice-answer", metric_id: "voice_first_answer_ms", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g", "android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "voice-constrained-fair", unit: "milliseconds", p95_budget: 4000, measurement_semantics_id: "sem-voice-answer", expanded_instance_count: 6, expanded_instance_set_sha256: "7caa2c5865e7e3eadbe5994d9388c65136ec81fd056430fe071c7af1c1526627" },
  { rule_id: "r-voice-tts", metric_id: "voice_tts_first_audio_ms", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g", "android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "voice-constrained-fair", unit: "milliseconds", p95_budget: 1200, measurement_semantics_id: "sem-voice-tts", expanded_instance_count: 6, expanded_instance_set_sha256: "04ebe66fc7f026f3c779d66ade4441d8731bb1dc22a433e15606b98c8a122621" },
  { rule_id: "r-voice-cpu", metric_id: "voice_cpu_percent", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g", "android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "voice-energy-5m", unit: "percent", p95_budget: 60, measurement_semantics_id: "sem-voice-cpu", expanded_instance_count: 6, expanded_instance_set_sha256: "1c2059bb4f1bc65c8b153bac95da794bdbc04d423f540b79f70d00157578b634" },
  { rule_id: "r-voice-memory-apple", metric_id: "voice_memory_mb", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g"], scenario_id: "voice-energy-5m", unit: "mebibytes", p95_budget: 250, measurement_semantics_id: "sem-voice-memory", expanded_instance_count: 3, expanded_instance_set_sha256: "ca4b7841f4856371a5560f375e96740b9c9e062feb2c537091edf1663fbf164c" },
  { rule_id: "r-voice-memory-android", metric_id: "voice_memory_mb", profile_ids: ["android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "voice-energy-5m", unit: "mebibytes", p95_budget: 300, measurement_semantics_id: "sem-voice-memory", expanded_instance_count: 3, expanded_instance_set_sha256: "183888676b808539b2e43119f21c8586ba5185e1566f9d024c4b3b1b6c1ff6e5" },
  { rule_id: "r-voice-energy", metric_id: "voice_energy_mwh", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g", "android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "voice-energy-5m", unit: "milliwatt_hours", p95_budget: 50, measurement_semantics_id: "sem-voice-energy", expanded_instance_count: 6, expanded_instance_set_sha256: "f22e80bcbd77905087fb419612f418791629f5789b162fa23128c57d66bdefff" },
  { rule_id: "r-share-preview", metric_id: "share_system_select_to_preview_ms", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g", "android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "share-max-input", unit: "milliseconds", p95_budget: 1500, measurement_semantics_id: "sem-share-preview", expanded_instance_count: 6, expanded_instance_set_sha256: "c29b0afa9e5dae425bffbf9767b1be559393d3436fa3b64fd553c1c60fb2038a" },
  { rule_id: "r-share-memory-apple", metric_id: "share_extension_peak_memory_mb", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g"], scenario_id: "share-max-input", unit: "mebibytes", p95_budget: 80, measurement_semantics_id: "sem-share-memory", expanded_instance_count: 3, expanded_instance_set_sha256: "0de44a500614f67fee1679ea1e9c1cdc0e4bd5def02a64e71a668fa2f524a39b" },
  { rule_id: "r-share-memory-android", metric_id: "share_extension_peak_memory_mb", profile_ids: ["android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "share-max-input", unit: "mebibytes", p95_budget: 128, measurement_semantics_id: "sem-share-memory", expanded_instance_count: 3, expanded_instance_set_sha256: "6a9041be6ffc03299c7fa6780353f6d33c98709ae90f6dc0f76b518c74900eb9" },
  { rule_id: "r-share-handoff", metric_id: "share_handoff_ms", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g", "android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "share-max-input", unit: "milliseconds", p95_budget: 1000, measurement_semantics_id: "sem-share-handoff", expanded_instance_count: 6, expanded_instance_set_sha256: "a8309d11687ac9e43f8607a5d5ca1bcfde9089f7070d5c54fb0eb170fcc30363" },
  { rule_id: "r-share-processing", metric_id: "share_attachment_processing_ms", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g", "android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "share-max-input", unit: "milliseconds", p95_budget: 5000, measurement_semantics_id: "sem-share-processing", expanded_instance_count: 6, expanded_instance_set_sha256: "540121692427c4ab6b8c5c6fc270e945b8aa09f37abb9aa9b4322e65917f09bb" },
  { rule_id: "r-share-cleanup", metric_id: "share_cleanup_ms", profile_ids: ["ios-iphone-xr-a12-3g", "ios-iphone-se2-a13-3g", "ipados-ipad8-a12-3g", "android-api24-arm64-2g", "android-api24-armv7-2g", "android-api36-arm64-4g"], scenario_id: "share-max-input", unit: "milliseconds", p95_budget: 1000, measurement_semantics_id: "sem-share-cleanup", expanded_instance_count: 6, expanded_instance_set_sha256: "9411eb4ceb5d54938ef829c7833e3df5d3c1a037acb73bf3a7fb8d1f1092be98" },
]);
