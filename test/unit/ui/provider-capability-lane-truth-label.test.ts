import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * B7 / FRI-AUD-012 / FRI-AUD-013 / FRI-AUD-014 / FRI-AUD-017 regression
 * guard for the minimal UI lane-failure inline notice.
 *
 * Operator directive (2026-05-26 Option B): surface the latest
 * Run-capability-doctor probe's per-provider per-capability failure
 * advisories inline in the provider settings card.
 *
 *  - Backend doctor-probe already returns lane-specific truth-labels
 *    (Ollama embeddings "not wired", Codex subscription "has no
 *    embeddings", Google Generative AI runtime "does not yet execute",
 *    media-understanding env-gate 503). Verified at
 *    `src/providers/services/friday-provider-service.ts:1705` /
 *    `:1825` / `:1855` and `src/api/http/routes/friday-media-
 *    understanding-routes.ts:80`.
 *  - The settings page already calls `providersApi.runCapabilityDoctor()`
 *    but previously only surfaced a count toast — the per-provider
 *    per-capability results were thrown away.
 *  - The persisted dashboard is now backed by /v1/providers/capability-health,
 *    while the just-ran doctor result still renders inline until query
 *    invalidation completes. The global provider "enabled" pill remains only
 *    enabled/disabled.
 */

const SETTINGS_PAGE_PATH = "ui/src/routes/settings-page.tsx" as const;
const PROVIDERS_API_PATH = "ui/src/lib/api/providers.ts" as const;
const PROVIDER_SERVICE_PATH = "src/providers/services/friday-provider-service.ts" as const;

describe("provider capability-lane truth-label surface (B7 / FRI-AUD-012/013/014/017)", () => {
  const settingsSource = readFileSync(SETTINGS_PAGE_PATH, "utf8");
  const providersApiSource = readFileSync(PROVIDERS_API_PATH, "utf8");
  const providerServiceSource = readFileSync(PROVIDER_SERVICE_PATH, "utf8");

  it("Test 1: backend doctor-probe still returns lane-specific reasons for the audit's named failures", () => {
    // FRI-AUD-012 Ollama embeddings
    expect(providerServiceSource).toContain(
      'Ollama embeddings are not wired into Friday\'s production BYOK embedding client yet.',
    );
    // FRI-AUD-014 Codex subscription embeddings
    expect(providerServiceSource).toContain(
      "OpenAI Codex subscription transport is a Responses runtime path; Friday does not route embeddings through it.",
    );
    // FRI-AUD-013 Google Generative AI
    expect(providerServiceSource).toContain(
      "Google Generative AI validation exists, but Friday's production LLM runtime does not yet execute this provider API.",
    );
  });

  it("Test 2: settings page captures per-provider lane results from the capability-doctor mutation", () => {
    expect(settingsSource).toContain("capabilityLaneResultsByProvider");
    expect(settingsSource).toContain("setCapabilityLaneResultsByProvider");
    // Must group by providerId (not flat-store) so each card can render its own slice.
    expect(settingsSource).toContain("for (const r of result.capabilityResults)");
    expect(settingsSource).toContain("if (!grouped[r.providerId])");
    expect(settingsSource).toContain('grouped[r.providerId]!.push({');
  });

  it("Test 3: provider card renders the lane advisory only for lanes whose status !== 'verified'", () => {
    expect(settingsSource).toMatch(
      /const laneAdvisories = \(capabilityLaneResultsByProvider\[provider\.id\] \?\? \[\]\)\s*\.filter\(\(r\) => r\.status !== "verified"\);/,
    );
    // Bail-out path: zero non-verified lanes → no advisory rendered.
    expect(settingsSource).toContain("if (laneAdvisories.length === 0) return null;");
    // Render shape: per-capability list with status pill + message.
    expect(settingsSource).toContain('data-testid="provider-capability-lane-advisory"');
    expect(settingsSource).toContain('Capability-lane advisory (B7 / FRI-AUD-012/013/014/017)');
    expect(settingsSource).toContain('能力 lane 提示（B7 / FRI-AUD-012/013/014/017）');
  });

  it("Test 4: advisory copy is explicit per-lane truth-label, NOT a global provider-availability claim", () => {
    // The advisory footnote must explicitly disclaim global provider availability.
    expect(settingsSource).toContain(
      "this advisory is per-lane truth-label, not a provider-global availability claim",
    );
    expect(settingsSource).toContain(
      "此提示仅为 per-lane 真相披露，并不代表 provider 整体不可用",
    );
    // The advisory references the "Run capability doctor" probe so users know
    // it's stale if they haven't probed recently.
    expect(settingsSource).toContain("'Run capability doctor' probe");
  });

  it("Test 5: global provider pill semantics are unchanged (still 'enabled' / 'disabled')", () => {
    // The existing pill is driven by provider.enabled. The B7 slice must
    // NOT introduce a separate global "all lanes live" claim. Asserting
    // both that the existing pill is still in place AND that no new
    // 'all-lanes-live' / 'fully-verified' badge has been added.
    expect(settingsSource).toContain(
      '<StatusPill tone={provider.enabled ? "success" : "neutral"}>',
    );
    expect(settingsSource).toContain('{provider.enabled ? "enabled" : "disabled"}');
    expect(settingsSource).not.toContain("all lanes live");
    expect(settingsSource).not.toContain("all-lanes-live");
    expect(settingsSource).not.toContain("fully verified across all capabilities");
  });

  it("Test 6: persisted capability-health dashboard uses a backend snapshot route", () => {
    expect(providersApiSource).toContain('"/v1/providers/capability-health"');
    expect(providersApiSource).toContain("listCapabilityHealth");
    expect(settingsSource).toContain('queryKey: ["settings", "provider-capability-health"]');
    expect(settingsSource).toContain('data-testid="provider-capability-health-dashboard"');
    expect(settingsSource).toContain("labelForProviderCapabilityHealthState");
    expect(settingsSource).toContain("setup_needed");
    expect(settingsSource).toContain("proof_pending");
  });

  it("Test 7: anchored to the audit findings via comment", () => {
    expect(settingsSource).toContain("B7 / FRI-AUD-012/013/014/017 minimal UI lane-truth surface");
    // Tolerate `// ` line continuation between adjacent comment lines.
    expect(settingsSource).toMatch(/Backend doctor-probe\s+\/\/\s+already returns lane-specific truth-labels/);
    expect(settingsSource).toContain("backend-snapshot");
  });
});
