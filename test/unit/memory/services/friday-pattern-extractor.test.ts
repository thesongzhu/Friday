import { describe, it, expect } from "vitest";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";
import { createFridayPatternExtractor } from "../../../../src/memory/services/friday-pattern-extractor.js";

describe("FridayPatternExtractor", () => {
  it("extractPatterns returns empty array (stub implementation)", async () => {
    const db = createTestDb();
    try {
      const extractor = createFridayPatternExtractor({ db });
      const patterns = await extractor.extractPatterns("user-1", 10);

      expect(patterns).toEqual([]);
    } finally {
      db.close();
    }
  });
});
