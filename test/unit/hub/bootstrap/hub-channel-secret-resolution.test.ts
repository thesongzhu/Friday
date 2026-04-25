import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveChannelInitConfigWithSecretPolicy } from "../../../../src/hub/bootstrap/index.js";

describe("resolveChannelInitConfigWithSecretPolicy", () => {
  it("resolves file-ref secrets for channel init", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "friday-channel-"));
    const secretPath = path.join(tempDir, "discord.token");
    writeFileSync(secretPath, "discord-secret\n", "utf8");

    try {
      const result = resolveChannelInitConfigWithSecretPolicy({
        instance: {
          kind: "discord",
          enabled: true,
          token: `file:${secretPath}`,
        },
        env: {},
        secretPolicy: "strict",
        resolveSecretRef: () => null,
      });

      expect(result.errors).toEqual([]);
      expect(result.config.token).toBe("discord-secret");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects command-ref secrets for channel init", () => {
    const result = resolveChannelInitConfigWithSecretPolicy({
      instance: {
        kind: "discord",
        enabled: true,
        token: "command:printf discord-command-secret",
      },
      env: {},
      secretPolicy: "strict",
      resolveSecretRef: () => null,
    });

    expect(result.errors).toEqual([
      "Command secret refs are disabled for channel discord.token; use env:, file:, or secret:// refs instead",
    ]);
    expect(result.config.token).toBeUndefined();
  });
});
