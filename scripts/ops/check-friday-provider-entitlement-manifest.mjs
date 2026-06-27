#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function arg(name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(prefix)) return value.slice(prefix.length);
    if (value === `--${name}` && args[index + 1]) return args[index + 1];
  }
  return "";
}

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-provider-entitlement-manifest.mjs \\
    [--repo-root=/abs/repo] \\
    [--manifest=/abs/or/repo-relative/friday-endbar-acceptance-manifest.json]

Truth: validates the END-BAR acceptance manifest shape and provider entitlement
boundaries. It does not execute providers, prove runtime closure, mark GO-LIVE,
or claim adoption.`);
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const repoRoot = resolve(arg("repo-root") || process.env.FRIDAY_REPO_ROOT || new URL("../..", import.meta.url).pathname);
const manifestPathInput = arg("manifest") || process.env.FRIDAY_ENDBAR_ACCEPTANCE_MANIFEST || "docs/ops/friday-endbar-acceptance-manifest.json";
const manifestPath = isAbsolute(manifestPathInput) ? manifestPathInput : resolve(repoRoot, manifestPathInput);
const requireExternalSources = process.env.FRIDAY_ENDBAR_REQUIRE_EXTERNAL_SOURCES === "1";

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

function expandHome(path) {
  if (path === "~") return process.env.HOME || "";
  if (path.startsWith("~/")) return resolve(process.env.HOME || "", path.slice(2));
  return path;
}

function repoPathExists(relativePath) {
  return existsSync(resolve(repoRoot, relativePath));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function field(value, name) {
  return value && typeof value === "object" ? value[name] : undefined;
}

function ids(rows) {
  return new Set(asArray(rows).map((row) => field(row, "id")).filter((id) => typeof id === "string" && id));
}

function requiredIdsPresent(sectionName, rows, required) {
  const present = ids(rows);
  for (const id of required) {
    if (!present.has(id)) block(`${sectionName}_missing_required_id`, id);
  }
}

function containsUnsupportedFreeChatGpt(matrix) {
  return asArray(matrix).some((row) => {
    return field(row, "id") === "free_chatgpt_web_account"
      && field(row, "status") === "unsupported_as_friday_autonomous_backend";
  });
}

function hasDangerousFreeChatGptSupport(matrix) {
  return asArray(matrix).some((row) => {
    const id = String(field(row, "id") || "").toLowerCase();
    const status = String(field(row, "status") || "").toLowerCase();
    return id.includes("free_chatgpt") && /^supported(?:_|$)/.test(status);
  });
}

if (!existsSync(manifestPath)) {
  block("manifest_missing", manifestPath);
}

const manifest = existsSync(manifestPath) ? readJson(manifestPath, "endbar-acceptance-manifest") : null;

if (manifest) {
  if (manifest.schemaVersion !== 1) block("schema_version_not_1", String(manifest.schemaVersion));
  if (manifest.truthLabel !== "endbar_acceptance_manifest_not_evidence_not_release") {
    block("truth_label_unexpected", String(manifest.truthLabel || ""));
  }
  if (manifest.status !== "acceptance_defined_not_satisfied") {
    block("status_must_not_claim_satisfied", String(manifest.status || ""));
  }
  if (!String(manifest.caveat || "").includes("not proof")) {
    block("manifest_caveat_missing_not_proof", String(manifest.caveat || ""));
  }

  requiredIdsPresent("acceptance_group", manifest.acceptanceGroups, [
    "mechanism_multiangle_stress",
    "ui_real_use_mobile_desktop",
    "selected_uiux_conformance",
    "provider_entitlement_matrix",
    "integrated_end_to_end_tape",
  ]);
  requiredIdsPresent("provider_matrix", manifest.providerEntitlementMatrix, [
    "deepseek_api",
    "openai_api",
    "anthropic_api",
    "codex_cli",
    "claude_cli",
    "free_chatgpt_web_account",
  ]);

  for (const group of asArray(manifest.acceptanceGroups)) {
    if (field(group, "requiredForEndBar") !== true) {
      block("acceptance_group_not_required", String(field(group, "id") || ""));
    }
    const passBar = asArray(field(group, "passBar"));
    if (passBar.length === 0) block("acceptance_group_missing_pass_bar", String(field(group, "id") || ""));
    for (const relativePath of asArray(field(group, "repoEvidencePaths"))) {
      if (typeof relativePath !== "string" || !relativePath.trim()) {
        block("repo_evidence_path_invalid", String(field(group, "id") || ""));
      } else if (!repoPathExists(relativePath)) {
        block("repo_evidence_path_missing", relativePath);
      }
    }
  }

  for (const source of asArray(manifest.operatorSources)) {
    const sourcePath = field(source, "path");
    if (typeof sourcePath !== "string" || !sourcePath.trim()) {
      block("operator_source_path_invalid", String(field(source, "id") || ""));
      continue;
    }
    if (requireExternalSources && !existsSync(expandHome(sourcePath))) {
      block("operator_source_missing", sourcePath);
    }
  }
  if (!requireExternalSources) {
    notes.push("external operator sources listed but not required in default CI mode");
  }

  if (!containsUnsupportedFreeChatGpt(manifest.providerEntitlementMatrix)) {
    block("free_chatgpt_boundary_missing", "free_chatgpt_web_account must be unsupported_as_friday_autonomous_backend");
  }
  if (hasDangerousFreeChatGptSupport(manifest.providerEntitlementMatrix)) {
    block("free_chatgpt_incorrectly_supported", "free ChatGPT web account cannot count as a Friday autonomous backend");
  }

  const rules = asArray(manifest.completionRules).join("\n");
  for (const phrase of [
    "real user-use mobile and desktop",
    "not runtime evidence",
    "No synthetic INSERT",
    "no fake organic",
    "no production hub kill",
    "no gate weakening",
  ]) {
    if (!rules.includes(phrase)) block("completion_rule_phrase_missing", phrase);
  }
}

const report = {
  truth: "endbar_acceptance_manifest_check_not_runtime_proof",
  status: blockers.length === 0 ? "passed" : "failed",
  repoRoot,
  manifestPath,
  externalSourceMode: requireExternalSources ? "required" : "listed_only",
  notes,
  blockers,
  caveat: "This checker validates the standard and provider boundary only. END-BAR still requires real mobile+desktop user-use proof, provider runs, UI/device evidence, and closure gates.",
};

console.log(JSON.stringify(report, null, 2));
process.exit(blockers.length === 0 ? 0 : 1);
