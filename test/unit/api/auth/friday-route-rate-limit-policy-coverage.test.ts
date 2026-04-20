import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFridayRateLimitService } from "#api";
import type { FridayRateLimitService } from "#api";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

function walk(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("API route rate-limit policy coverage", () => {
  let db: FridaySqliteLayer;
  let service: FridayRateLimitService;

  beforeEach(() => {
    db = createTestDb();
    service = createFridayRateLimitService({
      db,
      nowIso: () => "2025-06-15T10:00:00.000Z",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("backs every declared route rateLimitPolicyId with a default policy", () => {
    const routesDir = path.resolve(process.cwd(), "src/api/http/routes");
    const declaredIds = new Set<string>();

    for (const filePath of walk(routesDir)) {
      const source = readFileSync(filePath, "utf8");
      for (const match of source.matchAll(/rateLimitPolicyId:\s*"([^"]+)"/g)) {
        declaredIds.add(match[1]);
      }
    }

    const missing = [...declaredIds]
      .filter((policyId) => !service.getPolicy(policyId as never))
      .sort();

    expect(missing).toEqual([]);
  });
});
