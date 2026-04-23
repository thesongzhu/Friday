import { describe, expect, it } from "vitest";

import { redactSecretLikeText, redactSecretLikeValue } from "../../../ui/src/lib/security/redact-secrets";

describe("redactSecretLikeText", () => {
  it("redacts provider and channel tokens without dropping surrounding text", () => {
    const openAiKey = ["sk", "proj", "aaaaaaaaaaaaaaaaaaaaaaaa"].join("-");
    const discordToken = [
      "aaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbb",
      "cccccccccccccccccccccccc",
    ].join(".");
    const githubToken = ["ghp", "aaaaaaaaaaaaaaaaaaaaaaaa"].join("_");
    const redacted = redactSecretLikeText(
      [
        `openai=${openAiKey}`,
        `discord=${discordToken}`,
        `github=${githubToken}`,
      ].join(" "),
    );

    expect(redacted).toContain("openai=[secret redacted]");
    expect(redacted).toContain("discord=[secret redacted]");
    expect(redacted).toContain("github=[secret redacted]");
    expect(redacted).not.toContain("sk-proj-");
    expect(redacted).not.toContain("MTIzNDU2");
    expect(redacted).not.toContain("ghp_");
  });

  it("redacts secret-like values inside JSON-shaped objects", () => {
    const slackToken = ["xoxb", "1111111111", "aaaaaaaaaaaaaaaaaaaaaaaa"].join("-");
    const redacted = redactSecretLikeValue({
      token: slackToken,
      label: "keep me",
    });

    expect(redacted).toContain("\"label\": \"keep me\"");
    expect(redacted).toContain("\"token\": \"[secret redacted]\"");
    expect(redacted).not.toContain("xoxb-");
  });
});
