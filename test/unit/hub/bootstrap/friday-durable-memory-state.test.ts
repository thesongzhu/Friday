import { describe, expect, it } from "vitest";
import { createFridaySkillRepository } from "#skills";
import { createDurableMemoryState, createStubMemoryState } from "../../../../src/hub/bootstrap/hub-helpers.js";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

// Audit E3: EXPLICIT skill lifecycle transitions (via updateSkillStatus) must be
// DURABLE in the `skills` table — which the workflow-execution safety gate reads
// — so a self-heal disable survives a hub restart and keeps blocking. The fix is
// deliberately NARROW: only updateSkillStatus is durable; discovery
// (upsertDiscoveredSkills) stays in-memory so it can NOT clobber the converter's
// `not_installed` (which would defeat the safety gate).

const NOW = "2026-05-29T00:00:00.000Z";

function seedInstalled(db: ReturnType<typeof createTestDb>, repo: ReturnType<typeof createFridaySkillRepository>, id: string): void {
  db.withWriteTransaction((conn) =>
    repo.upsertSkillFromCatalog(conn, {
      id, name: id, source: "local", origin: "workspace", status: "installed", nowIso: NOW,
    }),
  );
}
function tableStatus(db: ReturnType<typeof createTestDb>, repo: ReturnType<typeof createFridaySkillRepository>, id: string): string | undefined {
  return db.withReadConnection((conn) => repo.getSkillById(conn, id)?.status);
}

describe("createDurableMemoryState — explicit-transition durability (audit E3)", () => {
  it("disable → restart → STILL disabled (persisted to the skills table the exec gate reads)", async () => {
    const db = createTestDb();
    try {
      const repo = createFridaySkillRepository();
      seedInstalled(db, repo, "skill-x");
      const mem = createDurableMemoryState({ db, skillRepository: repo, nowIso: () => NOW });
      await mem.updateSkillStatus("skill-x", "disabled", "self-heal disable");
      // Durable: the skills table (exec-gate source) now says disabled.
      expect(tableStatus(db, repo, "skill-x")).toBe("disabled");
      // In-memory verifier view is also current (self-heal verifier reads this).
      expect((await mem.listSkillStatuses())["skill-x"]).toBe("disabled");

      // RESTART: a fresh durable memoryState (empty in-memory) still sees the
      // durable table status — the disable is NOT lost.
      const afterRestart = createDurableMemoryState({ db, skillRepository: repo, nowIso: () => NOW });
      expect(tableStatus(db, repo, "skill-x")).toBe("disabled");
      // (in-memory listSkillStatuses is empty after restart; the durable truth
      //  lives in the table, which is exactly what the exec gate reads.)
      expect((await afterRestart.listSkillStatuses())["skill-x"]).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("re-enable → restart → enabled (durable in the skills table)", async () => {
    const db = createTestDb();
    try {
      const repo = createFridaySkillRepository();
      seedInstalled(db, repo, "skill-y");
      const mem = createDurableMemoryState({ db, skillRepository: repo, nowIso: () => NOW });
      await mem.updateSkillStatus("skill-y", "disabled");
      expect(tableStatus(db, repo, "skill-y")).toBe("disabled");
      await mem.updateSkillStatus("skill-y", "installed"); // explicit re-enable
      expect(tableStatus(db, repo, "skill-y")).toBe("installed");
      // Restart: still installed.
      createDurableMemoryState({ db, skillRepository: repo, nowIso: () => NOW });
      expect(tableStatus(db, repo, "skill-y")).toBe("installed");
    } finally {
      db.close();
    }
  });

  it("ANTI-CLOBBER: registry discovery does NOT overwrite the converter's not_installed", async () => {
    const db = createTestDb();
    try {
      const repo = createFridaySkillRepository();
      // Converter staged an unpromoted candidate as not_installed (blocks exec).
      db.withWriteTransaction((conn) =>
        repo.upsertSkillFromCatalog(conn, {
          id: "skill-z", name: "skill-z", source: "local", origin: "managed", status: "not_installed", nowIso: NOW,
        }),
      );
      const mem = createDurableMemoryState({ db, skillRepository: repo, nowIso: () => NOW });
      // Registry discovery computes "installed" (e.g. bundled auto-install) and
      // snapshots it — this MUST stay in-memory and NOT touch the table.
      await mem.upsertDiscoveredSkills([
        { id: "skill-z", name: "skill-z", source: "local", origin: "bundled", status: "installed", manifest: {} as never },
      ]);
      // The converter's not_installed in the table is preserved → exec gate still blocks.
      expect(tableStatus(db, repo, "skill-z")).toBe("not_installed");
    } finally {
      db.close();
    }
  });

  it("the durable variant does NOT make listSkillStatuses durable (discovery stays in-memory)", async () => {
    const db = createTestDb();
    try {
      const repo = createFridaySkillRepository();
      const mem = createDurableMemoryState({ db, skillRepository: repo, nowIso: () => NOW });
      await mem.upsertDiscoveredSkills([
        { id: "skill-w", name: "skill-w", source: "local", origin: "bundled", status: "installed", manifest: {} as never },
      ]);
      // In-memory snapshot present this process...
      expect((await mem.listSkillStatuses())["skill-w"]).toBe("installed");
      // ...but NOT written to the durable table (no clobber surface).
      expect(tableStatus(db, repo, "skill-w")).toBeUndefined();
      // Contrast: the stub behaves the same in-memory.
      const stub = createStubMemoryState();
      expect((await stub.listSkillStatuses())["skill-w"]).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
