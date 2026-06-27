import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("docs/ops/friday-endbar-acceptance-manifest.json", "utf8"));
const checker = readFileSync("scripts/ops/check-friday-provider-entitlement-manifest.mjs", "utf8");

describe("Friday END-BAR acceptance manifest contract", () => {
  it("keeps the manifest as an acceptance standard, not proof of completion", () => {
    expect(manifest.truthLabel).toBe("endbar_acceptance_manifest_not_evidence_not_release");
    expect(manifest.status).toBe("acceptance_defined_not_satisfied");
    expect(manifest.caveat).toContain("not proof");
  });

  it("requires mechanism, UI, selected-design, provider, and integrated tape groups", () => {
    const ids = new Set(manifest.acceptanceGroups.map((group: { id: string }) => group.id));

    expect([...ids]).toEqual(expect.arrayContaining([
      "mechanism_multiangle_stress",
      "ui_real_use_mobile_desktop",
      "selected_uiux_conformance",
      "provider_entitlement_matrix",
      "integrated_end_to_end_tape",
    ]));
    expect(manifest.acceptanceGroups.every((group: { requiredForEndBar: boolean }) => group.requiredForEndBar)).toBe(true);
  });

  it("does not allow a free ChatGPT web account to count as a Friday autonomous backend", () => {
    const freeChatGpt = manifest.providerEntitlementMatrix.find((row: { id: string }) => row.id === "free_chatgpt_web_account");
    const codexCli = manifest.providerEntitlementMatrix.find((row: { id: string }) => row.id === "codex_cli");

    expect(freeChatGpt.status).toBe("unsupported_as_friday_autonomous_backend");
    expect(freeChatGpt.proof).toContain("negative/boundary check only");
    expect(codexCli.status).toBe("advanced_local_first_party_cli_delegation");
    expect(codexCli.proof).toContain("not a free ChatGPT backend");
  });

  it("pins completion rules against fake closure and gate weakening", () => {
    const rules = manifest.completionRules.join("\n");

    expect(rules).toContain("real user-use mobile and desktop");
    expect(rules).toContain("not runtime evidence");
    expect(rules).toContain("No synthetic INSERT");
    expect(rules).toContain("no fake organic");
    expect(rules).toContain("no production hub kill");
    expect(rules).toContain("no gate weakening");
  });

  it("checker preserves external source portability and the free-account boundary", () => {
    expect(checker).toContain("FRIDAY_ENDBAR_REQUIRE_EXTERNAL_SOURCES");
    expect(checker).toContain("external operator sources listed but not required in default CI mode");
    expect(checker).toContain("free ChatGPT web account cannot count as a Friday autonomous backend");
    expect(checker).toContain("This checker validates the standard and provider boundary only");
  });
});
