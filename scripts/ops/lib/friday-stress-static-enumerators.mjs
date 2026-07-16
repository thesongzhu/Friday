#!/usr/bin/env node
/**
 * friday-stress-static-enumerators.mjs
 *
 * TEST-STRESS-AUTHORITY-ADAPTER-001 (R13 EXHAUSTIVE-STRESS) — SR1.
 *
 * OPEN-WORLD static discovery with OPERATION identity. Each authority enumerates
 * every release-required member it can observe; HTTP routes carry METHOD+PATH
 * (+operationId) identity, so GET vs POST on the same path are DISTINCT subjects
 * (round-2 defect: path-only dedup collapsed 600 route×method declarations to
 * 512 paths — fixed here).
 *
 * INDEPENDENT RECONCILIATION: the HTTP definition lens (per-route-object parse of
 * `src/api/http/routes/*.ts`) is reconciled against a GENUINELY INDEPENDENT
 * second lens — the CI-enforced API route CONTRACT SNAPSHOT
 * (`test/contracts/api/__snapshots__/friday-api-route-contract.snapshot.test.ts.snap`),
 * which is produced by the real runtime registry (`createFridayApiRuntime`), a
 * separate code path. Definition-vs-contract drift is a real, non-circular
 * signal (NOT two regroupings of the same generated list). Coverage classes with
 * NO independent second source have reconciliation `available:false` and are
 * marked provisional.
 *
 * HONESTY BOUNDARY: discovery is still static (regex per-route-object + declared
 * overlay); it is not a full TypeScript AST, runtime route registration probe,
 * built-artifact manifest, or mechanism ledger. The independent contract lens is
 * the mitigation, not a substitute. `sourceProvenance` binds the COMPLETE
 * candidate tree (git tree oid + full working-tree manifest) but seals it ONLY
 * for a real git repo at the EXACT expected HEAD with a clean worktree and no
 * symlink/special entry — otherwise it is provisional-unsealed.
 *
 * Canonicalization mirrors the R13 validator BYTE-FOR-BYTE (verify-...-r13.mjs:8-9).
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
export const ROUTE_CONTRACT_SNAPSHOT_REL =
  "test/contracts/api/__snapshots__/friday-api-route-contract.snapshot.test.ts.snap";
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "target", ".turbo", ".next"]);

export const LIFECYCLE_STATES = [
  "empty", "loading", "error+retry", "offline-stale-no-network",
  "permission-denied-fail-closed-503", "success",
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

// --- F-B: EXACT-candidate source provenance. `sealed` is true ONLY for a real
// git repo, at the exact EXPECTED HEAD sha, with a clean worktree (no dirty
// tracked, no untracked). A non-git root, dirty/untracked worktree, absent or
// mismatched expected sha, or any symlink/special file in the manifest all force
// `sealed:false` (the digest still binds the observed working bytes, but is NOT
// a sealed candidate). `signature` supports mutation detection between the source
// snapshot and the bundle write.
export function sourceProvenance(repoRoot, expectedSha = null) {
  const runGit = (args) => {
    try {
      const r = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
      return { status: r.status, out: (r.stdout || "").trim() };
    } catch {
      return { status: 1, out: "" };
    }
  };
  const treeR = runGit(["rev-parse", "HEAD^{tree}"]);
  const headR = runGit(["rev-parse", "HEAD"]);
  const gitTreeOid = treeR.status === 0 && /^[0-9a-f]{40}$/.test(treeR.out) ? treeR.out : null;
  const headSha = headR.status === 0 && /^[0-9a-f]{40}$/.test(headR.out) ? headR.out : null;
  const isGit = gitTreeOid !== null && headSha !== null;
  let cleanWorktree = false;
  if (isGit) {
    const st = runGit(["status", "--porcelain"]);
    cleanWorktree = st.status === 0 && st.out === "";
  }
  const expectedProvided = typeof expectedSha === "string" && /^[0-9a-f]{7,40}$/.test(expectedSha);
  const expectedMatch = expectedProvided && headSha !== null && (headSha === expectedSha || headSha.startsWith(expectedSha));
  // Dedicated traversal (NOT the shared `walk`, which silently skips symlinks):
  // here a symlink or non-regular file must be OBSERVED so it can force unsealed.
  const files = [];
  let specialSeen = false;
  const stack = [repoRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    let st;
    try {
      st = fs.lstatSync(current);
    } catch {
      specialSeen = true;
      continue;
    }
    if (st.isSymbolicLink()) {
      specialSeen = true;
      continue;
    }
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        if (IGNORED_DIRS.has(entry)) continue;
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (st.isFile()) {
      const bytes = fs.readFileSync(current);
      files.push({ path: toRel(repoRoot, current), sha256: sha(bytes), bytes: bytes.length });
    } else {
      specialSeen = true; // fifo / socket / block / char device
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const digest = digestOf({ git_tree_oid: gitTreeOid, file_count: files.length, files });
  const sealed = isGit && cleanWorktree && expectedProvided && expectedMatch && !specialSeen;
  const unsealed_reasons = [];
  if (!isGit) unsealed_reasons.push("source_root_not_a_git_repository");
  if (isGit && !cleanWorktree) unsealed_reasons.push("source_worktree_dirty_or_untracked_present");
  if (!expectedProvided) unsealed_reasons.push("source_expected_sha_not_provided");
  else if (isGit && !expectedMatch) unsealed_reasons.push("source_head_sha_not_equal_expected");
  if (specialSeen) unsealed_reasons.push("source_manifest_has_symlink_or_special_file");
  return {
    basis: "git_head_verified_full_working_manifest",
    sealed,
    git_tree_oid: gitTreeOid,
    head_sha: headSha,
    clean_worktree: cleanWorktree,
    expected_sha: expectedProvided ? expectedSha : null,
    expected_match: expectedMatch,
    file_count: files.length,
    digest,
    unsealed_reasons,
    signature: `${gitTreeOid}|${headSha}|${cleanWorktree}|${digest}`,
  };
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

// --- HTTP definition lens: per-route-object parse capturing METHOD + PATH +
// operationId + source. Anchored on operationId (always the object's first
// field), method/path extracted from the object window in ANY order. ----------
export function httpRouteObjects(repoRoot, relDir = "src/api/http/routes") {
  const files = repoFiles(repoRoot, relDir, (f) => f.endsWith(".ts"));
  const routes = [];
  const seen = new Set();
  for (const { abs, rel } of files) {
    const t = readText(abs);
    const anchors = [...t.matchAll(/operationId:\s*["'`]([^"'`]+)["'`]/g)];
    for (let i = 0; i < anchors.length; i += 1) {
      const start = anchors[i].index;
      const end = i + 1 < anchors.length ? anchors[i + 1].index : Math.min(t.length, start + 900);
      const win = t.slice(start, end);
      const method = win.match(/method:\s*["'`]([A-Z]+)["'`]/);
      const routePath = win.match(/path:\s*["'`]([^"'`]+)["'`]/);
      if (!method || !routePath) continue;
      const operationId = anchors[i][1];
      const key = `${method[1]} ${routePath[1]}`;
      const dedupe = `${operationId}|${key}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      routes.push({ operationId, method: method[1], path: routePath[1], key, source: `repo/${rel}` });
    }
  }
  routes.sort((a, b) => a.key.localeCompare(b.key) || a.operationId.localeCompare(b.operationId));
  return { routes, source_refs: files.map((f) => f.ref) };
}

// --- Independent contract lens: the CI-enforced API route contract snapshot,
// built by the real runtime registry — a separate code path from the route files.
export function routeContractSnapshot(repoRoot) {
  const abs = path.join(repoRoot, ROUTE_CONTRACT_SNAPSHOT_REL);
  if (!fs.existsSync(abs)) return { available: false, routes: [], ref: null };
  const snap = readText(abs);
  const marker = "captures the full route surface";
  const start = snap.indexOf(marker);
  if (start < 0) return { available: false, routes: [], ref: null };
  const next = snap.indexOf("exports[", start + marker.length);
  const block = snap.slice(start, next < 0 ? undefined : next);
  const routes = [];
  const seen = new Set();
  for (const m of block.matchAll(/\{\s*"authKind":[\s\S]*?\}/g)) {
    const o = m[0];
    const method = o.match(/"method":\s*"([A-Z]+)"/);
    const routePath = o.match(/"path":\s*"([^"]+)"/);
    const operationId = o.match(/"operationId":\s*"([^"]+)"/);
    if (!method || !routePath) continue;
    const key = `${method[1]} ${routePath[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ operationId: operationId ? operationId[1] : null, method: method[1], path: routePath[1], key });
  }
  return { available: true, routes, ref: repoFileRef(repoRoot, abs) };
}

// --- P0-3: reconcile the definition lens against the independent contract lens.
export function reconcileHttpRoutes(defRoutes, contract) {
  if (!contract.available) {
    return { available: false, clean: false, reason: "no_independent_contract_lens", definition_only: [], contract_only: [], confirmed: 0 };
  }
  const defKeys = new Set(defRoutes.map((r) => r.key));
  const conKeys = new Set(contract.routes.map((r) => r.key));
  const definition_only = [...defKeys].filter((k) => !conKeys.has(k)).sort();
  const contract_only = [...conKeys].filter((k) => !defKeys.has(k)).sort();
  return {
    available: true,
    clean: definition_only.length === 0 && contract_only.length === 0,
    definition_only,
    contract_only,
    confirmed: [...defKeys].filter((k) => conKeys.has(k)).length,
  };
}

// --- Other open-world lenses (member identity is already unique per member). ---
export function wsMessageMembers(repoRoot) {
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

export function uiRouteMembers(repoRoot) {
  const rel = "ui/src/router.tsx";
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return { members: [], source_refs: [] };
  const text = readText(abs);
  const routes = [];
  for (const m of text.matchAll(/\bpath:\s*["'`]([^"'`]+)["'`]/g)) routes.push(normalizeUiRoute(m[1]));
  if (text.includes("index: true")) routes.push("/");
  return { members: unique(routes), source_refs: [repoFileRef(repoRoot, abs)] };
}

export function nativeScreenMembers(repoRoot, relDir, exts) {
  const files = repoFiles(repoRoot, relDir, (f) => exts.some((e) => f.endsWith(e)));
  return { members: unique(files.map((f) => path.basename(f.abs))), source_refs: files.map((f) => f.ref) };
}

export function crateFileMembers(repoRoot, crateRel) {
  const files = repoFiles(repoRoot, crateRel, (f) => f.endsWith(".rs"));
  return { members: unique(files.map((f) => f.rel)), source_refs: files.map((f) => f.ref) };
}

function overlayRefEntry(ctx) {
  return ctx.overlayRef;
}

// coverage_class -> spec. `discover(ctx)` returns { members: [{member_id, extra}],
// source_refs, resolution_basis, reconciliation }. All discovery is a static
// proxy (never structurally sealed); `reconciliation.available` is true only for
// classes with a genuinely independent second lens (HTTP contract snapshot).
export const CLASS_SPEC = {
  http: {
    authority: "S_static", subject_kind: "node", risk: "high", platform_ids: ["hub"], mechanism_ids: [], control_ids: [],
    discover: (ctx) => {
      const def = httpRouteObjects(ctx.repoRoot);
      const contract = routeContractSnapshot(ctx.repoRoot);
      const rec = reconcileHttpRoutes(def.routes, contract);
      const members = def.routes.map((r) => ({
        member_id: r.key, // METHOD PATH — GET vs POST are distinct
        operation_id: r.operationId,
        independent_lens: "api_route_contract_snapshot",
        independent_lens_confirmed: contract.available ? contract.routes.some((c) => c.key === r.key) : false,
      }));
      const source_refs = [...def.source_refs, ...(contract.ref ? [contract.ref] : [])];
      return { members, source_refs, resolution_basis: "repo_route_object_lens_reconciled_vs_contract_snapshot", reconciliation: rec };
    },
  },
  websocket_sse: repoStaticClass("S_static", "node", "high", ["hub"], (r) => wsMessageMembers(r)),
  cli_ipc_ffi: repoStaticClass("S_static", "node", "medium", ["hub"], (r) => crateFileMembers(r, "rust-core/crates/friday-ffi")),
  database_storage: repoStaticClass("S_static", "node", "critical", ["hub"], (r) => crateFileMembers(r, "rust-core/crates/friday-storage")),
  remote_network: repoStaticClass("S_static", "edge", "high", ["hub"], (r) => crateFileMembers(r, "rust-core/crates/friday-system-remote")),

  exec_sandbox: repoStaticClass("D_runtime", "node", "high", ["hub"], (r) => crateFileMembers(r, "rust-core/crates/friday-core"), ["execution_agent_run"]),
  job_timer_os_event: provisionalClass("D_runtime", "os_entry", "medium", ["hub"], "job_timer_os_event", ["needs_me_activity", "smart_watch"]),

  install_release: provisionalClass("A_artifact", "release_path", "critical", ["desktop", "ios", "android", "ipad"], "install_release"),

  provider: repoStaticClass("L_ledger", "edge", "critical", ["hub"], (r) => crateFileMembers(r, "rust-core/crates/friday-providers"), ["provider_workspace"]),
  telegram: { authority: "L_ledger", subject_kind: "edge", risk: "medium", platform_ids: ["hub"], mechanism_ids: ["channels"], control_ids: [], discover: httpFilteredClass(/channel/i) },
  plugin_skill_mcp: provisionalClass("L_ledger", "node", "medium", ["hub"], "plugin_skill_mcp", ["skills"]),
  voice: repoStaticClass("L_ledger", "control", "high", ["ios", "android"], (r) => crateFileMembers(r, "rust-core/crates/friday-tts"), ["voice"], ["control:voice"]),
  data_lifecycle: provisionalClass("L_ledger", "lifecycle", "critical", ["hub"], "data_lifecycle", ["memory_confirm_recall", "crash_recovery"]),

  desktop_ui: repoStaticClass("S_ui", "control", "high", ["desktop"], (r) => uiRouteMembers(r), [], ["control:desktop_route"]),
  ios_ui: repoStaticClass("S_ui", "control", "high", ["ios"], (r) => nativeScreenMembers(r, "apps/friday-ios", [".swift"]), [], ["control:ios_screen"]),
  android_ui: repoStaticClass("S_ui", "control", "high", ["android"], (r) => nativeScreenMembers(r, "apps/friday-android", [".kt", ".java", ".xml"]), [], ["control:android_screen"]),
  ipad_ui: provisionalClass("S_ui", "control", "medium", ["ipad"], "ipad_ui", [], ["control:ipad_surface"]),

  share: provisionalClass("R_ui", "control", "high", ["ios", "android"], "share", [], ["control:share_sheet"]),
  notification_deeplink: provisionalClass("R_ui", "transition", "medium", ["ios", "android"], "notification_deeplink", [], ["control:deeplink"]),

  approval: provisionalClass("C_ui", "transition", "critical", ["desktop", "ios", "android"], "approval", ["approval_gate"], ["control:approval"]),
  auth_owner: { authority: "C_ui", subject_kind: "transition", risk: "critical", platform_ids: ["desktop", "hub"], mechanism_ids: ["trust_grant_dial"], control_ids: ["control:owner_auth"], discover: httpFilteredClass(/auth|owner/i) },
};

function repoStaticClass(authority, subject_kind, risk, platform_ids, fn, mechanism_ids = [], control_ids = []) {
  return {
    authority, subject_kind, risk, platform_ids, mechanism_ids, control_ids,
    discover: (ctx) => {
      const { members, source_refs } = fn(ctx.repoRoot);
      return {
        members: members.map((m) => ({ member_id: m, independent_lens: null, independent_lens_confirmed: false })),
        source_refs,
        resolution_basis: "repo_static_regex_proxy",
        reconciliation: { available: false, clean: false, reason: "no_independent_second_lens", definition_only: [], contract_only: [], confirmed: 0 },
      };
    },
  };
}

function httpFilteredClass(fileNameRe) {
  return (ctx) => {
    const { routes, source_refs } = httpRouteObjects(ctx.repoRoot);
    const filtered = routes.filter((r) => fileNameRe.test(path.basename(r.source)));
    return {
      members: filtered.map((r) => ({ member_id: r.key, operation_id: r.operationId, independent_lens: null, independent_lens_confirmed: false })),
      source_refs,
      resolution_basis: "repo_route_object_lens_filtered_provisional",
      reconciliation: { available: false, clean: false, reason: "filtered_subset_no_independent_lens", definition_only: [], contract_only: [], confirmed: 0 },
    };
  };
}

function provisionalClass(authority, subject_kind, risk, platform_ids, coverageClass, mechanism_ids = [], control_ids = []) {
  return {
    authority, subject_kind, risk, platform_ids, mechanism_ids, control_ids,
    discover: (ctx) => ({
      members: [{ member_id: `PROVISIONAL:${coverageClass}`, independent_lens: null, independent_lens_confirmed: false }],
      source_refs: [overlayRefEntry(ctx)],
      resolution_basis: "overlay_declared_placeholder_no_real_discovery_input",
      reconciliation: { available: false, clean: false, reason: "no_real_discovery_input", definition_only: [], contract_only: [], confirmed: 0 },
    }),
  };
}

export function implementedCoverageClasses() {
  return Object.keys(CLASS_SPEC).sort();
}

export function implementedAuthorityKinds() {
  return unique(Object.values(CLASS_SPEC).map((s) => s.authority));
}

// --- F2: runtime profile bound to FULL declared content (declared, not observed). ---
export function runtimeProfileValue(overlay) {
  return {
    platform_scope: overlay?.platform_scope ?? null,
    interaction_minimums: overlay?.interaction_minimums ?? null,
    performance_preservation: overlay?.performance_preservation ?? null,
    host_safety: overlay?.host_safety ?? null,
  };
}

// --- F2: artifact set bound to ACTUAL required-artifact schema BYTES (not binaries). ---
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
