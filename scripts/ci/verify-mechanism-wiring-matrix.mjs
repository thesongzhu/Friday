#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUST_MATRIX = join(REPO_ROOT, "rust-core", "crates", "friday-core", "src", "mechanism_matrix.rs");
const DOC = join(REPO_ROOT, "docs", "ops", "friday-mechanism-wiring-matrix.md");
const TS_MANIFEST = join(REPO_ROOT, "docs", "ops", "ts-runtime-retirement-manifest.json");

const OWNER_STRINGS = {
  RustCore: "rust_core",
  RustHub: "rust_hub",
  RustFfi: "rust_ffi",
  UiShellOnly: "ui_shell_only",
  LegacyOracleOnly: "legacy_oracle_only",
  OperatorExternal: "operator_external",
};

const STATUS_STRINGS = {
  RustOwnedProven: "rust_owned_proven",
  RustOwnedPartial: "rust_owned_partial",
  RustWiredDev: "rust_wired_dev",
  NoGo: "NO-GO",
  OperatorGated: "operator_gated",
  ExternalBlocked: "external_blocked",
  DesignFrozen: "design_frozen",
  LegacyRetireRequired: "legacy_retire_required",
};

const ALLOWED_MUTATION_DEFAULTS = new Set([
  "governed",
  "503-by-default",
  "operator-gated",
  "not-a-product-mutator",
]);

const CRITICAL_TS_FENCES = new Map([
  ["agent_runs_start", "agent_tool_execution"],
  ["workflow_runs_start", "workflow_runtime"],
  ["autofix_execute", "agent_tool_execution"],
  ["skills_run", "skill_capability_advisor_bridge"],
  ["skills_import", "skill_capability_advisor_bridge"],
  ["mcp_server_rpc", "agent_tool_execution"],
]);

const CRITICAL_TS_FENCE_BEHAVIOR_TESTS = new Map([
  ["agent_runs_start", {
    path: "test/unit/api/runtime/friday-api-runtime-rust-route-compose.test.ts",
    includes: [
      "allowTestOnlyAgentRunStartExecution intentionally UNSET",
      "TS_RUNTIME_AGENT_RUNS_RETIRED",
      "httpStatus: 503",
    ],
  }],
  ["workflow_runs_start", {
    path: "test/integration/workflows/friday-workflow-trigger-retirement-guard.test.ts",
    includes: [
      "allowTestOnlyWorkflowRunExecution",
      "TS_RUNTIME_WORKFLOW_RUNS_RETIRED",
      "creates NO run row",
      "expect(runRowCount()).toBe(0)",
    ],
  }],
  ["autofix_execute", {
    path: "test/unit/api/http/routes/friday-auto-fix-routes.test.ts",
    includes: [
      "TS_RUNTIME_AUTOFIX_EXECUTION_RETIRED",
      "httpStatus: 503",
      "expect(service.executeAction).not.toHaveBeenCalled",
    ],
  }],
  ["skills_run", {
    path: "test/unit/api/http/routes/friday-skill-routes.test.ts",
    includes: [
      "TS_RUNTIME_SKILL_RUNS_RETIRED",
      "httpStatus: 503",
      "expect(executor.execute).not.toHaveBeenCalled",
    ],
  }],
  ["skills_import", {
    path: "test/unit/api/http/routes/friday-skill-converter-routes.test.ts",
    includes: [
      "TS_RUNTIME_SKILL_CONVERTER_RETIRED",
      "httpStatus: 503",
      "expect(converterService.import).not.toHaveBeenCalled",
    ],
  }],
  ["mcp_server_rpc", {
    path: "test/unit/api/http/routes/friday-mcp-server-routes.test.ts",
    includes: [
      "TS_RUNTIME_MCP_TOOLS_CALL_RETIRED",
      "expect(body.error?.code).toBe(-32000)",
      "expect(deps.callTool).not.toHaveBeenCalled",
    ],
  }],
]);

const GOVERNED_NON_503_SURFACES = [
  "agent_cancel_rollback",
  "agent_plan_tool_approvals",
  "workflow_run_controls",
  "skill_content_lifecycle",
  "capability_grant_revoke",
  "mission_spine_dispatch_status",
];

let errors = 0;

function fail(message) {
  console.error(`❌ ${message}`);
  errors += 1;
}

function ok(message) {
  console.log(`✅ ${message}`);
}

function extractString(block, field) {
  const match = block.match(new RegExp(`${field}:\\s*"([^"]*)"`));
  return match?.[1] ?? "";
}

function extractEnum(block, field) {
  const match = block.match(new RegExp(`${field}:\\s*([A-Za-z0-9_]+)`));
  return match?.[1] ?? "";
}

function parseRustRows(source) {
  const start = source.indexOf("vec![");
  const end = source.indexOf("\n    ]\n}", start);
  const matrixSource = start >= 0 && end > start ? source.slice(start, end) : source;
  const rows = [];
  const rowRe = /MechanismRow\s*\{([\s\S]*?)\n\s*\},/g;
  for (const match of matrixSource.matchAll(rowRe)) {
    const block = match[1];
    const id = extractString(block, "id");
    if (!id) continue;
    rows.push({
      id,
      owner: OWNER_STRINGS[extractEnum(block, "owner")] ?? "",
      status: STATUS_STRINGS[extractEnum(block, "status")] ?? "",
      entrypoint: extractString(block, "rust_entrypoint"),
      proof: extractString(block, "proof_gate"),
      blocker: extractString(block, "blocker"),
      productLogic: /user_triggerable_product_logic:\s*true/.test(block),
    });
  }
  return rows;
}

function normalizeCell(cell) {
  return cell
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/`/g, "")
    .replace(/\\\|/g, "|")
    .trim();
}

function parseDocRows(markdown) {
  const rows = new Map();
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("| `")) continue;
    const cells = line.split("|").slice(1, -1).map(normalizeCell);
    if (cells.length < 8) continue;
    const [id, owner, status, productLogic, mutationDefault, entrypoint, proof, blocker] = cells;
    rows.set(id, {
      id,
      owner,
      status,
      productLogic,
      mutationDefault,
      entrypoint,
      proof,
      blocker,
    });
  }
  return rows;
}

const rustSource = await readFile(RUST_MATRIX, "utf8");
const docSource = await readFile(DOC, "utf8");
const manifest = JSON.parse(await readFile(TS_MANIFEST, "utf8"));

const rustRows = parseRustRows(rustSource);
const docRows = parseDocRows(docSource);
const methodRetiredSurfaces = new Map(
  (manifest.methodRetiredSurfaces?.surfaces ?? []).map((surface) => [surface.id, surface]),
);

if (rustRows.length === 0) {
  fail("Rust mechanism matrix yielded zero rows");
}

const rustIds = new Set(rustRows.map((row) => row.id));
for (const docId of docRows.keys()) {
  if (!rustIds.has(docId)) {
    fail(`documented mechanism ${docId} is not present in rust mechanism_matrix.rs`);
  }
}

for (const rustRow of rustRows) {
  const docRow = docRows.get(rustRow.id);
  if (!docRow) {
    fail(`missing doc row for Rust mechanism ${rustRow.id}`);
    continue;
  }
  if (docRow.owner !== rustRow.owner) {
    fail(`${rustRow.id}: owner doc=${docRow.owner} rust=${rustRow.owner}`);
  }
  if (docRow.status !== rustRow.status) {
    fail(`${rustRow.id}: status doc=${docRow.status} rust=${rustRow.status}`);
  }
  const productLogic = rustRow.productLogic ? "yes" : "no";
  if (docRow.productLogic !== productLogic) {
    fail(`${rustRow.id}: product_logic doc=${docRow.productLogic} rust=${productLogic}`);
  }
  if (!ALLOWED_MUTATION_DEFAULTS.has(docRow.mutationDefault)) {
    fail(`${rustRow.id}: invalid mutation_default ${docRow.mutationDefault}`);
  }
  if (!docRow.entrypoint || !docRow.proof) {
    fail(`${rustRow.id}: doc row must name entrypoint and proof_or_guard`);
  }
  if (rustRow.blocker) {
    if (docRow.blocker === "none") {
      fail(`${rustRow.id}: Rust blocker is non-empty but doc says none`);
    }
  } else if (docRow.blocker !== "none") {
    fail(`${rustRow.id}: Rust blocker is empty but doc has ${docRow.blocker}`);
  }
}

const surfaces = new Map((manifest.surfaces ?? []).map((surface) => [surface.id, surface]));
for (const [surfaceId, mechanismId] of CRITICAL_TS_FENCES.entries()) {
  const surface = surfaces.get(surfaceId);
  if (!surface) {
    fail(`critical TS fence ${surfaceId} missing from ts-runtime-retirement manifest`);
    continue;
  }
  if (surface.classification !== "fail_closed" || surface.executes_product_logic !== false) {
    fail(`${surfaceId}: must remain fail_closed with executes_product_logic=false`);
  }
  const methodSurface = methodRetiredSurfaces.get(surfaceId);
  const hasMethodBehaviorTest = typeof methodSurface?.behavioralTest === "string"
    && methodSurface.behavioralTest.length > 0;
  const hasRouteProof = typeof surface.proof === "string" && surface.proof.length > 0;
  if (!hasMethodBehaviorTest && !hasRouteProof) {
    fail(`${surfaceId}: missing method behavioralTest or route proof`);
  }
  if (!docSource.includes(`| \`${surfaceId}\` | \`${mechanismId}\``)) {
    fail(`${surfaceId}: missing critical-fence row mapped to ${mechanismId} in docs`);
  }

  const behaviorTest = CRITICAL_TS_FENCE_BEHAVIOR_TESTS.get(surfaceId);
  if (!behaviorTest) {
    fail(`${surfaceId}: missing explicit critical-fence behavior-test binding`);
    continue;
  }
  const behaviorTestSource = await readFile(join(REPO_ROOT, behaviorTest.path), "utf8").catch(() => null);
  if (!behaviorTestSource) {
    fail(`${surfaceId}: behavior test file is missing: ${behaviorTest.path}`);
    continue;
  }
  for (const requiredSnippet of behaviorTest.includes) {
    if (!behaviorTestSource.includes(requiredSnippet)) {
      fail(`${surfaceId}: behavior test ${behaviorTest.path} is missing ${JSON.stringify(requiredSnippet)}`);
    }
  }
}

for (const surfaceId of GOVERNED_NON_503_SURFACES) {
  if (!docSource.includes(`| \`${surfaceId}\``)) {
    fail(`${surfaceId}: missing governed non-503 mutation surface row in docs`);
  }
}

if (!docSource.includes("strict physical-hand OG9") || !docSource.includes("D20/B4 operator-only signatures")) {
  fail("doc must carry the truth boundary for OG9 and D20/B4 operator-only signatures");
}

if (errors > 0) {
  console.error(`\n💥 ${errors} mechanism wiring matrix error(s) found`);
  process.exit(1);
}

ok(`${rustRows.length} Rust mechanism rows are documented and reconciled`);
ok(`${CRITICAL_TS_FENCES.size} critical TS fail-closed fences are mapped`);
console.log("\n🎉 mechanism wiring matrix gate passed");
