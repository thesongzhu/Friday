import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseFridayDeepLinkUri } from "../../src/deeplink/friday-deeplink-parser.js";

describe("parseFridayDeepLinkUri property tests", () => {
  it("never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = parseFridayDeepLinkUri(input);
        expect(result).toHaveProperty("ok");
      }),
      { numRuns: 500 },
    );
  });

  it("returns ok:true or ok:false for valid friday:// URIs with random resource types", () => {
    const validResourceTypes = [
      "provider-template",
      "skill-source",
      "mcp-server",
      "workflow-template",
      "marketplace-asset",
    ];

    fc.assert(
      fc.property(
        fc.constantFrom(...validResourceTypes),
        fc.string(),
        (resourceType, params) => {
          const uri = `friday://${resourceType}?${params}`;
          const result = parseFridayDeepLinkUri(uri);
          expect(typeof result.ok).toBe("boolean");
          if (result.ok) {
            expect(result.payload).toBeDefined();
            expect(result.payload.type).toBe(resourceType);
          } else {
            expect(result.error).toBeDefined();
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("always returns ok:false for non-friday:// URIs", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.trim().startsWith("friday://")),
        (input) => {
          const result = parseFridayDeepLinkUri(input);
          expect(result.ok).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("returns ok:false for friday:// URIs with unknown resource types", () => {
    const knownTypes = new Set([
      "provider-template",
      "skill-source",
      "mcp-server",
      "workflow-template",
      "marketplace-asset",
    ]);

    fc.assert(
      fc.property(
        fc.string().filter((s) => !knownTypes.has(s) && !s.includes("?")),
        (resourceType) => {
          const uri = `friday://${resourceType}`;
          const result = parseFridayDeepLinkUri(uri);
          expect(result.ok).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});
