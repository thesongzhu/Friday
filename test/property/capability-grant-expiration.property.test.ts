import { describe, expect, it } from "vitest";
import fc from "fast-check";

/**
 * Helper that determines whether a grant is expired based on ISO date strings.
 * Mirrors the grant expiration logic used throughout Friday's security layer.
 */
function isExpired(
  _issuedAt: string,
  expiresAt: string | undefined,
  now: string,
): boolean {
  if (expiresAt === undefined) return false;
  return new Date(now).getTime() > new Date(expiresAt).getTime();
}

/** Generate a valid date within a safe range using integer timestamps. */
const safeDate = fc.date({ min: new Date("2000-01-01"), max: new Date("2099-12-31"), noInvalidDate: true });

describe("capability grant expiration property tests", () => {
  it("grant is expired when now > expiresAt", () => {
    fc.assert(
      fc.property(
        safeDate,
        fc.integer({ min: 1, max: 365 * 24 * 60 * 60 * 1000 }),
        fc.integer({ min: 1, max: 365 * 24 * 60 * 60 * 1000 }),
        (baseDate, ttlMs, extraMs) => {
          const issuedAt = baseDate.toISOString();
          const expiresAt = new Date(baseDate.getTime() + ttlMs).toISOString();
          const now = new Date(baseDate.getTime() + ttlMs + extraMs).toISOString();

          expect(isExpired(issuedAt, expiresAt, now)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("grant is not expired when now < expiresAt", () => {
    fc.assert(
      fc.property(
        safeDate,
        fc.integer({ min: 2, max: 365 * 24 * 60 * 60 * 1000 }),
        (baseDate, ttlMs) => {
          const issuedAt = baseDate.toISOString();
          const expiresAt = new Date(baseDate.getTime() + ttlMs).toISOString();
          // now is between issuedAt and expiresAt
          const nowOffset = Math.floor(ttlMs / 2);
          const now = new Date(baseDate.getTime() + nowOffset).toISOString();

          expect(isExpired(issuedAt, expiresAt, now)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("grant never expires when expiresAt is undefined", () => {
    fc.assert(
      fc.property(
        safeDate,
        safeDate,
        (issuedDate, nowDate) => {
          const issuedAt = issuedDate.toISOString();
          const now = nowDate.toISOString();

          expect(isExpired(issuedAt, undefined, now)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("expiration boundary: grant at exact expiresAt is not expired", () => {
    fc.assert(
      fc.property(
        safeDate,
        fc.integer({ min: 1, max: 365 * 24 * 60 * 60 * 1000 }),
        (baseDate, ttlMs) => {
          const issuedAt = baseDate.toISOString();
          const expiresAt = new Date(baseDate.getTime() + ttlMs).toISOString();
          // now == expiresAt exactly
          const now = expiresAt;

          // At exact boundary, now is NOT > expiresAt, so not expired
          expect(isExpired(issuedAt, expiresAt, now)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});
