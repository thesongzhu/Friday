import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * B2 / FRI-AUD-004 regression guard: trust-on-install must never render
 * as cryptographic "signature verified" in the plugins page.
 *
 * The plugin signature verifier at
 * `src/plugins/security/friday-plugin-signature-verifier.ts` does NOT
 * actually verify Ed25519 marketplace signatures (no trusted-keyring
 * infrastructure exists in this release). It only computes SHA-256
 * fingerprints + records user approval for local trust-on-install.
 *
 * Per POST_RELEASE_DEFAULT_DECISIONS.md B2, the UI must render:
 *   - signatureVerified=false → "unsigned or unverified"
 *   - signatureVerified=true && trustMode="trust_on_install" → "locally trusted"
 *   - signatureVerified=true && trustMode="signed" → "signature proof_pending"
 *
 * Tone never returns "success" (green) for the v1 release.
 */

const PLUGINS_PAGE_PATH = "ui/src/routes/plugins-page.tsx" as const;

describe("plugin signature truth labels (B2 / FRI-AUD-004)", () => {
  const source = readFileSync(PLUGINS_PAGE_PATH, "utf8");

  it("does not render trust-on-install as cryptographic 'signature verified'", () => {
    // The previous overclaim — UI rendered "signature verified" / "签名已验证"
    // whenever signatureVerified=true, even though trust-on-install never
    // produces a cryptographically verified marketplace signature.
    expect(source).not.toContain('"签名已验证"');
    expect(source).not.toContain('"signature verified"');
    expect(source).not.toContain("plugin.signatureVerified ?");
    // The old success-tone pairing for the signature badge MUST be gone.
    expect(source).not.toMatch(/tone=\{plugin\.signatureVerified \? "success" : "neutral"\}/);
  });

  it("uses a truth-labeled helper to render the trust badge", () => {
    // The new helper centralizes the rule (single source of truth).
    expect(source).toContain("function pluginTrustLabel(plugin: FridayPluginEntity, locale: AppLocale)");
    // The badge must always be neutral-toned — no path produces success for v1.
    expect(source).toMatch(/<StatusPill tone="neutral">\s*\{pluginTrustLabel\(plugin, locale\)\}\s*<\/StatusPill>/);
  });

  it("labels trust-on-install as locally trusted", () => {
    expect(source).toContain('"本地信任（trust-on-install）"');
    expect(source).toContain('"locally trusted (trust-on-install)"');
    expect(source).toContain('plugin.trustMode === "trust_on_install"');
  });

  it("labels signed-but-no-keyring as signature proof_pending", () => {
    expect(source).toContain('"签名待验证（暂无可信密钥环）"');
    expect(source).toContain('"signature proof_pending (no trusted keyring)"');
  });

  it("preserves the unsigned-or-unverified label for signatureVerified=false", () => {
    expect(source).toContain('"未验证签名"');
    expect(source).toContain('"unsigned or unverified"');
    expect(source).toContain("!plugin.signatureVerified");
  });

  it("anchors the helper to the audit finding via comment", () => {
    // Make the why discoverable for future readers and grep tools.
    expect(source).toContain("B2 / FRI-AUD-004 truth-label");
    expect(source).toContain("trust-on-install must never render as a");
    expect(source).toContain("POST_RELEASE_DEFAULT_DECISIONS.md B2");
  });
});
