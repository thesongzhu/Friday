#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-ios-action-accessibility-map.mjs \\
    [--repo-root=/abs/repo] [--compact]

Truth: static iOS UIUX action linkage only. This verifies every mobile
runtimeActionId in MobileProductReadinessContract has declared drivable
accessibility identifiers in Swift and a product action-evidence wrapper. It
does not prove simulator taps, live Hub mutation, END-BAR, release, or adoption.`);
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

const compact = args.includes("--compact");
const repoRoot = resolve(arg("repo-root") || process.env.FRIDAY_REPO_ROOT || new URL("../..", import.meta.url).pathname);
const blockers = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function read(path, label) {
  if (!existsSync(path)) {
    block("missing_file", `${label}:${path}`);
    return "";
  }
  return readFileSync(path, "utf8");
}

function swiftSourcesUnder(dir) {
  const found = [];
  function walk(current) {
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = resolve(current, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".swift")) {
        found.push(child);
      }
    }
  }
  walk(dir);
  return found;
}

function actionIdsFromMobileContract(source) {
  return [...source.matchAll(/runtimeActionIds:\s*\[([\s\S]*?)\]/g)]
    .flatMap((match) => [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]))
    .filter((value) => value.startsWith("mobile/"));
}

function accessibilityIdsFromSwift(source) {
  const ids = [...source.matchAll(/\.accessibilityIdentifier\("([^"]+)"/g)].map((match) => match[1]);
  if (source.includes('accessibilityIdentifier("friday.session.control.\\(control.id)")')) {
    ids.push("friday.session.control.resume", "friday.session.control.reject", "friday.session.control.stop");
  }
  if (source.includes('accessibilityIdentifier("friday.command-sheet.destination.\\(dest.rawValue)")')) {
    for (const destination of [
      "home",
      "missions",
      "session",
      "contextPassport",
      "tokenLedger",
      "shareIntake",
      "voice",
      "pairing",
      "newSession",
      "needsMe",
      "memory",
      "platform",
      "providerAuth",
      "activity",
      "workflows",
      "onboarding",
      "settings",
    ]) {
      ids.push(`friday.command-sheet.destination.${destination}`);
    }
  }
  return ids;
}

const ACTION_MAP = {
  "mobile/home/refresh": {
    accessibilityIds: ["friday.mobile.toolbar.refresh"],
    evidenceScripts: ["scripts/ops/friday-mobile-memory-action-evidence.sh"],
  },
  "mobile/missions/read": {
    accessibilityIds: ["friday.missions.read"],
    evidenceScripts: ["scripts/ops/friday-mobile-projection-action-evidence.sh"],
  },
  "mobile/session/sidecar/open": {
    accessibilityIds: ["friday.session.sidecar-open"],
    evidenceScripts: ["scripts/ops/friday-mobile-session-sidecar-action-evidence.sh"],
  },
  "mobile/session/sidecar/close": {
    accessibilityIds: ["friday.session.sidecar-close"],
    evidenceScripts: ["scripts/ops/friday-mobile-session-sidecar-action-evidence.sh"],
  },
  "mobile/workflow/run-control": {
    accessibilityIds: ["friday.session.control.resume", "friday.session.control.reject"],
    evidenceScripts: ["scripts/ops/friday-mobile-workflow-action-evidence.sh"],
  },
  "mobile/passport/checklist": {
    accessibilityIds: ["friday.context-passport.checklist"],
    evidenceScripts: ["scripts/ops/friday-mobile-passport-transfer-action-evidence.sh"],
  },
  "mobile/passport/send": {
    accessibilityIds: ["friday.context-passport.send"],
    evidenceScripts: ["scripts/ops/friday-mobile-passport-transfer-action-evidence.sh"],
  },
  "mobile/tokenLedger/refresh": {
    accessibilityIds: ["friday.token-ledger.refresh"],
    evidenceScripts: ["scripts/ops/friday-mobile-token-ledger-action-evidence.sh"],
  },
  "mobile/tokenLedger/run-readback": {
    accessibilityIds: ["friday.token-ledger.detail"],
    evidenceScripts: ["scripts/ops/friday-mobile-token-ledger-action-evidence.sh"],
  },
  "mobile/share/send": {
    accessibilityIds: ["friday.share.submit"],
    evidenceScripts: ["scripts/ops/friday-mobile-share-intake-action-evidence.sh"],
  },
  "mobile/share/open-chat-loop": {
    accessibilityIds: ["friday.share.open-chat-loop"],
    evidenceScripts: ["scripts/ops/friday-mobile-share-intake-action-evidence.sh"],
  },
  "mobile/voice/permission": {
    accessibilityIds: ["friday.voice.permission"],
    evidenceScripts: ["scripts/ops/friday-mobile-voice-action-evidence.sh"],
  },
  "mobile/fridayChat/voice-input": {
    accessibilityIds: ["friday.chat.voice-input"],
    evidenceScripts: ["scripts/ops/friday-mobile-voice-action-evidence.sh"],
  },
  "mobile/fridayChat/voice-output": {
    accessibilityIds: ["friday.chat.voice-output"],
    evidenceScripts: ["scripts/ops/friday-mobile-voice-action-evidence.sh"],
  },
  "mobile/voice/open-chat-loop": {
    accessibilityIds: ["friday.voice.open-chat-loop"],
    evidenceScripts: ["scripts/ops/friday-mobile-voice-action-evidence.sh"],
  },
  "mobile/firstlaunch/scan": {
    accessibilityIds: ["friday.home.pairing-scan-button"],
    evidenceScripts: ["scripts/ops/friday-mobile-firstlaunch-action-evidence.sh"],
  },
  "mobile/firstlaunch/pairnow": {
    accessibilityIds: ["friday.home.pair-button"],
    evidenceScripts: ["scripts/ops/friday-mobile-firstlaunch-action-evidence.sh"],
  },
  "mobile/firstlaunch/retry": {
    accessibilityIds: ["friday.home.pairing-retry-button"],
    evidenceScripts: ["scripts/ops/friday-mobile-firstlaunch-action-evidence.sh"],
  },
  "mobile/firstlaunch/cancel": {
    accessibilityIds: ["friday.home.pairing-cancel-button"],
    evidenceScripts: ["scripts/ops/friday-mobile-firstlaunch-action-evidence.sh"],
  },
  "mobile/newSession/play": {
    accessibilityIds: ["friday.new-session.launch-button"],
    evidenceScripts: ["scripts/ops/friday-mobile-new-session-action-evidence.sh"],
  },
  "mobile/newSession/open-chat-loop": {
    accessibilityIds: ["friday.new-session.open-chat-loop"],
    evidenceScripts: ["scripts/ops/friday-mobile-new-session-action-evidence.sh"],
  },
  "mobile/missions/dispatch": {
    accessibilityIds: ["friday.missions.dispatch-button"],
    evidenceScripts: ["scripts/ops/friday-mobile-new-session-action-evidence.sh"],
  },
  "mobile/missions/open-chat-loop": {
    accessibilityIds: ["friday.missions.open-chat-loop"],
    evidenceScripts: ["scripts/ops/friday-mobile-new-session-action-evidence.sh"],
  },
  "mobile/approval/check": {
    accessibilityIds: ["friday.chat.approval.approve", "friday.session.control.resume"],
    evidenceScripts: ["scripts/ops/friday-mobile-chat-action-evidence.sh"],
  },
  "mobile/approval/reject": {
    accessibilityIds: ["friday.chat.approval.reject", "friday.session.control.reject"],
    evidenceScripts: ["scripts/ops/friday-mobile-chat-action-evidence.sh"],
  },
  "mobile/memory/confirm": {
    accessibilityIds: ["friday.memory.confirm-candidate", "friday.chat.memory-card.keep"],
    evidenceScripts: ["scripts/ops/friday-mobile-memory-action-evidence.sh"],
  },
  "mobile/memory/reject": {
    accessibilityIds: ["friday.memory.reject-candidate", "friday.chat.memory-card.reject"],
    evidenceScripts: ["scripts/ops/friday-mobile-memory-action-evidence.sh"],
  },
  "mobile/providerAuth/check": {
    accessibilityIds: ["friday.provider-auth.check"],
    evidenceScripts: ["scripts/ops/friday-mobile-provider-auth-action-evidence.sh"],
  },
  "mobile/providerAuth/provider-workspace": {
    accessibilityIds: ["friday.provider-workspace.overview"],
    evidenceScripts: ["scripts/ops/friday-mobile-provider-auth-action-evidence.sh"],
  },
  "mobile/activity/mark-done": {
    accessibilityIds: ["friday.activity.mark-done"],
    evidenceScripts: ["scripts/ops/friday-mobile-activity-action-evidence.sh"],
  },
  "mobile/workflow/retry": {
    accessibilityIds: ["friday.workflow.retry-work-item", "friday.home.retry-work-item"],
    evidenceScripts: ["scripts/ops/friday-mobile-workflow-action-evidence.sh"],
  },
  "mobile/workflow/cancel": {
    accessibilityIds: ["friday.workflow.cancel-work-item", "friday.home.cancel-work-item"],
    evidenceScripts: ["scripts/ops/friday-mobile-workflow-action-evidence.sh"],
  },
  "mobile/onboarding/open-device-pairing": {
    accessibilityIds: ["friday.onboarding.open-device-pairing"],
    evidenceScripts: ["scripts/ops/friday-mobile-firstlaunch-action-evidence.sh"],
  },
  "mobile/platform/capability-matrix": {
    accessibilityIds: ["friday.platform.capability-matrix"],
    evidenceScripts: ["scripts/ops/friday-mobile-projection-action-evidence.sh"],
  },
  "mobile/settings/push-permission": {
    accessibilityIds: ["friday.settings.push-permission"],
    evidenceScripts: ["scripts/ops/friday-mobile-projection-action-evidence.sh"],
  },
  "mobile/pet/state-mapping": {
    accessibilityIds: ["friday.pet-editor.readiness"],
    evidenceScripts: ["scripts/ops/friday-mobile-projection-action-evidence.sh"],
  },
  "mobile/proof/viewer-open": {
    accessibilityIds: ["friday.proof-viewer.receipts"],
    evidenceScripts: ["scripts/ops/friday-mobile-projection-action-evidence.sh"],
  },
  "mobile/entrypoints/readiness": {
    accessibilityIds: ["friday.entrypoints.readiness"],
    evidenceScripts: ["scripts/ops/friday-mobile-projection-action-evidence.sh"],
  },
};

const contractPath = resolve(repoRoot, "apps/friday-ios/Sources/FridayMobileShellCore/MobileProductReadinessContract.swift");
const contractSource = read(contractPath, "mobile-product-contract");
const swiftRoot = resolve(repoRoot, "apps/friday-ios/Sources/FridayMobileShell");
const coreRoot = resolve(repoRoot, "apps/friday-ios/Sources/FridayMobileShellCore");
const swiftSource = [...swiftSourcesUnder(swiftRoot), ...swiftSourcesUnder(coreRoot)]
  .map((path) => read(path, "swift-source"))
  .join("\n");
const sourceAccessibilityIds = new Set(accessibilityIdsFromSwift(swiftSource));
const runtimeActionIds = [...new Set(actionIdsFromMobileContract(contractSource))];

const actions = runtimeActionIds.map((runtimeActionId) => {
  const entry = ACTION_MAP[runtimeActionId];
  const missingAccessibilityIds = entry
    ? entry.accessibilityIds.filter((id) => !sourceAccessibilityIds.has(id))
    : [];
  const missingEvidenceScripts = entry
    ? entry.evidenceScripts.filter((script) => !existsSync(resolve(repoRoot, script)))
    : [];
  return {
    runtimeActionId,
    mapped: Boolean(entry),
    accessibilityIds: entry?.accessibilityIds || [],
    evidenceScripts: entry?.evidenceScripts || [],
    missingAccessibilityIds,
    missingEvidenceScripts,
    status: !entry
      ? "missing_map"
      : missingAccessibilityIds.length === 0 && missingEvidenceScripts.length === 0
        ? "linked"
        : "link_gaps_present",
  };
});

for (const action of actions) {
  if (!action.mapped) block("runtime_action_unmapped", action.runtimeActionId);
  for (const id of action.missingAccessibilityIds) {
    block("accessibility_id_missing", `${action.runtimeActionId}:${id}`);
  }
  for (const script of action.missingEvidenceScripts) {
    block("evidence_script_missing", `${action.runtimeActionId}:${script}`);
  }
}
const staleActionMapEntries = Object.keys(ACTION_MAP).filter((actionId) => !runtimeActionIds.includes(actionId));

const report = {
  truth: "ios_action_accessibility_map_static_not_gui_tap_not_endbar",
  status: blockers.length === 0 ? "ios_actions_linked" : "gaps_present",
  repoRoot,
  counts: {
    mobileRuntimeActionIds: runtimeActionIds.length,
    mappedActions: actions.filter((action) => action.mapped).length,
    linkedActions: actions.filter((action) => action.status === "linked").length,
    accessibilityIdsInSource: sourceAccessibilityIds.size,
    blockers: blockers.length,
  },
  gaps: {
    unmapped: actions.filter((action) => !action.mapped).map((action) => action.runtimeActionId),
    missingAccessibilityIds: actions
      .filter((action) => action.missingAccessibilityIds.length > 0)
      .map((action) => ({
        runtimeActionId: action.runtimeActionId,
        missingAccessibilityIds: action.missingAccessibilityIds,
      })),
    missingEvidenceScripts: actions
      .filter((action) => action.missingEvidenceScripts.length > 0)
      .map((action) => ({
        runtimeActionId: action.runtimeActionId,
        missingEvidenceScripts: action.missingEvidenceScripts,
      })),
    staleActionMapEntries,
  },
  actions: compact ? undefined : actions,
  blockers,
  caveat:
    "A green result means every mobile runtimeActionId has a stable iOS accessibility identifier and an existing action-evidence wrapper. It still does not prove real simulator/device taps, live Hub mutation, END-BAR, release, or adoption.",
};

console.log(JSON.stringify(report, null, compact ? 0 : 2));
process.exit(blockers.length === 0 ? 0 : 2);
