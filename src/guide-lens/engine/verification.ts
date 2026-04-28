import type {
  FridayGuideLensUiMap,
  FridayGuideLensVerificationRequest,
  FridayGuideLensVerificationResult,
} from "../model/friday-guide-lens.types.js";

function includesInsensitive(haystack: string | undefined, needle: string | undefined): boolean {
  if (!needle?.trim()) return true;
  return (haystack ?? "").toLowerCase().includes(needle.trim().toLowerCase());
}

export function verifyFridayGuideLensProgress(input: {
  nowIso: () => string;
  uiMap?: FridayGuideLensUiMap;
  request: FridayGuideLensVerificationRequest;
}): FridayGuideLensVerificationResult {
  const expected = input.request.expected;
  const uiMap = input.request.uiMap ?? input.uiMap;
  if (!expected || !uiMap) {
    return {
      status: "unknown",
      checkedAt: input.nowIso(),
      confidence: 0.2,
      reason: "No verification criteria or UI map was provided.",
      evidence: [],
    };
  }

  const evidence: string[] = [];
  let checks = 0;
  let passed = 0;

  if (expected.textIncludes?.trim()) {
    checks += 1;
    if (includesInsensitive(uiMap.visibleText, expected.textIncludes)) {
      passed += 1;
      evidence.push(`visible_text includes "${expected.textIncludes}"`);
    } else {
      evidence.push(`visible_text does not include "${expected.textIncludes}"`);
    }
  }

  if (expected.textExcludes?.trim()) {
    checks += 1;
    if (!includesInsensitive(uiMap.visibleText, expected.textExcludes)) {
      passed += 1;
      evidence.push(`visible_text excludes "${expected.textExcludes}"`);
    } else {
      evidence.push(`visible_text still includes "${expected.textExcludes}"`);
    }
  }

  if (expected.elementLabel?.trim()) {
    checks += 1;
    const found = uiMap.elements.some((element) =>
      includesInsensitive(element.label, expected.elementLabel)
      || includesInsensitive(element.text, expected.elementLabel),
    );
    if (found) {
      passed += 1;
      evidence.push(`element found for "${expected.elementLabel}"`);
    } else {
      evidence.push(`element not found for "${expected.elementLabel}"`);
    }
  }

  if (expected.appName?.trim()) {
    checks += 1;
    if (includesInsensitive(uiMap.app?.name, expected.appName)) {
      passed += 1;
      evidence.push(`frontmost app matches "${expected.appName}"`);
    } else {
      evidence.push(`frontmost app is "${uiMap.app?.name ?? "unknown"}"`);
    }
  }

  if (expected.windowTitleIncludes?.trim()) {
    checks += 1;
    if (includesInsensitive(uiMap.window?.title, expected.windowTitleIncludes)) {
      passed += 1;
      evidence.push(`window title includes "${expected.windowTitleIncludes}"`);
    } else {
      evidence.push(`window title is "${uiMap.window?.title ?? "unknown"}"`);
    }
  }

  if (checks === 0) {
    return {
      status: "unknown",
      checkedAt: input.nowIso(),
      confidence: 0.2,
      reason: "Verification criteria were empty.",
      evidence,
    };
  }

  const confidence = passed / checks;
  return {
    status: passed === checks ? "passed" : "failed",
    checkedAt: input.nowIso(),
    confidence,
    reason: passed === checks
      ? "All requested verification checks passed."
      : `${String(passed)} of ${String(checks)} verification checks passed.`,
    evidence,
  };
}
