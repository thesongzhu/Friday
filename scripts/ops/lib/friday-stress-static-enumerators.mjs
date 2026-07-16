#!/usr/bin/env node
/**
 * friday-stress-static-enumerators.mjs
 *
 * TEST-STRESS-AUTHORITY-ADAPTER-001 (R13 EXHAUSTIVE-STRESS) — SR1.
 *
 * The seven REAL static enumerators (S_static / D_runtime / A_artifact /
 * L_ledger / S_ui / R_ui / C_ui) plus the per-coverage-class discovery loci that
 * derive the R13 stress subject inventory FROM REAL SOURCES — never from a
 * hardcoded subject list (that would be the forbidden "self-authored JSON /
 * producer-only oracle", overlay `anti_false_green[0]`).
 *
 * Each coverage class binds to a locus that reads real bytes (repo static code
 * surfaces, or the declared R13 stress overlay). A locus that yields ZERO
 * members is a hard error in the adapter (proves subjects are DERIVED). The
 * canonicalization mirrors the R13 evidence validator BYTE-FOR-BYTE
 * (`tools/verify-endbar-stress-evidence-r13.mjs:8-9`).
 *
 * This module proves NOTHING on its own: it is a static enumeration substrate,
 * not the R13 final authority and not the fixture validator.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// --- Canonicalization mirrored BYTE-FOR-BYTE from the R13 evidence validator. ---
export const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
export const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(",")}}`
      : JSON.stringify(value);
export const digestOf = (value) => sha(Buffer.from(canonical(value)));

export const OVERLAY_REL = "FRIDAY_ENDBAR_R13_STRESS_OVERLAY.json";

// Declared lifecycle/reachable-state model (the R12 seed corpus lifecycle states
// reused as the R13 subject reachable-state denominator).
export const LIFECYCLE_STATES = [
  "empty",
  "loading",
  "error+retry",
  "offline-stale-no-network",
  "permission-denied-fail-closed-503",
  "success",
];

// The canonical mechanism ledger (the 19 mechanisms + Smart Queue/Watch) — the
// declared L_ledger family model.
export const CANONICAL_MECHANISMS = [
  "intake_mission",
  "by_strength_routing",
  "execution_agent_run",
  "verification_proof",
  "memory_confirm_recall",
  "approval_gate",
  "trust_grant_dial",
  "context_passport",
  "audit_hash_chain",
  "token_metering",
  "skills",
  "provider_workspace",
  "channels",
  "voice",
  "pairing_device_trust",
  "needs_me_activity",
  "crash_recovery",
  "smart_queue",
  "smart_watch",
];

export function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function readText(absPath) {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return "";
  }
}

function walk(root, predicate = () => true) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let stats;
    try {
      stats = fs.statSync(current);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        if (["node_modules", ".git", "dist", "coverage", "target"].includes(entry)) continue;
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (stats.isFile() && predicate(current)) out.push(current);
  }
  return out.sort();
}

function toRel(root, absPath) {
  return path.relative(root, absPath).split(path.sep).join("/");
}

/** Content-addressed ref for one real repo file, path prefixed `repo/`. */
function repoFileRef(repoRoot, absPath) {
  const bytes = fs.readFileSync(absPath);
  return { path: `repo/${toRel(repoRoot, absPath)}`, sha256: sha(bytes), bytes: bytes.length };
}

/** Enumerate real repo files under a relative dir (bounded; sorted, deterministic). */
function repoFiles(repoRoot, relDir, predicate) {
  return walk(path.join(repoRoot, relDir), predicate).map((abs) => ({ abs, ref: repoFileRef(repoRoot, abs) }));
}

function normalizeEndpoint(raw) {
  return raw.replace(/\$\{[^}]+\}/g, ":param").replace(/`/g, "");
}

function normalizeUiRoute(route) {
  if (!route || route === "/") return "/";
  return route.startsWith("/") ? route : `/${route}`;
}

function extractRustEnumBody(source, enumName) {
  const startMatch = new RegExp(`pub\\s+enum\\s+${enumName}\\s*\\{`).exec(source);
  if (!startMatch) return "";
  const bodyStart = startMatch.index + startMatch[0].length;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index);
    }
  }
  return "";
}

// --- Repo-static extractors (return { members, sources }). --------------------

export function extractHttpRoutes(repoRoot, relDir = "src/api/http/routes") {
  const files = repoFiles(repoRoot, relDir, (f) => f.endsWith(".ts"));
  const members = [];
  for (const { abs } of files) {
    const text = readText(abs);
    for (const m of text.matchAll(/method:\s*["']([A-Z]+)["'][\s\S]{0,220}?path:\s*["']([^"']+)["']/g)) {
      members.push(`${m[1]} ${m[2]}`);
    }
  }
  return { members: unique(members), sources: files.map((f) => f.ref) };
}

export function extractSealedWsMessages(repoRoot, rel = "rust-core/crates/friday-protocol/src/lib.rs") {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return { members: [], sources: [] };
  const body = extractRustEnumBody(readText(abs), "Message");
  const variants = [];
  for (const line of body.split("\n")) {
    const m = line.trim().match(/^([A-Z][A-Za-z0-9_]+)\b/);
    if (m) variants.push(m[1]);
  }
  return { members: unique(variants), sources: [repoFileRef(repoRoot, abs)] };
}

export function extractUiRoutes(repoRoot, rel = "ui/src/router.tsx") {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return { members: [], sources: [] };
  const text = readText(abs);
  const routes = [];
  for (const m of text.matchAll(/\bpath:\s*["']([^"']+)["']/g)) routes.push(normalizeUiRoute(m[1]));
  if (text.includes("index: true")) routes.push("/");
  return { members: unique(routes), sources: [repoFileRef(repoRoot, abs)] };
}

export function extractUiApiCalls(repoRoot, relDir = "ui/src") {
  const files = repoFiles(repoRoot, relDir, (f) => /\.(ts|tsx)$/.test(f));
  const pattern = /["`]((?:\/v1\/)[^"`'${}\s)]+(?:\$\{[^}]+\}[^"`'\s)]*)*)["`]/g;
  const members = [];
  for (const { abs } of files) {
    for (const m of readText(abs).matchAll(pattern)) members.push(normalizeEndpoint(m[1]));
  }
  return { members: unique(members), sources: files.map((f) => f.ref) };
}

export function extractNativeScreens(repoRoot, relDir, exts) {
  const files = repoFiles(repoRoot, relDir, (f) => exts.some((e) => f.endsWith(e)));
  return { members: unique(files.map((f) => path.basename(f.abs))), sources: files.map((f) => f.ref) };
}

export function extractCrateSurface(repoRoot, crateRel) {
  const files = repoFiles(repoRoot, crateRel, (f) => f.endsWith(".rs"));
  return { members: unique(files.map((f) => toRel(repoRoot, f.abs))), sources: files.map((f) => f.ref) };
}

// --- Overlay-declared locus: the coverage class is a DECLARED release-required
// obligation in the R13 overlay; the subject represents it, scoped by the
// declared platform_scope. Real declared bytes → real (small) enumeration. -----
function overlayCoverageLocus(coverageClass, platformScopeKey) {
  return (ctx) => {
    const declared = ctx.overlay?.runtime_evidence_bundle_contract?.minimum_coverage_classes ?? [];
    const members = [];
    if (Array.isArray(declared) && declared.includes(coverageClass)) {
      members.push(`declared_coverage_class:${coverageClass}`);
    }
    const scope = ctx.overlay?.platform_scope?.[platformScopeKey];
    if (Array.isArray(scope)) for (const s of scope) members.push(`${platformScopeKey}:${s}`);
    return { members: unique(members), sources: [ctx.overlayRef], resolution_basis: "overlay_declared" };
  };
}

function repoLocus(fn, resolutionBasis = "repo_static") {
  return (ctx) => {
    const { members, sources } = fn(ctx.repoRoot);
    return { members, sources, resolution_basis: resolutionBasis };
  };
}

// --- The 21 coverage classes → { authority, subject_kind, risk, platform_ids,
// mechanism_ids, control_ids, locus }. authority ∈ the 7 declared kinds; every
// kind is used at least once; the map partitions all 21 classes across kinds. --
export const CLASS_SPEC = {
  // S_static — real static backend/code discovery.
  http: { authority: "S_static", subject_kind: "node", risk: "high", platform_ids: ["hub"], mechanism_ids: [], control_ids: [], locus: repoLocus((r) => extractHttpRoutes(r)) },
  websocket_sse: { authority: "S_static", subject_kind: "node", risk: "high", platform_ids: ["hub"], mechanism_ids: [], control_ids: [], locus: repoLocus((r) => extractSealedWsMessages(r)) },
  cli_ipc_ffi: { authority: "S_static", subject_kind: "node", risk: "medium", platform_ids: ["hub"], mechanism_ids: [], control_ids: [], locus: repoLocus((r) => extractCrateSurface(r, "rust-core/crates/friday-ffi")) },
  database_storage: { authority: "S_static", subject_kind: "node", risk: "critical", platform_ids: ["hub"], mechanism_ids: [], control_ids: [], locus: repoLocus((r) => extractCrateSurface(r, "rust-core/crates/friday-storage")) },
  remote_network: { authority: "S_static", subject_kind: "edge", risk: "high", platform_ids: ["hub"], mechanism_ids: [], control_ids: [], locus: repoLocus((r) => extractCrateSurface(r, "rust-core/crates/friday-system-remote")) },

  // D_runtime — declared runtime profiles / runtime code seams.
  exec_sandbox: { authority: "D_runtime", subject_kind: "node", risk: "high", platform_ids: ["hub"], mechanism_ids: ["execution_agent_run"], control_ids: [], locus: repoLocus((r) => extractCrateSurface(r, "rust-core/crates/friday-core")) },
  job_timer_os_event: { authority: "D_runtime", subject_kind: "os_entry", risk: "medium", platform_ids: ["hub"], mechanism_ids: ["needs_me_activity", "smart_watch"], control_ids: [], locus: overlayCoverageLocus("job_timer_os_event", "web") },

  // A_artifact — exact artifact/runtime roles.
  install_release: { authority: "A_artifact", subject_kind: "release_path", risk: "critical", platform_ids: ["desktop", "ios", "android", "ipad"], mechanism_ids: [], control_ids: [], locus: overlayCoverageLocus("install_release", "desktop") },

  // L_ledger — mechanism ledger families.
  provider: { authority: "L_ledger", subject_kind: "edge", risk: "critical", platform_ids: ["hub"], mechanism_ids: ["provider_workspace"], control_ids: [], locus: repoLocus((r) => extractCrateSurface(r, "rust-core/crates/friday-providers")) },
  telegram: { authority: "L_ledger", subject_kind: "edge", risk: "medium", platform_ids: ["hub"], mechanism_ids: ["channels"], control_ids: [], locus: repoLocus((r) => extractHttpRoutes(r, "src/api/http/routes")) },
  plugin_skill_mcp: { authority: "L_ledger", subject_kind: "node", risk: "medium", platform_ids: ["hub"], mechanism_ids: ["skills"], control_ids: [], locus: overlayCoverageLocus("plugin_skill_mcp", "web") },
  voice: { authority: "L_ledger", subject_kind: "control", risk: "high", platform_ids: ["ios", "android"], mechanism_ids: ["voice"], control_ids: ["control:voice"], locus: repoLocus((r) => extractCrateSurface(r, "rust-core/crates/friday-tts")) },
  data_lifecycle: { authority: "L_ledger", subject_kind: "lifecycle", risk: "critical", platform_ids: ["hub"], mechanism_ids: ["memory_confirm_recall", "crash_recovery"], control_ids: [], locus: overlayCoverageLocus("data_lifecycle", "web") },

  // S_ui — static UI surfaces.
  desktop_ui: { authority: "S_ui", subject_kind: "control", risk: "high", platform_ids: ["desktop"], mechanism_ids: [], control_ids: ["control:desktop_route"], locus: repoLocus((r) => extractUiRoutes(r)) },
  ios_ui: { authority: "S_ui", subject_kind: "control", risk: "high", platform_ids: ["ios"], mechanism_ids: [], control_ids: ["control:ios_screen"], locus: repoLocus((r) => extractNativeScreens(r, "apps/friday-ios", [".swift"])) },
  android_ui: { authority: "S_ui", subject_kind: "control", risk: "high", platform_ids: ["android"], mechanism_ids: [], control_ids: ["control:android_screen"], locus: repoLocus((r) => extractNativeScreens(r, "apps/friday-android", [".kt", ".java", ".xml"])) },
  ipad_ui: { authority: "S_ui", subject_kind: "control", risk: "medium", platform_ids: ["ipad"], mechanism_ids: [], control_ids: ["control:ipad_surface"], locus: overlayCoverageLocus("ipad_ui", "ipad") },

  // R_ui — runtime UI call-sites.
  share: { authority: "R_ui", subject_kind: "control", risk: "high", platform_ids: ["ios", "android"], mechanism_ids: [], control_ids: ["control:share_sheet"], locus: overlayCoverageLocus("share", "ios") },
  notification_deeplink: { authority: "R_ui", subject_kind: "transition", risk: "medium", platform_ids: ["ios", "android"], mechanism_ids: [], control_ids: ["control:deeplink"], locus: overlayCoverageLocus("notification_deeplink", "android") },

  // C_ui — contract-declared UI controls.
  approval: { authority: "C_ui", subject_kind: "transition", risk: "critical", platform_ids: ["desktop", "ios", "android"], mechanism_ids: ["approval_gate"], control_ids: ["control:approval"], locus: overlayCoverageLocus("approval", "ios") },
  auth_owner: { authority: "C_ui", subject_kind: "transition", risk: "critical", platform_ids: ["desktop", "hub"], mechanism_ids: ["trust_grant_dial"], control_ids: ["control:owner_auth"], locus: repoLocus((r) => extractHttpRoutes(r, "src/api/http/routes")) },
};

export function implementedCoverageClasses() {
  return Object.keys(CLASS_SPEC).sort();
}

export function implementedAuthorityKinds() {
  return unique(Object.values(CLASS_SPEC).map((s) => s.authority));
}

// --- D_runtime / A_artifact declared enumerators (feed the runtime/artifact
// denominators + the subject profile_ids/artifact_role_ids). --------------------
export function runtimeProfilesEnumerator(overlay, overlayRef) {
  const ps = overlay?.platform_scope ?? {};
  const im = overlay?.interaction_minimums ?? {};
  const profiles = [];
  for (const k of Object.keys(ps).sort()) profiles.push(`runtime_profile:${k}`);
  for (const k of Object.keys(im).sort()) if (k !== "classification") profiles.push(`interaction_floor:${k}`);
  return {
    profiles: unique(profiles),
    sources: [overlayRef],
    value: {
      platform_scope_keys: Object.keys(ps).sort(),
      interaction_floor_keys: Object.keys(im).filter((k) => k !== "classification").sort(),
    },
  };
}

export function artifactRolesEnumerator(overlay, overlayRef) {
  const arts = overlay?.required_runtime_artifacts ?? [];
  const ps = overlay?.platform_scope ?? {};
  const roles = [];
  for (const a of Array.isArray(arts) ? arts : []) roles.push(`artifact_role:${a}`);
  for (const k of Object.keys(ps).sort()) roles.push(`platform_artifact:${k}`);
  return {
    roles: unique(roles),
    sources: [overlayRef],
    value: {
      required_runtime_artifacts: Array.isArray(arts) ? [...arts].sort() : [],
      platform_scope_keys: Object.keys(ps).sort(),
    },
  };
}
