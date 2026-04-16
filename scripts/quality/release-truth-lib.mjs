import path from "node:path";

export const EVIDENCE_KINDS = {
  "mock-contract": {
    usesMock: true,
    releaseProofEligible: false,
    summary: "Fast deterministic checks, contracts, unit tests, or repo-only verification.",
  },
  "mock-hub": {
    usesMock: true,
    releaseProofEligible: false,
    summary: "Exercises Friday flows through mock hub/runtime wiring.",
  },
  "browser-mock-hub": {
    usesMock: true,
    releaseProofEligible: false,
    summary: "Browser automation that still depends on createMockHubEnv, seeded local storage, or fake runtime wiring.",
  },
  "real-provider": {
    usesMock: false,
    releaseProofEligible: true,
    summary: "Hits a real provider/transport and requires live credentials or runtime state.",
  },
  "real-browser": {
    usesMock: false,
    releaseProofEligible: true,
    summary: "Browser automation against a live runtime without seeded state or fake transport.",
  },
  "real-runtime": {
    usesMock: false,
    releaseProofEligible: true,
    summary: "Local runtime, server, auth, route, and persistence checks against a live Friday instance.",
  },
  "cloud-live": {
    usesMock: false,
    releaseProofEligible: true,
    summary: "Live cloud deployment checks against a remote Friday environment.",
  },
  "manual-external": {
    usesMock: false,
    releaseProofEligible: true,
    summary: "Human or external-system verification such as Reddit parity or third-party workflow checks.",
  },
};

export const DEFAULT_PROOF_INPUTS = [
  "package.json",
  "scripts/ops/run-real-green-gate.mjs",
  "validation/real-world/lib",
];

export const MOCK_CONTAMINATION_PATTERNS = [
  { pattern: /createMockHubEnv/g, label: "createMockHubEnv" },
  { pattern: /mock-llm-providers/g, label: "mock-llm-providers" },
  { pattern: /\bseed(?:ed)? localStorage\b/gi, label: "seeded localStorage" },
  { pattern: /localStorage\.setItem\(/g, label: "localStorage.setItem" },
  { pattern: /\bfake transport\b/gi, label: "fake transport" },
  { pattern: /\bfake provider\b/gi, label: "fake provider" },
];

function normalizePath(filePath = "") {
  return filePath.replace(/\\/g, "/");
}

export function extractRequiresEnv(text) {
  const matches = text.match(/\b(?:FRIDAY|OPENAI|ANTHROPIC|OLLAMA|GOOGLE|XAI|GROQ|MISTRAL)_[A-Z0-9_]+\b/g) ?? [];
  return [...new Set(matches)].sort();
}

export function scanTextForMockLeaks(label, text) {
  const findings = [];
  for (const entry of MOCK_CONTAMINATION_PATTERNS) {
    entry.pattern.lastIndex = 0;
    if (!entry.pattern.test(text)) {
      continue;
    }
    findings.push({
      label,
      marker: entry.label,
    });
  }
  return findings;
}

export function classifyEvidenceTarget(input) {
  const name = input?.name ?? "";
  const command = input?.command ?? "";
  const filePath = normalizePath(input?.filePath ?? "");
  const content = input?.content ?? "";
  const text = [name, command, filePath, content].join("\n");
  const requiresEnv = extractRequiresEnv(text);

  const browserUiTarget = filePath.includes("/test/e2e/ui/")
    || /browser-e2e|run-browser-e2e/i.test(text);
  const browserLiveTarget = /real-browser|live-browser|playwright.*127\.0\.0\.1|playwright.*localhost/i.test(text);
  const cloudTarget = filePath.includes("/test/e2e/live/")
    || /cloud-live|FRIDAY_E2E_TARGET=cloud|check-friday-cloud-contract/i.test(text);
  const liveProviderTarget = /FRIDAY_E2E_LIVE_|FRIDAY_ANTHROPIC_OAUTH_ACCESS_TOKEN|real-scenarios|llm-e2e|run-real-world-validation/i.test(text);
  const liveRuntimeTarget = /run-real-green-gate|real-green-gate|release:proof:real|local-runtime-doctor|ops:doctor:runtime|\/v1\/health|\/v1\/setup\/status/i.test(text);
  const manualExternalTarget = /reddit|manual external|openclaw parity|external walkthrough/i.test(text);
  const mockHubTarget = /createMockHubEnv|mock-hub|mock env/i.test(text);
  const fakeProviderTarget = /mock-llm-providers|fake transport|fake provider/i.test(text);
  const explicitMockTarget = filePath.includes("/test/e2e/mock/")
    || filePath.includes("/test/_mocks/")
    || /\bmock\b/i.test(path.basename(filePath));

  let evidenceKind = "mock-contract";

  if (manualExternalTarget) {
    evidenceKind = "manual-external";
  } else if (cloudTarget) {
    evidenceKind = "cloud-live";
  } else if (browserLiveTarget) {
    evidenceKind = "real-browser";
  } else if (browserUiTarget && (mockHubTarget || fakeProviderTarget || /localStorage\.setItem\(/.test(text))) {
    evidenceKind = "browser-mock-hub";
  } else if (browserUiTarget) {
    evidenceKind = "real-browser";
  } else if (liveProviderTarget) {
    evidenceKind = "real-provider";
  } else if (liveRuntimeTarget) {
    evidenceKind = "real-runtime";
  } else if (mockHubTarget || fakeProviderTarget || explicitMockTarget) {
    evidenceKind = "mock-hub";
  }

  return {
    evidenceKind,
    usesMock: EVIDENCE_KINDS[evidenceKind].usesMock,
    releaseProofEligible: EVIDENCE_KINDS[evidenceKind].releaseProofEligible,
    requiresEnv,
    summary: EVIDENCE_KINDS[evidenceKind].summary,
  };
}
