import { describe, expect, it } from "vitest";
import { parseFridaySecretInput, resolveFridaySecretInput } from "../../../../src/security/friday-secret-ref.js";

describe("hub-level SecretRef unification", () => {
  describe("parseFridaySecretInput is used uniformly across hub consumers", () => {
    it("parses env-ref format ($VAR_NAME)", () => {
      const result = parseFridaySecretInput("$MY_API_KEY");
      expect(result.kind).toBe("env-ref");
      if (result.kind === "env-ref") {
        expect(result.envVar).toBe("MY_API_KEY");
      }
    });

    it("parses env: prefix format", () => {
      const result = parseFridaySecretInput("env:PROVIDER_TOKEN");
      expect(result.kind).toBe("env-ref");
      if (result.kind === "env-ref") {
        expect(result.envVar).toBe("PROVIDER_TOKEN");
      }
    });

    it("parses file: prefix format", () => {
      const result = parseFridaySecretInput("file:/etc/friday/secrets/api-key");
      expect(result.kind).toBe("file-ref");
      if (result.kind === "file-ref") {
        expect(result.path).toBe("/etc/friday/secrets/api-key");
      }
    });

    it("parses command: prefix format", () => {
      const result = parseFridaySecretInput("command:vault kv get -field=key secret/friday");
      expect(result.kind).toBe("command-ref");
      if (result.kind === "command-ref") {
        expect(result.command).toContain("vault");
      }
    });

    it("parses secret:// ref format", () => {
      const result = parseFridaySecretInput("secret://channel/discord-token", {
        secretRefPrefixes: ["secret://channel/", "secret://"],
      });
      expect(result.kind).toBe("secret-ref");
    });

    it("treats plain strings as inline", () => {
      const result = parseFridaySecretInput("sk-1234567890");
      expect(result.kind).toBe("inline");
    });
  });

  describe("resolveFridaySecretInput resolves env-ref", () => {
    it("resolves env-ref from provided env object", async () => {
      const parsed = parseFridaySecretInput("$TEST_ENV_VALUE");
      const result = await resolveFridaySecretInput(parsed, {
        env: { TEST_ENV_VALUE: "demo-env-value" },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("demo-env-value");
      }
    });

    it("returns error for missing env var", async () => {
      const parsed = parseFridaySecretInput("$MISSING_VAR");
      const result = await resolveFridaySecretInput(parsed, { env: {} });
      expect(result.ok).toBe(false);
    });
  });
});
