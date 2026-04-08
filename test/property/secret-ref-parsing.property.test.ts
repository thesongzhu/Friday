import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseFridaySecretInput } from "../../src/security/friday-secret-ref.js";

const VALID_KINDS = new Set(["inline", "env-ref", "secret-ref", "file-ref", "command-ref"]);

describe("parseFridaySecretInput property tests", () => {
  it("never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = parseFridaySecretInput(input);
        expect(result).toHaveProperty("kind");
        expect(VALID_KINDS.has(result.kind)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("never throws with arbitrary secretRefPrefixes", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.array(fc.string(), { minLength: 0, maxLength: 5 }),
        (raw, prefixes) => {
          const result = parseFridaySecretInput(raw, { secretRefPrefixes: prefixes });
          expect(result).toHaveProperty("kind");
          expect(VALID_KINDS.has(result.kind)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("always returns env-ref for $VALID_ENV_VAR patterns", () => {
    const envVarArb = fc
      .stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,19}$/);

    fc.assert(
      fc.property(envVarArb, (envVar) => {
        const result = parseFridaySecretInput(`$${envVar}`);
        expect(result.kind).toBe("env-ref");
        if (result.kind === "env-ref") {
          expect(result.envVar).toBe(envVar);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("returns consistent results for the same input (deterministic)", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const first = parseFridaySecretInput(input);
        const second = parseFridaySecretInput(input);
        expect(first.kind).toBe(second.kind);
      }),
      { numRuns: 300 },
    );
  });
});
