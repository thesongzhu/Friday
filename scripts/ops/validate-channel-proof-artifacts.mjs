#!/usr/bin/env node

/**
 * Same-SHA channel-proof artifact validator.
 *
 * Usage:
 *   node scripts/ops/validate-channel-proof-artifacts.mjs \
 *     --discord <path>|skip \
 *     --telegram <path>|skip \
 *     --lark-feishu <path>|skip \
 *     [--telegram-workflow-candidate <path>|skip] \
 *     [--discord-workflow-candidate <path>|skip] \
 *     [--lark-feishu-workflow-candidate <path>|skip] \
 *     [--telegram-natural-trigger <path>|skip] \
 *     [--expected-sha <40-char-hex>]
 *
 * --telegram-workflow-candidate validates the Phase24E channel-driven
 * approve/reject artifact written by
 * scripts/ops/phase24e-telegram-workflow-candidate-listener.mjs.
 * --discord-workflow-candidate and --lark-feishu-workflow-candidate validate
 * the sibling Phase24F/G channel-driven approve/reject artifacts.
 *
 * For each non-skipped channel:
 *   - loads the JSON artifact (the per-channel listener output)
 *   - verifies schemaVersion matches the expected stable token
 *   - verifies status === "passed" (the listener's authoritative verdict)
 *   - verifies `failures` is [] (the listener's evaluated `requiredCriteria`
 *     produced no shortfalls)
 *   - verifies the explicit REQUIRED_NAMED_CRITERIA set is present in
 *     `criteria` AND each named criterion === true (defense-in-depth
 *     against tampered artifacts that drop or flip the named key)
 *   - verifies the corresponding `observed*Event` is non-null (live proof received)
 *   - verifies the artifact's serialized JSON contains NO token material
 *     (raw token, app secret, "xoxb-", "bot " or "Bearer " prefixes outside
 *     redaction labels)
 *   - when --expected-sha is provided, verifies environment.commit_sha
 *     (fallback: environment.head_sha) matches
 *
 * Note on diagnostic criteria: listeners write some observational criteria
 * into `criteria` outside their authoritative `requiredCriteria` set (e.g.,
 * `<channel>ShortReceiptObserved`, `assistantSessionReplyObserved`). The
 * validator does NOT re-iterate every key — that would silently override
 * the listener's pass verdict. Only the named criteria above are
 * independently enforced; everything else is the listener's responsibility.
 *
 * Exits 0 only when every non-skipped channel is `valid: true`. Stdout always
 * carries a structured JSON object with stable token reasons. The
 * `blockerClass` field on each result is one of:
 *
 *   - artifact_missing_or_unreadable    File not found / invalid JSON / required keys absent.
 *   - harness_reported_failure_or_blocked
 *                                       File present + parseable but harness did not pass.
 *   - artifact_upload_broken            Token material leaked into the artifact.
 *   - none                              Channel validated cleanly.
 */

import { readFileSync } from "node:fs";

import {
  containsTokenMaterial as containsTokenMaterialShared,
} from "./lib/token-redaction.mjs";

const CHANNEL_DEFINITIONS = Object.freeze({
  discord: Object.freeze({
    flag: "--discord",
    schemaVersion: "friday.phase24b.discord_trusted_inbound_proof.v1",
    observedEventKey: "observedDiscordEvent",
  }),
  telegram: Object.freeze({
    flag: "--telegram",
    schemaVersion: "friday.phase24c.telegram_trusted_inbound_proof.v1",
    observedEventKey: "observedTelegramEvent",
  }),
  "lark-feishu": Object.freeze({
    flag: "--lark-feishu",
    schemaVersion: "friday.phase24d.lark_feishu_trusted_inbound_proof.v1",
    observedEventKey: "observedLarkFeishuEvent",
  }),
  "telegram-workflow-candidate": Object.freeze({
    flag: "--telegram-workflow-candidate",
    schemaVersion: "friday.phase24e.telegram_workflow_candidate_approval_rejection_proof.v1",
    observedEventKey: "observedTelegramEvent",
  }),
  "discord-workflow-candidate": Object.freeze({
    flag: "--discord-workflow-candidate",
    schemaVersion: "friday.phase24f.discord_workflow_candidate_approval_rejection_proof.v1",
    observedEventKey: "observedDiscordEvent",
  }),
  "lark-feishu-workflow-candidate": Object.freeze({
    flag: "--lark-feishu-workflow-candidate",
    schemaVersion: "friday.phase24g.lark_feishu_workflow_candidate_approval_rejection_proof.v1",
    observedEventKey: "observedLarkFeishuEvent",
  }),
  "telegram-natural-trigger": Object.freeze({
    flag: "--telegram-natural-trigger",
    schemaVersion: "friday.phase24h.telegram_natural_trigger_execution_proof.v1",
    observedEventKey: "observedTelegramEvent",
  }),
});

const REQUIRED_TOP_LEVEL_KEYS = [
  "schemaVersion",
  "phase",
  "scope",
  "status",
  "startedAt",
  "completedAt",
  "reportPath",
  "environment",
  "criteria",
  "diagnostics",
  "failures",
];

// The validator independently enforces these named criteria regardless of
// the listener's authoritative `requiredCriteria` evaluation. Each must be
// (a) present in the artifact's `criteria` object, AND (b) === true. This
// is the validator's defense-in-depth guard for criteria with security
// consequence that must not be quietly dropped or flipped by a tampered
// artifact — currently just `artifactHasNoToken` (the listener's own
// pre-write redaction self-check). Add to this list only when a criterion
// is both security-critical and not otherwise covered by Steps 7-9.
const REQUIRED_NAMED_CRITERIA = Object.freeze(["artifactHasNoToken"]);

// Conservative token-shape detectors. If any of these match outside a
// redaction label substring, the artifact upload is broken.
//
// `xoxb-` is the Slack bot-token prefix (unmistakable).
// `\b(?:Bot|Bearer)\s+\S{16,}\b` matches an Authorization-header token tail
// (long opaque value), avoiding free-text false positives like "the bot says".
//
// Note: this catches *prefixed* tokens. Discord/Lark/Feishu app secrets are
// opaque alphanumerics without a recognizable prefix — for those, every
// listener writes a `criteria.artifactHasNoToken` boolean computed against
// the actual secret value (see explicit assertion below) so the validator
// catches leaks via the named criterion instead of byte-scanning.
const TOKEN_PATTERNS = Object.freeze([
  { kind: "substring", needle: "xoxb-", caseInsensitive: false, label: "xoxb-" },
  { kind: "regex", regex: /\b(?:Bot|Bearer)\s+\S{16,}\b/i, label: "Bot/Bearer" },
]);

function parseArgs(argv) {
  const args = {
    channels: {
      discord: null,
      telegram: null,
      "lark-feishu": null,
      "telegram-workflow-candidate": null,
      "discord-workflow-candidate": null,
      "lark-feishu-workflow-candidate": null,
      "telegram-natural-trigger": null,
    },
    explicitChannels: [],
    expectedSha: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    switch (token) {
      case "--discord":
      case "--telegram":
      case "--lark-feishu":
      case "--telegram-workflow-candidate":
      case "--discord-workflow-candidate":
      case "--lark-feishu-workflow-candidate":
      case "--telegram-natural-trigger":
        if (typeof next !== "string" || next.length === 0) {
          return { args: null, error: `cli_argument_missing_value:${token}` };
        }
        args.channels[token.slice(2)] = next;
        args.explicitChannels.push(token.slice(2));
        index += 1;
        break;
      case "--expected-sha":
        if (typeof next !== "string" || next.length === 0) {
          return { args: null, error: "cli_argument_missing_value:--expected-sha" };
        }
        args.expectedSha = next;
        index += 1;
        break;
      default:
        return { args: null, error: `cli_argument_unknown:${token}` };
    }
  }
  return { args, error: null };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripRedactionLabelOccurrences(serialized) {
  // A "[REDACTED_*]" label may legitimately contain a substring like "BOT" but
  // never " bot ", " Bearer " or "xoxb-". Defensively remove anything bracketed
  // by [REDACTED_...] before scanning so that the conservative substring
  // checks have no chance of matching the labels themselves.
  return serialized.replace(/\[REDACTED_[^\]]*\]/g, "");
}

function findResidualTokenPrefixes(serialized) {
  const scrubbedFromLabels = stripRedactionLabelOccurrences(serialized);
  const found = [];
  for (const pattern of TOKEN_PATTERNS) {
    if (pattern.kind === "substring") {
      const haystack = pattern.caseInsensitive ? scrubbedFromLabels.toLowerCase() : scrubbedFromLabels;
      const needleNorm = pattern.caseInsensitive ? pattern.needle.toLowerCase() : pattern.needle;
      if (haystack.includes(needleNorm)) found.push(pattern.label);
    } else if (pattern.kind === "regex") {
      if (pattern.regex.test(scrubbedFromLabels)) found.push(pattern.label);
    }
  }
  return found;
}

function validateChannelArtifact(channelKey, artifactPath, expectedSha) {
  const definition = CHANNEL_DEFINITIONS[channelKey];
  const reasons = [];

  // ─── Step 1: load and parse ───
  let raw;
  try {
    raw = readFileSync(artifactPath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
    return {
      channel: channelKey,
      valid: false,
      blockerClass: "artifact_missing_or_unreadable",
      reasons: [`artifact_unreadable:${code}`],
      path: artifactPath,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      channel: channelKey,
      valid: false,
      blockerClass: "artifact_missing_or_unreadable",
      reasons: ["artifact_invalid_json"],
      path: artifactPath,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      channel: channelKey,
      valid: false,
      blockerClass: "artifact_missing_or_unreadable",
      reasons: ["artifact_not_an_object"],
      path: artifactPath,
    };
  }

  // ─── Step 2: required keys ───
  const missingKeys = REQUIRED_TOP_LEVEL_KEYS.filter((key) => !(key in parsed));
  if (missingKeys.length > 0) {
    return {
      channel: channelKey,
      valid: false,
      blockerClass: "artifact_missing_or_unreadable",
      reasons: missingKeys.map((key) => `artifact_missing_required_key:${key}`),
      path: artifactPath,
    };
  }

  // ─── Step 3: schemaVersion ───
  if (parsed.schemaVersion !== definition.schemaVersion) {
    reasons.push(`schema_version_mismatch:expected=${definition.schemaVersion}:observed=${String(parsed.schemaVersion)}`);
  }

  // ─── Step 4: status ───
  if (parsed.status !== "passed") {
    reasons.push(`status_not_passed:${String(parsed.status)}`);
  }

  // ─── Step 5: criteria — defer to the listener's authoritative verdict ───
  //
  // The listener writes BOTH required-for-pass criteria AND observational
  // diagnostic criteria into the `criteria` object. Its own
  // `requiredCriteria` list (held inside each listener and not surfaced in
  // the artifact) is what gates `status="passed"` + `failures=[]`.
  //
  // The validator's job is NOT to re-evaluate every diagnostic criterion as
  // if it were required; doing so silently overrides the listener's pass
  // verdict (over-rejects valid artifacts).
  //
  // Instead the validator:
  //   - asserts `criteria` is a plain object;
  //   - enforces the EXPLICIT named criteria the validator guarantees to
  //     check independently (REQUIRED_NAMED_CRITERIA must be both present
  //     and === true regardless of the listener's required set);
  //   - trusts `status="passed"` + `failures=[]` (Step 4 + Step 6) as the
  //     listener's verdict on the rest.
  const criteria = parsed.criteria;
  if (!isPlainObject(criteria)) {
    reasons.push("criteria_invalid");
  } else {
    for (const key of REQUIRED_NAMED_CRITERIA) {
      if (!(key in criteria)) {
        reasons.push(`criterion_missing:${key}`);
      } else if (criteria[key] !== true) {
        reasons.push(`criterion_not_true:${key}`);
      }
    }
  }

  // ─── Step 6: failures must be [] ───
  if (!Array.isArray(parsed.failures)) {
    reasons.push("failures_not_array");
  } else if (parsed.failures.length > 0) {
    reasons.push(`failures_present:count=${parsed.failures.length}`);
  }

  // ─── Step 7: observed*Event must be non-null ───
  const observedEvent = parsed[definition.observedEventKey];
  if (observedEvent === null || observedEvent === undefined) {
    reasons.push(`observed_event_missing:${definition.observedEventKey}`);
  }

  // ─── Step 8: token-material residue ───
  const serialized = JSON.stringify(parsed);
  const residualPrefixes = findResidualTokenPrefixes(serialized);
  if (residualPrefixes.length > 0) {
    return {
      channel: channelKey,
      valid: false,
      blockerClass: "artifact_upload_broken",
      reasons: residualPrefixes.map((prefix) => `token_material_residue:${prefix}`),
      path: artifactPath,
    };
  }

  // ─── Step 9: expected-sha enforcement ───
  if (typeof expectedSha === "string" && expectedSha.length > 0) {
    const env = isPlainObject(parsed.environment) ? parsed.environment : {};
    const candidates = [env.commit_sha, env.head_sha].filter((value) => typeof value === "string" && value.length > 0);
    if (candidates.length === 0) {
      reasons.push("commit_sha_missing");
    } else if (!candidates.includes(expectedSha)) {
      reasons.push("commit_sha_mismatch");
    }
  }

  if (reasons.length > 0) {
    return {
      channel: channelKey,
      valid: false,
      blockerClass: "harness_reported_failure_or_blocked",
      reasons,
      path: artifactPath,
    };
  }

  return {
    channel: channelKey,
    valid: true,
    blockerClass: "none",
    reasons: [],
    path: artifactPath,
  };
}

/**
 * Programmatic entry point. Returns the decision shape that the CLI emits.
 *
 * @param {object} args
 * @param {{ discord: string|null, telegram: string|null, "lark-feishu": string|null, "telegram-workflow-candidate": string|null, "discord-workflow-candidate": string|null, "lark-feishu-workflow-candidate": string|null, "telegram-natural-trigger": string|null }} args.channels
 * @param {string|null} args.expectedSha
 */
export function validateChannelProofArtifacts(args) {
  const results = [];
  const requireExplicitChannels = args?.requireExplicitChannels === true;
  const explicitChannels = Array.isArray(args?.explicitChannels) ? new Set(args.explicitChannels) : null;
  for (const channelKey of Object.keys(CHANNEL_DEFINITIONS)) {
    const value = args?.channels?.[channelKey];
    if (requireExplicitChannels && !explicitChannels?.has(channelKey)) {
      results.push({
        channel: channelKey,
        valid: false,
        blockerClass: "artifact_missing_or_unreadable",
        reasons: [`channel_flag_missing:${CHANNEL_DEFINITIONS[channelKey].flag}`],
        path: null,
      });
      continue;
    }
    if (value === null || value === undefined || value === "skip") {
      results.push({
        channel: channelKey,
        valid: true,
        blockerClass: "none",
        reasons: ["channel_skipped"],
        path: null,
        skipped: true,
      });
      continue;
    }
    results.push(validateChannelArtifact(channelKey, value, args?.expectedSha ?? null));
  }
  const valid = results.every((entry) => entry.valid === true);
  return { valid, results };
}

function emit(decision) {
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
}

function main() {
  const { args, error } = parseArgs(process.argv.slice(2));
  if (error !== null) {
    emit({
      valid: false,
      results: [
        {
          channel: null,
          valid: false,
          blockerClass: "artifact_missing_or_unreadable",
          reasons: [error],
        },
      ],
    });
    process.exit(1);
  }

  const decision = validateChannelProofArtifacts({ ...args, requireExplicitChannels: true });
  emit({ ...decision, expected_sha: args.expectedSha ?? null });
  process.exit(decision.valid ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// Re-export the shared helper so test code can reuse the same residue check.
export { containsTokenMaterialShared as containsTokenMaterial };
