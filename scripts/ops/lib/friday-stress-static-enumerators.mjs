#!/usr/bin/env node
/**
 * friday-stress-static-enumerators.mjs
 *
 * TEST-STRESS-AUTHORITY-ADAPTER-001 (R13 EXHAUSTIVE-STRESS) — SR1.
 *
 * OPEN-WORLD static discovery substrate. Each authority independently enumerates
 * EVERY release-required member it can observe (each route, message, screen,
 * crate surface) — NOT one collapsed row per coverage class. Every discovered
 * member becomes its own subject downstream.
 *
 * HONESTY BOUNDARY (why this is a PROVISIONAL adapter):
 *  - Discovery here is static PROXY discovery (regex over real bytes, or a
 *    declared-overlay placeholder). It is NOT AST / build-graph / runtime route
 *    registration / artifact-manifest / mechanism-ledger discovery. Every member
 *    therefore carries `discovery_sealed: false` and a `resolution_basis`. A
 *    class with NO real discovery input yet emits an explicit "PROVISIONAL"
 *    member (never a silent one-per-class collapse).
 *  - `completeSourceManifest` binds the COMPLETE candidate source tree (git tree
 *    identity + full working-tree file manifest) — this is the one exact,
 *    genuinely SEALED binding. Adding ANY source file changes it.
 *
 * Canonicalization mirrors the R13 evidence validator BYTE-FOR-BYTE
 * (`tools/verify-endbar-stress-evidence-r13.mjs:8-9`).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

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
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "target", ".turbo", ".next"]);

export const LIFECYCLE_STATES = [
  "empty", "loading", "error+retry", "offline-stale-no-network",
  "permission-denied-fail-closed-503", "success",
];

export const CANONICAL_MECHANISMS = [
  "intake_mission", "by_strength_routing", "execution_agent_run", "verification_proof",
  "memory_confirm_recall", "approval_gate", "trust_grant_dial", "context_passport",
  "audit_hash_chain", "token_metering", "skills", "provider_workspace", "channels", "voice",
  "pairing_device_trust", "needs_me_activity", "crash_recovery", "smart_queue", "smart_watch",
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
      stats = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        if (IGNORED_DIRS.has(entry)) continue;
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

function repoFileRef(repoRoot, absPath) {
  const bytes = fs.readFileSync(absPath);
  return { path: `repo/${toRel(repoRoot, absPath)}`, sha256: sha(bytes), bytes: bytes.length };
}

function repoFiles(repoRoot, relDir, predicate) {
  return walk(path.join(repoRoot, relDir), predicate).map((abs) => ({ abs, rel: toRel(repoRoot, abs), ref: repoFileRef(repoRoot, abs) }));
}

// --- F2: COMPLETE source identity (git tree oid + full working-tree manifest). --
// NOT a class-loci subset: adding ANY source file flips the digest.
export function completeSourceManifest(repoRoot) {
  let gitTreeOid = null;
  try {
    const r = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" });
    if (r.status === 0 && /^[0-9a-f]{40}$/.test((r.stdout || "").trim())) gitTreeOid = r.stdout.trim();
  } catch {
    gitTreeOid = null;
  }
  const files = walk(repoRoot).map((abs) => {
    const bytes = fs.readFileSync(abs);
    return { path: toRel(repoRoot, abs), sha256: sha(bytes), bytes: bytes.length };
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const value = { git_tree_oid: gitTreeOid, file_count: files.length, files };
  return { basis: "git_tree_and_full_working_manifest", git_tree_oid: gitTreeOid, file_count: files.length, digest: digestOf(value) };
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

// --- Open-world member extractors. Each returns { members: string[], source_refs }.
// F1 counterexample #2: order-independent — a `path:` written BEFORE `method:` is
// still discovered (member identity is the route path itself).
function httpRouteMembers(repoRoot, relDir) {
  const files = repoFiles(repoRoot, relDir, (f) => f.endsWith(".ts"));
  const members = [];
  for (const { abs } of files) {
    for (const m of readText(abs).matchAll(/\bpath:\s*["'`]([^"'`]+)["'`]/g)) members.push(m[1]);
  }
  return { members: unique(members), source_refs: files.map((f) => f.ref) };
}

function httpRouteMembersFiltered(repoRoot, relDir, fileNameRe) {
  const files = repoFiles(repoRoot, relDir, (f) => f.endsWith(".ts") && fileNameRe.test(path.basename(f)));
  const members = [];
  for (const { abs } of files) {
    for (const m of readText(abs).matchAll(/\bpath:\s*["'`]([^"'`]+)["'`]/g)) members.push(m[1]);
  }
  return { members: unique(members), source_refs: files.map((f) => f.ref) };
}

function wsMessageMembers(repoRoot) {
  const rel = "rust-core/crates/friday-protocol/src/lib.rs";
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return { members: [], source_refs: [] };
  const body = extractRustEnumBody(readText(abs), "Message");
  const members = [];
  for (const line of body.split("\n")) {
    const m = line.trim().match(/^([A-Z][A-Za-z0-9_]+)\b/);
    if (m) members.push(m[1]);
  }
  return { members: unique(members), source_refs: [repoFileRef(repoRoot, abs)] };
}

function uiRouteMembers(repoRoot) {
  const rel = "ui/src/router.tsx";
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return { members: [], source_refs: [] };
  const text = readText(abs);
  const routes = [];
  for (const m of text.matchAll(/\bpath:\s*["'`]([^"'`]+)["'`]/g)) routes.push(normalizeUiRoute(m[1]));
  if (text.includes("index: true")) routes.push("/");
  return { members: unique(routes), source_refs: [repoFileRef(repoRoot, abs)] };
}

function nativeScreenMembers(repoRoot, relDir, exts) {
  const files = repoFiles(repoRoot, relDir, (f) => exts.some((e) => f.endsWith(e)));
  return { members: unique(files.map((f) => path.basename(f.abs))), source_refs: files.map((f) => f.ref) };
}

function crateFileMembers(repoRoot, crateRel) {
  const files = repoFiles(repoRoot, crateRel, (f) => f.endsWith(".rs"));
  return { members: unique(files.map((f) => f.rel)), source_refs: files.map((f) => f.ref) };
}

// A declared class with NO real discovery input yet: emit an EXPLICIT provisional
// member (never a silent collapse), evidenced by the overlay bytes.
function provisionalDeclared(coverageClass) {
  return (ctx) => ({
    members: [`PROVISIONAL:${coverageClass}`],
    source_refs: [ctx.overlayRef],
    resolution_basis: "overlay_declared_placeholder_no_real_discovery_input",
  });
}

function repoStatic(fn) {
  return (ctx) => {
    const { members, source_refs } = fn(ctx.repoRoot);
    return { members, source_refs, resolution_basis: "repo_static_regex_proxy" };
  };
}

// coverage_class -> { authority, subject_kind, risk, platform_ids, mechanism_ids,
// control_ids, discover }. Every discover() is a static PROXY (discovery is
// never sealed here — see HONESTY BOUNDARY above).
export const CLASS_SPEC = {
  http: { authority: "S_static", subject_kind: "node", risk: "high", platform_ids: ["hub"], mechanism_ids: [], control_ids: [], discover: repoStatic((r) => httpRouteMembers(r, "src/api/http/routes")) },
  websocket_sse: { authority: "S_static", subject_kind: "node", risk: "high", platform_ids: ["hub"], mechanism_ids: [], control_ids: [], discover: repoStatic((r) => wsMessageMembers(r)) },
  cli_ipc_ffi: { authority: "S_static", subject_kind: "node", risk: "medium", platform_ids: ["hub"], mechanism_ids: [], control_ids: [], discover: repoStatic((r) => crateFileMembers(r, "rust-core/crates/friday-ffi")) },
  database_storage: { authority: "S_static", subject_kind: "node", risk: "critical", platform_ids: ["hub"], mechanism_ids: [], control_ids: [], discover: repoStatic((r) => crateFileMembers(r, "rust-core/crates/friday-storage")) },
  remote_network: { authority: "S_static", subject_kind: "edge", risk: "high", platform_ids: ["hub"], mechanism_ids: [], control_ids: [], discover: repoStatic((r) => crateFileMembers(r, "rust-core/crates/friday-system-remote")) },

  exec_sandbox: { authority: "D_runtime", subject_kind: "node", risk: "high", platform_ids: ["hub"], mechanism_ids: ["execution_agent_run"], control_ids: [], discover: repoStatic((r) => crateFileMembers(r, "rust-core/crates/friday-core")) },
  job_timer_os_event: { authority: "D_runtime", subject_kind: "os_entry", risk: "medium", platform_ids: ["hub"], mechanism_ids: ["needs_me_activity", "smart_watch"], control_ids: [], discover: provisionalDeclared("job_timer_os_event") },

  install_release: { authority: "A_artifact", subject_kind: "release_path", risk: "critical", platform_ids: ["desktop", "ios", "android", "ipad"], mechanism_ids: [], control_ids: [], discover: provisionalDeclared("install_release") },

  provider: { authority: "L_ledger", subject_kind: "edge", risk: "critical", platform_ids: ["hub"], mechanism_ids: ["provider_workspace"], control_ids: [], discover: repoStatic((r) => crateFileMembers(r, "rust-core/crates/friday-providers")) },
  telegram: { authority: "L_ledger", subject_kind: "edge", risk: "medium", platform_ids: ["hub"], mechanism_ids: ["channels"], control_ids: [], discover: repoStatic((r) => httpRouteMembersFiltered(r, "src/api/http/routes", /channel/i)) },
  plugin_skill_mcp: { authority: "L_ledger", subject_kind: "node", risk: "medium", platform_ids: ["hub"], mechanism_ids: ["skills"], control_ids: [], discover: provisionalDeclared("plugin_skill_mcp") },
  voice: { authority: "L_ledger", subject_kind: "control", risk: "high", platform_ids: ["ios", "android"], mechanism_ids: ["voice"], control_ids: ["control:voice"], discover: repoStatic((r) => crateFileMembers(r, "rust-core/crates/friday-tts")) },
  data_lifecycle: { authority: "L_ledger", subject_kind: "lifecycle", risk: "critical", platform_ids: ["hub"], mechanism_ids: ["memory_confirm_recall", "crash_recovery"], control_ids: [], discover: provisionalDeclared("data_lifecycle") },

  desktop_ui: { authority: "S_ui", subject_kind: "control", risk: "high", platform_ids: ["desktop"], mechanism_ids: [], control_ids: ["control:desktop_route"], discover: repoStatic((r) => uiRouteMembers(r)) },
  ios_ui: { authority: "S_ui", subject_kind: "control", risk: "high", platform_ids: ["ios"], mechanism_ids: [], control_ids: ["control:ios_screen"], discover: repoStatic((r) => nativeScreenMembers(r, "apps/friday-ios", [".swift"])) },
  android_ui: { authority: "S_ui", subject_kind: "control", risk: "high", platform_ids: ["android"], mechanism_ids: [], control_ids: ["control:android_screen"], discover: repoStatic((r) => nativeScreenMembers(r, "apps/friday-android", [".kt", ".java", ".xml"])) },
  ipad_ui: { authority: "S_ui", subject_kind: "control", risk: "medium", platform_ids: ["ipad"], mechanism_ids: [], control_ids: ["control:ipad_surface"], discover: provisionalDeclared("ipad_ui") },

  share: { authority: "R_ui", subject_kind: "control", risk: "high", platform_ids: ["ios", "android"], mechanism_ids: [], control_ids: ["control:share_sheet"], discover: provisionalDeclared("share") },
  notification_deeplink: { authority: "R_ui", subject_kind: "transition", risk: "medium", platform_ids: ["ios", "android"], mechanism_ids: [], control_ids: ["control:deeplink"], discover: provisionalDeclared("notification_deeplink") },

  approval: { authority: "C_ui", subject_kind: "transition", risk: "critical", platform_ids: ["desktop", "ios", "android"], mechanism_ids: ["approval_gate"], control_ids: ["control:approval"], discover: provisionalDeclared("approval") },
  auth_owner: { authority: "C_ui", subject_kind: "transition", risk: "critical", platform_ids: ["desktop", "hub"], mechanism_ids: ["trust_grant_dial"], control_ids: ["control:owner_auth"], discover: repoStatic((r) => httpRouteMembersFiltered(r, "src/api/http/routes", /auth|owner/i)) },
};

export function implementedCoverageClasses() {
  return Object.keys(CLASS_SPEC).sort();
}

export function implementedAuthorityKinds() {
  return unique(Object.values(CLASS_SPEC).map((s) => s.authority));
}

// --- F2: runtime profile bound to FULL declared content (values, not key names).
// Declared, NOT runtime-observed -> provisional.
export function runtimeProfileValue(overlay) {
  return {
    platform_scope: overlay?.platform_scope ?? null,
    interaction_minimums: overlay?.interaction_minimums ?? null,
    performance_preservation: overlay?.performance_preservation ?? null,
    host_safety: overlay?.host_safety ?? null,
  };
}

// --- F2: artifact set bound to the ACTUAL required-artifact schema BYTES.
// Schemas, NOT built binaries -> provisional.
export function artifactSchemaValue(overlay, sourcesRoot) {
  const arts = Array.isArray(overlay?.required_runtime_artifacts) ? overlay.required_runtime_artifacts : [];
  const schemas = [];
  for (const artifact of [...arts].sort()) {
    const m = /^FRIDAY_STRESS_([A-Z_]+)\.json$/.exec(artifact);
    if (!m) return { error: "UNEXPECTED_ARTIFACT_NAME", artifact };
    const rel = `schemas/endbar-stress-${m[1].toLowerCase().replace(/_/g, "-")}-r13.schema.json`;
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(sourcesRoot, rel));
    } catch (error) {
      return { error: "ARTIFACT_SCHEMA_MISSING", artifact, path: rel, detail: error.code || String(error) };
    }
    schemas.push({ artifact, path: rel, sha256: sha(bytes), bytes: bytes.length });
  }
  return { value: { required_runtime_artifacts: [...arts].sort(), schemas } };
}
