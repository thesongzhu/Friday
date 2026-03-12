import { describe, it, expect } from "vitest";
import { redactContext } from "../../../../src/rules/engine/context-redactor.js";

describe("redactContext", () => {
  it("redacts sensitive keys", () => {
    const result = redactContext({
      command: "curl https://example.com",
      password: "s3cret",
      api_key: "abc-123",
      apiKey: "def-456",
      authorization: "Bearer token",
      secret: "shh",
      token: "tok-789",
      cookie: "session=abc",
      credential: "cred-123",
      passphrase: "phrase",
    });

    expect(result.redactionApplied).toBe(true);
    expect(result.redacted.command).toBe("curl https://example.com");
    expect(result.redacted.password).toBe("[REDACTED]");
    expect(result.redacted.api_key).toBe("[REDACTED]");
    expect(result.redacted.apiKey).toBe("[REDACTED]");
    expect(result.redacted.authorization).toBe("[REDACTED]");
    expect(result.redacted.secret).toBe("[REDACTED]");
    expect(result.redacted.token).toBe("[REDACTED]");
    expect(result.redacted.cookie).toBe("[REDACTED]");
    expect(result.redacted.credential).toBe("[REDACTED]");
    expect(result.redacted.passphrase).toBe("[REDACTED]");
    expect(result.redactedFields).toContain("password");
    expect(result.redactedFields).toContain("api_key");
  });

  it("redacts nested sensitive keys", () => {
    const result = redactContext({
      headers: { authorization: "Bearer tok", "x-custom": "safe" },
    });

    expect(result.redactionApplied).toBe(true);
    const headers = result.redacted.headers as Record<string, unknown>;
    expect(headers.authorization).toBe("[REDACTED]");
    expect(headers["x-custom"]).toBe("safe");
    expect(result.redactedFields).toContain("headers.authorization");
  });

  it("truncates long strings", () => {
    const longValue = "x".repeat(300);
    const result = redactContext({ command: longValue });

    expect(result.redactionApplied).toBe(false);
    const command = result.redacted.command as string;
    expect(command.length).toBeLessThanOrEqual(257); // 256 + "…"
    expect(command.endsWith("…")).toBe(true);
  });

  it("preserves non-sensitive values unchanged", () => {
    const result = redactContext({
      path: "/tmp/file.txt",
      count: 42,
      enabled: true,
      empty: null,
    });

    expect(result.redactionApplied).toBe(false);
    expect(result.redacted.path).toBe("/tmp/file.txt");
    expect(result.redacted.count).toBe(42);
    expect(result.redacted.enabled).toBe(true);
    expect(result.redacted.empty).toBeNull();
    expect(result.redactedFields).toEqual([]);
  });

  it("handles arrays", () => {
    const result = redactContext({
      items: ["safe", "also safe"],
    });

    expect(result.redacted.items).toEqual(["safe", "also safe"]);
  });

  it("handles empty objects", () => {
    const result = redactContext({});
    expect(result.redactionApplied).toBe(false);
    expect(result.redactedFields).toEqual([]);
  });

  it("is case-insensitive for key matching", () => {
    const result = redactContext({
      PASSWORD: "secret",
      API_KEY: "key123",
    });

    expect(result.redacted.PASSWORD).toBe("[REDACTED]");
    expect(result.redacted.API_KEY).toBe("[REDACTED]");
  });

  it("applies custom redaction rules", () => {
    const result = redactContext(
      {
        customSecret: "value-1",
        nested: {
          passcode: "123456",
          safe: "abcdefghijklmnopqrstuvwxyz",
        },
      },
      {
        sensitiveKeys: ["customSecret"],
        sensitiveKeyPatterns: ["^passcode$"],
        sensitivePaths: ["nested.safe"],
        replacement: "[MASKED]",
        maxStringLength: 8,
      },
    );

    expect(result.redactionApplied).toBe(true);
    expect(result.redacted.customSecret).toBe("[MASKED]");
    expect((result.redacted.nested as Record<string, unknown>).passcode).toBe("[MASKED]");
    expect((result.redacted.nested as Record<string, unknown>).safe).toBe("[MASKED]");
    expect(result.redactedFields).toContain("customSecret");
    expect(result.redactedFields).toContain("nested.passcode");
    expect(result.redactedFields).toContain("nested.safe");
  });

  it("keeps default rule behavior when custom rules are omitted", () => {
    const result = redactContext({
      token: "secret-token",
      command: "echo hello",
    });

    expect(result.redacted.token).toBe("[REDACTED]");
    expect(result.redacted.command).toBe("echo hello");
  });
});
