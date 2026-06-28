#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-uiux-native-linkage.mjs \\
    [--repo-root=/abs/repo] [--design-root=/abs/friday-design-handoff-20260602] \\
    [--out=/abs/uiux-native-linkage.json] [--require-complete]

Truth: verifies that operator-selected UI/UX decisions have native Swift routes,
drivable accessibility ids, and declared runtimeActionIds. It is not screenshot
proof, not live tap proof, not END-BAR, and not adoption.`);
}

function arg(name) {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const repoRoot = resolve(arg("repo-root") || process.env.FRIDAY_REPO_ROOT || new URL("../..", import.meta.url).pathname);
const designRoot = resolve(arg("design-root") || process.env.FRIDAY_DESIGN_HANDOFF_ROOT || `${process.env.HOME || process.env.USERPROFILE || "."}/Desktop/friday-design-handoff-20260602`);
const outPath = arg("out") || process.env.FRIDAY_UIUX_NATIVE_LINKAGE_REPORT || "";
const requireComplete = args.includes("--require-complete");

const blockers = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function read(path, label) {
  const resolved = isAbsolute(path) ? path : resolve(repoRoot, path);
  if (!existsSync(resolved)) {
    block("file_missing", `${label}:${resolved}`);
    return "";
  }
  return readFileSync(resolved, "utf8");
}

function readJson(path, label) {
  try {
    return JSON.parse(read(path, label));
  } catch (error) {
    block("json_unreadable", `${label}:${path}:${error.message}`);
    return null;
  }
}

function selection(surface) {
  const path = resolve(designRoot, "saved", `${surface}-selection.json`);
  const value = readJson(path, `${surface}-selection`);
  const issues = [];
  if (!value) issues.push("missing_or_invalid");
  if (value?.operatorConfirmed !== true) issues.push("not_operator_confirmed");
  if (value?.state?.truthLabel !== "designProofOnly") issues.push("truth_label_not_designProofOnly");
  if (issues.length > 0) block("design_selection_invalid", `${surface}:${issues.join(",")}`);
  return {
    surface,
    path,
    status: issues.length === 0 ? "operator_confirmed_design_proof_only" : "invalid",
    state: value?.state || {},
    locked: Array.isArray(value?.locked) ? value.locked : [],
    issues,
  };
}

function sourceBundle(paths) {
  return paths.map((path) => read(path, path)).join("\n");
}

function missingStrings(source, values) {
  return values.filter((value) => !source.includes(value));
}

function runtimeActionsFromContract(path) {
  const source = read(path, path);
  return [...source.matchAll(/runtimeActionIds:\s*\[([\s\S]*?)\]/g)]
    .flatMap((match) => [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]));
}

function accessibilityIds(source) {
  return [...source.matchAll(/\.accessibilityIdentifier\("([^"]+)"/g)].map((match) => match[1]);
}

function evaluateRequirement(requirement) {
  const source = sourceBundle(requirement.paths);
  const missing = [
    ...missingStrings(source, requirement.requiredStrings || []).map((value) => `string:${value}`),
  ];
  const ids = accessibilityIds(source);
  for (const id of requirement.requiredAccessibilityIds || []) {
    if (!ids.includes(id)) missing.push(`accessibility:${id}`);
  }
  const runtimeActions = runtimeActionsFromContract(requirement.productContractPath);
  for (const action of requirement.requiredRuntimeActionIds || []) {
    if (!runtimeActions.includes(action)) missing.push(`runtimeActionId:${action}`);
  }
  return {
    id: requirement.id,
    surface: requirement.surface,
    selectionKey: requirement.selectionKey,
    expectedSelectionValue: requirement.expectedSelectionValue,
    status: missing.length === 0 ? "linked" : "gap",
    paths: requirement.paths,
    requiredRuntimeActionIds: requirement.requiredRuntimeActionIds || [],
    requiredAccessibilityIds: requirement.requiredAccessibilityIds || [],
    missing,
    caveat: requirement.caveat || "Native linkage only; runtime/live proof is checked elsewhere.",
  };
}

const mobileProductContract = "apps/friday-ios/Sources/FridayMobileShellCore/MobileProductReadinessContract.swift";
const desktopProductContract = "apps/macos/FridayHubConsole/Sources/FridayHubConsoleCore/DesktopProductReadinessContract.swift";

const requirements = [
  {
    id: "mobile-home-status-chat",
    surface: "mobile",
    selectionKey: "homeLayout",
    expectedSelectionValue: "chatStatus",
    paths: [
      "apps/friday-ios/Sources/FridayMobileShell/FridayApp.swift",
      "apps/friday-ios/Sources/FridayMobileShell/FridayHomeScreen.swift",
      "apps/friday-ios/Sources/FridayMobileShell/FridayChatScreen.swift",
    ],
    productContractPath: mobileProductContract,
    requiredStrings: ["FridayHomeScreen", "FridayChatScreen", "friday.home.status-card", "friday.chat.composer"],
    requiredAccessibilityIds: ["friday.chat.send"],
    requiredRuntimeActionIds: ["mobile/home/refresh"],
  },
  {
    id: "mobile-command-sheet-grid",
    surface: "mobile",
    selectionKey: "menuModel",
    expectedSelectionValue: "commandSheet",
    paths: [
      "apps/friday-ios/Sources/FridayMobileShell/CommandSheet.swift",
      mobileProductContract,
    ],
    productContractPath: mobileProductContract,
    requiredStrings: ["Command Sheet", "friday.command-sheet.readiness-footer", "MobileProductDestinationID.allCases"],
  },
  {
    id: "mobile-provider-workspace",
    surface: "mobile",
    selectionKey: "providerCardOpens",
    expectedSelectionValue: "workspaceHome",
    paths: [
      "apps/friday-ios/Sources/FridayMobileShell/FridayProviderAuthScreen.swift",
      mobileProductContract,
    ],
    productContractPath: mobileProductContract,
    requiredStrings: ["Provider Workspace", "friday.provider-workspace.overview", "friday.provider-workspace.open-ledger"],
    requiredRuntimeActionIds: ["mobile/providerAuth/check", "mobile/providerAuth/provider-workspace"],
  },
  {
    id: "mobile-session-full-native-control",
    surface: "mobile",
    selectionKey: "sessionControlSet",
    expectedSelectionValue: "fullNativeControl",
    paths: [
      "apps/friday-ios/Sources/FridayMobileShell/FridaySessionDetailScreen.swift",
      mobileProductContract,
    ],
    productContractPath: mobileProductContract,
    requiredStrings: ["friday.session.sidecar-open", "friday.session.sidecar-close", "friday.session.send-button"],
    requiredRuntimeActionIds: ["mobile/session/sidecar/open", "mobile/session/sidecar/close", "mobile/workflow/run-control"],
  },
  {
    id: "mobile-approval-summary-proof",
    surface: "mobile",
    selectionKey: "approvalDepth",
    expectedSelectionValue: "summaryThenProof",
    paths: [
      "apps/friday-ios/Sources/FridayMobileShell/FridayChatScreen.swift",
      mobileProductContract,
    ],
    productContractPath: mobileProductContract,
    requiredStrings: ["approvalCard", "action_digest", "friday.chat.approval-card"],
    requiredRuntimeActionIds: ["mobile/approval/check", "mobile/approval/reject"],
  },
  {
    id: "mobile-voice-loop",
    surface: "mobile",
    selectionKey: "entrypointPattern",
    expectedSelectionValue: "fullGridPostV1",
    paths: [
      "apps/friday-ios/Sources/FridayMobileShell/FridayVoiceScreen.swift",
      "apps/friday-ios/Sources/FridayMobileShell/FridayChatScreen.swift",
      mobileProductContract,
    ],
    productContractPath: mobileProductContract,
    requiredStrings: ["Readiness plus local voice-loop truth", "friday.voice.readiness-card"],
    requiredAccessibilityIds: ["friday.chat.voice-input", "friday.chat.voice-output", "friday.voice.open-chat-loop"],
    requiredRuntimeActionIds: [
      "mobile/voice/permission",
      "mobile/fridayChat/voice-input",
      "mobile/fridayChat/voice-output",
      "mobile/voice/open-chat-loop",
    ],
  },
  {
    id: "mobile-passport-memory-activity",
    surface: "mobile",
    selectionKey: "passportPattern",
    expectedSelectionValue: "checklistSheet",
    paths: [
      "apps/friday-ios/Sources/FridayMobileShell/FridayContextPassportScreen.swift",
      "apps/friday-ios/Sources/FridayMobileShell/FridayProjectionScreens.swift",
      "apps/friday-ios/Sources/FridayMobileShell/FridayHomeScreen.swift",
      mobileProductContract,
    ],
    productContractPath: mobileProductContract,
    requiredStrings: [
      "friday.context-passport.checklist",
      "friday.context-passport.send",
      "viewModel.decideMemory",
      "markActivityDone",
    ],
    requiredRuntimeActionIds: ["mobile/passport/send", "mobile/memory/confirm", "mobile/memory/reject", "mobile/activity/mark-done"],
  },
  {
    id: "desktop-three-pane-proof-inspector",
    surface: "desktop",
    selectionKey: "layout",
    expectedSelectionValue: "threePane",
    paths: [
      "apps/macos/FridayHubConsole/Sources/FridayHubConsole/HubConsoleShell.swift",
      "apps/macos/FridayHubConsole/Sources/FridayHubConsole/ProofInspector.swift",
      "apps/macos/FridayHubConsole/Sources/FridayHubConsole/Navigation.swift",
      desktopProductContract,
    ],
    productContractPath: desktopProductContract,
    requiredStrings: ["ProofInspector", "Navigation", "var isBuilt: Bool { contract.routeBuilt }"],
  },
  {
    id: "desktop-provider-parity-channels",
    surface: "desktop",
    selectionKey: "providerParityView",
    expectedSelectionValue: "capabilityMatrixAndQueues",
    paths: [
      "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopProjectionScreens.swift",
      desktopProductContract,
    ],
    productContractPath: desktopProductContract,
    requiredStrings: [
      "friday.desktop.provider-route-decision-card",
      "friday.desktop.provider-work-items-card",
      "friday.desktop.channels.admin",
      "friday.desktop.channels.surface-events",
    ],
    requiredRuntimeActionIds: ["desktop/channels/receipts", "desktop/channels/surface-events"],
  },
  {
    id: "desktop-workflow-evidence-memory",
    surface: "desktop",
    selectionKey: "workflowBuilder",
    expectedSelectionValue: "canvasInspector",
    paths: [
      "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopProjectionScreens.swift",
      "apps/macos/FridayHubConsole/Sources/FridayHubConsole/DesktopChatScreen.swift",
      desktopProductContract,
    ],
    productContractPath: desktopProductContract,
    requiredStrings: [
      "friday.desktop.workflow.canvas",
      "friday.desktop.evidence.timeline-pages",
      "friday.desktop.evidence.transcript-browser",
      "friday.desktop.evidence.memory-review",
      "friday.desktop.evidence.memory-candidate",
    ],
    requiredRuntimeActionIds: ["desktop/workflow/retry", "desktop/workflow/cancel", "desktop/memory/act", "desktop/memory/check"],
  },
];

const selections = {
  mobile: selection("mobile"),
  desktop: selection("desktop"),
};

const evaluated = requirements.map((requirement) => {
  const selectedValue = selections[requirement.surface]?.state?.[requirement.selectionKey];
  const selectionMatches = selectedValue === requirement.expectedSelectionValue;
  const result = evaluateRequirement(requirement);
  if (!selectionMatches) result.missing.unshift(`selection:${requirement.selectionKey}:${selectedValue || "<missing>"}`);
  result.status = result.missing.length === 0 ? "linked" : "gap";
  result.selectedValue = selectedValue || null;
  return result;
});

const gaps = evaluated.filter((item) => item.status !== "linked");
const report = {
  truth: "uiux_native_linkage_not_screenshot_not_live_tap_not_endbar",
  status: blockers.length === 0 && gaps.length === 0 ? "linked" : "linkage_gaps_present",
  repoRoot,
  designRoot,
  selections,
  counts: {
    requirements: evaluated.length,
    linked: evaluated.length - gaps.length,
    gaps: gaps.length,
    blockers: blockers.length,
  },
  requirements: evaluated,
  gaps,
  blockers,
  caveat:
    "This proves selected-design native linkage only: Swift route/control/accessibility/runtimeActionId wiring. It does not prove screenshots, real GUI taps, same-run UI/device proof, release, adoption, or END-BAR.",
};

if (outPath) {
  const resolved = isAbsolute(outPath) ? outPath : resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
process.exit(requireComplete && report.status !== "linked" ? 1 : 0);
