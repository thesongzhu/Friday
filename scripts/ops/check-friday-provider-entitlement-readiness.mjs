#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-provider-entitlement-readiness.mjs \\
    [--repo-root=/abs/repo] [--manifest=/abs/or/repo-relative/manifest.json] \\
    [--deepseek-proof=/abs/proof.json] \\
    [--openai-proof=/abs/proof.json] \\
    [--anthropic-proof=/abs/proof.json] \\
    [--out=/abs/provider-entitlement-readiness.json]

Truth: evaluates supplied provider entitlement runtime proofs against the
END-BAR manifest. It never calls providers, reads secrets, automates free
ChatGPT web, mints credentials, writes DB rows, or claims release.`);
}

function arg(name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(prefix)) return value.slice(prefix.length);
    if (value === `--${name}` && args[index + 1]) return args[index + 1];
  }
  return "";
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const repoRoot = resolve(arg("repo-root") || process.env.FRIDAY_REPO_ROOT || new URL("../..", import.meta.url).pathname);
const manifestPathInput = arg("manifest") || process.env.FRIDAY_ENDBAR_ACCEPTANCE_MANIFEST || "docs/ops/friday-endbar-acceptance-manifest.json";
const manifestPath = isAbsolute(manifestPathInput) ? manifestPathInput : resolve(repoRoot, manifestPathInput);
const outPath = arg("out") || process.env.FRIDAY_PROVIDER_ENTITLEMENT_READINESS_REPORT || "";

const proofInputs = {
  deepseek_api: arg("deepseek-proof") || process.env.FRIDAY_PROVIDER_ENTITLEMENT_DEEPSEEK_PROOF || "",
  openai_api: arg("openai-proof") || process.env.FRIDAY_PROVIDER_ENTITLEMENT_OPENAI_PROOF || "",
  anthropic_api: arg("anthropic-proof") || process.env.FRIDAY_PROVIDER_ENTITLEMENT_ANTHROPIC_PROOF || "",
};

const blockers = [];
const notes = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    block("json_unreadable", `${label}:${path}:${error.message}`);
    return null;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function field(value, name) {
  return value && typeof value === "object" ? value[name] : undefined;
}

function text(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function statusText(value) {
  return String(field(value, "status") || field(value, "result") || field(value, "proof") || "");
}

function passLike(value) {
  return ["pass", "passed", "ready", "complete"].includes(statusText(value));
}

function resolveInput(path) {
  if (!path) return "";
  return isAbsolute(path) ? path : resolve(path);
}

function providerSignal(providerId, report) {
  const haystack = text(report).toLowerCase();
  if (providerId === "deepseek_api") {
    return haystack.includes("deepseek") && !haystack.includes("free_chatgpt");
  }
  if (providerId === "openai_api") {
    return haystack.includes("openai") && !haystack.includes("openai-codex") && !haystack.includes("codex_cli") && !haystack.includes("free_chatgpt");
  }
  if (providerId === "anthropic_api") {
    return haystack.includes("anthropic") && !haystack.includes("claude_cli") && !haystack.includes("free_chatgpt");
  }
  return false;
}

function validateProviderProof(providerId, proofPath) {
  if (!proofPath) {
    return {
      providerId,
      status: "missing",
      proofPath: null,
      proofStatus: null,
      blockers: [{ code: "provider_runtime_proof_missing", detail: providerId }],
    };
  }
  const resolved = resolveInput(proofPath);
  if (!existsSync(resolved)) {
    return {
      providerId,
      status: "missing",
      proofPath: resolved,
      proofStatus: null,
      blockers: [{ code: "provider_runtime_proof_file_missing", detail: `${providerId}:${resolved}` }],
    };
  }
  const proof = readJson(resolved, providerId);
  const rowBlockers = [];
  if (!proof) {
    rowBlockers.push({ code: "provider_runtime_proof_unreadable", detail: providerId });
  } else {
    if (!passLike(proof)) {
      rowBlockers.push({ code: "provider_runtime_proof_not_passed", detail: `${providerId}:${statusText(proof) || "<missing-status>"}` });
    }
    if (!providerSignal(providerId, proof)) {
      rowBlockers.push({ code: "provider_runtime_proof_wrong_provider", detail: providerId });
    }
    if (providerId === "deepseek_api") {
      const deepseekPressure = field(proof, "deepseek_live_api_pressure");
      if (deepseekPressure && field(deepseekPressure, "real_external_api") !== true) {
        rowBlockers.push({ code: "deepseek_runtime_proof_not_external_api", detail: resolved });
      }
    }
  }
  return {
    providerId,
    status: rowBlockers.length === 0 ? "satisfied" : "blocked",
    proofPath: resolved,
    proofStatus: proof ? statusText(proof) || null : null,
    blockers: rowBlockers,
  };
}

if (!existsSync(manifestPath)) {
  block("manifest_missing", manifestPath);
}
const manifest = existsSync(manifestPath) ? readJson(manifestPath, "endbar-acceptance-manifest") : null;
const matrix = asArray(field(manifest, "providerEntitlementMatrix"));

const expectedRequired = ["deepseek_api", "openai_api", "anthropic_api"];
for (const providerId of expectedRequired) {
  const row = matrix.find((item) => field(item, "id") === providerId);
  if (!row) {
    block("provider_matrix_required_row_missing", providerId);
    continue;
  }
  if (field(row, "mustPassBeforeEndBar") !== true) {
    block("provider_matrix_required_row_not_must_pass", providerId);
  }
  const status = String(field(row, "status") || "");
  if (status !== "supported_api_key_route") {
    block("provider_matrix_required_row_status_unexpected", `${providerId}:${status}`);
  }
}

const freeChatGpt = matrix.find((item) => field(item, "id") === "free_chatgpt_web_account");
if (!freeChatGpt) {
  block("free_chatgpt_boundary_missing", "free_chatgpt_web_account");
} else if (field(freeChatGpt, "status") !== "unsupported_as_friday_autonomous_backend" || field(freeChatGpt, "mustPassBeforeEndBar") !== false) {
  block("free_chatgpt_boundary_unsafe", text(freeChatGpt));
}

const providers = expectedRequired.map((providerId) => validateProviderProof(providerId, proofInputs[providerId]));
for (const provider of providers) {
  for (const providerBlocker of provider.blockers) block(providerBlocker.code, providerBlocker.detail);
}

if (providers.some((provider) => provider.status === "missing")) {
  notes.push("missing provider runtime proofs are expected in offline/report-only mode; they keep END-BAR blocked");
}

const report = {
  truth: "provider_entitlement_readiness_not_runtime_generator_not_release",
  status: blockers.length === 0 ? "passed" : "blocked",
  repoRoot,
  manifestPath,
  providers,
  freeChatGptBoundary: freeChatGpt ? {
    status: field(freeChatGpt, "status"),
    mustPassBeforeEndBar: field(freeChatGpt, "mustPassBeforeEndBar"),
  } : null,
  counts: {
    requiredProviders: expectedRequired.length,
    satisfiedProviders: providers.filter((provider) => provider.status === "satisfied").length,
  },
  notes,
  blockers,
  caveat: "This report validates supplied runtime proof artifacts only. It does not call providers, cannot prove absent API credentials, and never treats CLI or free ChatGPT web access as API-provider proof.",
};

if (outPath) {
  const resolved = resolveInput(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
process.exit(blockers.length === 0 ? 0 : 2);
