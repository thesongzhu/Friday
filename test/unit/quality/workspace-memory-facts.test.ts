import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadFridayWorkspaceContext } from "#agent";
import { FRIDAY_SQLITE_MIGRATIONS } from "#state";

const repoRoot = process.cwd();

describe("workspace memory facts", () => {
  it("keeps the stable migration fact bound to the runtime migration chain", async () => {
    const memoryText = await readFile(path.join(repoRoot, "context", "MEMORY.md"), "utf8");
    const latestMigration = FRIDAY_SQLITE_MIGRATIONS.at(-1);

    expect(latestMigration).toBeDefined();
    expect(memoryText).toContain(
      `- Database migration count: ${FRIDAY_SQLITE_MIGRATIONS.length} (latest: ${latestMigration!.name}).`,
    );
  });

  it("keeps the workspace context loading fact aligned with identity context files", async () => {
    const memoryText = await readFile(path.join(repoRoot, "context", "MEMORY.md"), "utf8");
    const workspaceContext = await loadFridayWorkspaceContext(repoRoot);
    const runtimeIdentityFileNames = workspaceContext.files
      .filter((file) => file.kind === "identity")
      .map((file) => file.name);
    const workspaceContextFact = memoryText
      .split("\n")
      .find((line) => line.startsWith("- Friday loads workspace context fresh"));

    expect(runtimeIdentityFileNames).toEqual(expect.arrayContaining([
      "context/AGENTS.md",
      "context/BELIEFS.md",
      "context/SOUL.md",
    ]));
    for (const fileName of runtimeIdentityFileNames) {
      expect(workspaceContextFact).toContain(`\`${path.basename(fileName)}\``);
    }
  });
});
