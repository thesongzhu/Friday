/**
 * R1 — shared token-redaction helper used by phase24b/c/d trusted-inbound
 * listeners and the channel-proof validator. Locks down the contract:
 *   - exact-token replacement;
 *   - 12-char prefix replacement when the token exceeds 12 chars;
 *   - empty-token short-circuit;
 *   - cyclic-object fail-closed sentinel (HR14 — secrets must never escape
 *     through a JSON.stringify throw path).
 */
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type RedactionModule = typeof import("../../../../../scripts/ops/lib/token-redaction.mjs");

const scriptUrl = pathToFileURL(
  path.resolve(__dirname, "../../../../../scripts/ops/lib/token-redaction.mjs"),
).href;

async function loadRedaction(): Promise<RedactionModule> {
  return (await import(scriptUrl)) as RedactionModule;
}

const LABELS = Object.freeze({
  tokenLabel: "[REDACTED_TEST_TOKEN]",
  prefixLabel: "[REDACTED_TEST_TOKEN_PREFIX]",
});

describe("token-redaction scrub + containsTokenMaterial", () => {
  it("replaces exact token occurrences with the token label", async () => {
    const { scrub } = await loadRedaction();
    const token = "supersecret-1234567890ab";
    const result = scrub({ note: `value=${token};other=${token}` }, token, LABELS) as {
      note: string;
    };
    expect(result.note).not.toContain(token);
    expect(result.note.match(/\[REDACTED_TEST_TOKEN\]/g)?.length).toBe(2);
  });

  it("replaces the 12-char token prefix when the token is longer than 12 chars", async () => {
    const { scrub } = await loadRedaction();
    const token = "supersecret-1234567890ab"; // > 12 chars
    const prefix = token.slice(0, 12);
    const result = scrub({ note: `prefix-only=${prefix}` }, token, LABELS) as {
      note: string;
    };
    expect(result.note).not.toContain(prefix);
    expect(result.note).toContain("[REDACTED_TEST_TOKEN_PREFIX]");
  });

  it("short-circuits on empty token (no replacements, returns deep-cloned copy)", async () => {
    const { scrub } = await loadRedaction();
    const input = { a: "no token here", b: { c: "deep" } };
    const result = scrub(input, "", LABELS) as typeof input;
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(result.b).not.toBe(input.b);
  });

  it("fails closed to a [REDACTED_UNSERIALIZABLE] sentinel when JSON.stringify throws (cycle)", async () => {
    const { scrub } = await loadRedaction();
    const token = "supersecret-1234567890ab";
    const cyclic: Record<string, unknown> = { note: `value=${token}` };
    cyclic.self = cyclic;
    const result = scrub(cyclic, token, LABELS);
    expect(result).toBe("[REDACTED_UNSERIALIZABLE]");
  });

  it("containsTokenMaterial detects raw token and 12-char prefix", async () => {
    const { containsTokenMaterial } = await loadRedaction();
    const token = "supersecret-1234567890ab";
    expect(containsTokenMaterial(`hello ${token}`, token)).toBe(true);
    expect(containsTokenMaterial(`hello ${token.slice(0, 12)}`, token)).toBe(true);
    expect(containsTokenMaterial("nothing here", token)).toBe(false);
    expect(containsTokenMaterial(`hello ${token}`, "")).toBe(false);
  });
});
