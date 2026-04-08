import { describe, expect, it } from "vitest";
import {
  buildFridaySecretRef,
  parseFridaySecretInput,
  resolveFridaySecretInput,
} from "../../../src/security/friday-secret-ref.js";

describe("friday secret refs", () => {
  it("parses env refs in both legacy and canonical forms", () => {
    expect(parseFridaySecretInput("$OPENAI_API_KEY")).toEqual({
      kind: "env-ref",
      envVar: "OPENAI_API_KEY",
    });
    expect(parseFridaySecretInput("env:OPENAI_API_KEY")).toEqual({
      kind: "env-ref",
      envVar: "OPENAI_API_KEY",
    });
  });

  it("parses file, command, and stored secret refs", () => {
    expect(parseFridaySecretInput("file:/tmp/provider-key")).toEqual({
      kind: "file-ref",
      path: "/tmp/provider-key",
    });
    expect(parseFridaySecretInput("command:printf 'abc'")).toEqual({
      kind: "command-ref",
      command: "printf 'abc'",
    });
    expect(parseFridaySecretInput(buildFridaySecretRef("provider:test:apiKey"))).toEqual({
      kind: "secret-ref",
      refKey: "provider:test:apiKey",
    });
  });

  it("resolves command refs only when explicitly enabled", async () => {
    await expect(resolveFridaySecretInput(
      { kind: "command-ref", command: "printf 'abc'" },
      {
        allowCommandRefs: true,
        execCommand: async () => "abc\n",
      },
    )).resolves.toEqual({
      ok: true,
      source: "command-ref",
      value: "abc",
    });

    await expect(resolveFridaySecretInput(
      { kind: "command-ref", command: "printf 'abc'" },
      { allowCommandRefs: false },
    )).resolves.toMatchObject({
      ok: false,
      blocker: {
        code: "SECRET_COMMAND_DISABLED",
        refKind: "command-ref",
      },
    });
  });

  it("rejects relative file refs and resolves absolute file refs", async () => {
    await expect(resolveFridaySecretInput(
      { kind: "file-ref", path: "tmp/provider-key" },
      {},
    )).resolves.toMatchObject({
      ok: false,
      blocker: {
        code: "SECRET_FILE_PATH_INVALID",
      },
    });

    await expect(resolveFridaySecretInput(
      { kind: "file-ref", path: "/tmp/provider-key" },
      { readFileText: async () => "from-file\n" },
    )).resolves.toEqual({
      ok: true,
      source: "file-ref",
      value: "from-file",
    });
  });
});
