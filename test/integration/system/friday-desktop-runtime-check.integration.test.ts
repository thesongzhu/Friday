import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const describeIfDarwin = process.platform === "darwin" ? describe : describe.skip;

describeIfDarwin("desktop runtime check", () => {
  it("loads desktop settings from repo .env before reporting readiness", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "friday-desktop-check-"));
    const tempRepo = path.join(tempRoot, "repo");
    const tempScriptDir = path.join(tempRepo, "scripts", "ops");
    const sourceScriptPath = path.join(process.cwd(), "scripts", "ops", "check-desktop-runtime.sh");
    const targetScriptPath = path.join(tempScriptDir, "check-desktop-runtime.sh");

    await fs.mkdir(tempScriptDir, { recursive: true });
    await fs.copyFile(sourceScriptPath, targetScriptPath);
    await fs.chmod(targetScriptPath, 0o755);
    await fs.writeFile(
      path.join(tempRepo, ".env"),
      [
        "FRIDAY_DESKTOP_ENABLED=true",
        `FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS=${JSON.stringify(tempRepo)}`,
      ].join("\n"),
    );

    try {
      const { stdout } = await execFileAsync("bash", [targetScriptPath], {
        cwd: tempRepo,
        encoding: "utf8",
        env: {
          ...process.env,
          FRIDAY_DESKTOP_ENABLED: "",
          FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS: "",
        },
      });

      expect(stdout).toContain("[desktop-check][ok] FRIDAY_DESKTOP_ENABLED=true");
      expect(stdout).toContain(`[desktop-check][ok] FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS=${tempRepo}`);
      expect(stdout).not.toContain("FRIDAY_DESKTOP_ENABLED is not true");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
