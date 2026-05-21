import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFridayAgentExecTool } from "#agent";

describe("FridayAgentExecTool", () => {
  const tool = createFridayAgentExecTool({ defaultWorkdir: process.cwd() });

  function signal(): AbortSignal {
    return new AbortController().signal;
  }

  // ─── Basic command execution ───

  it("executes a simple command and captures output", async () => {
    const result = await tool.execute({ command: "echo hello" }, signal());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("hello");
  });

  // ─── Captures stderr ───

  it("captures stderr output", async () => {
    const shellTool = createFridayAgentExecTool({
      defaultWorkdir: process.cwd(),
      allowShell: true,
    });
    const result = await shellTool.execute(
      { command: "echo error >&2" },
      signal(),
    );

    expect(result.content).toContain("error");
  });

  // ─── Non-zero exit code ───

  it("reports non-zero exit code as error", async () => {
    const shellTool = createFridayAgentExecTool({
      defaultWorkdir: process.cwd(),
      allowShell: true,
    });
    const result = await shellTool.execute(
      { command: "exit 1" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("exit code 1");
  });

  // ─── Workdir override ───

  it("respects workdir parameter", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-workdir-test-"));
    const realTmpDir = fs.realpathSync(tmpDir);
    try {
      const workdirTool = createFridayAgentExecTool({
        defaultWorkdir: process.cwd(),
        workspaceRoot: path.dirname(realTmpDir),
        allowShell: false,
      });
      const result = await workdirTool.execute(
        { command: "pwd", workdir: tmpDir },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content.trim()).toBe(realTmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ─── Background mode ───

  it("returns immediately in background mode", async () => {
    const result = await tool.execute(
      { command: "sleep 60", background: true },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("background");
  });

  // ─── Timeout ───

  it("times out long-running commands", async () => {
    const result = await tool.execute(
      { command: "sleep 30", timeoutMs: 200 },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
  }, 10_000);

  // ─── Missing command ───

  it("throws on missing command", async () => {
    await expect(
      tool.execute({ command: "" }, signal()),
    ).rejects.toThrow("command is required");
  });

  // ─── Tool definition ───

  it("has correct name and description", () => {
    expect(tool.name).toBe("exec");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
  });

  // ─── No output ───

  it("returns (no output) for empty stdout", async () => {
    const result = await tool.execute(
      { command: "true" },
      signal(),
    );

    expect(result.content).toBe("(no output)");
  });

  // ─── A4: Exec Security ───

  describe("metacharacter blocking (shell=false)", () => {
    const metachars = [";", "|", "&", "$", "(", ")", "{", "}", "<", ">", "`", "#", "!", "~"];

    describe.each(metachars)(
      "blocks metacharacter '%s'",
      (char) => {
        it(`rejects command containing "${char}"`, async () => {
          const secureTool = createFridayAgentExecTool({
            defaultWorkdir: process.cwd(),
            allowShell: false,
          });

          const result = await secureTool.execute(
            { command: `echo hello ${char} echo world` },
            signal(),
          );

          expect(result.isError).toBe(true);
          expect(result.content).toContain("metacharacter");
        });
      },
    );
  });

  describe("workspace boundary enforcement", () => {
    let tmpRoot: string;

    // Create a temporary workspace for these tests
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-test-"));

    afterAll(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("rejects workdir outside workspace root", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: true,
      });

      const result = await secureTool.execute(
        { command: "pwd", workdir: "/tmp" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("outside the allowed workspace root");
    });

    it("blocks symlink escape from inside workspace", async () => {
      // Create a symlink inside the workspace pointing outside
      const symlinkPath = path.join(tmpRoot, "escape-link");
      try {
        fs.symlinkSync("/tmp", symlinkPath);
      } catch {
        // If symlink creation fails (permissions), skip gracefully
        return;
      }

      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: true,
      });

      const result = await secureTool.execute(
        { command: "pwd", workdir: symlinkPath },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("outside the allowed workspace root");

      // Cleanup
      fs.unlinkSync(symlinkPath);
    });

    it("rejects absolute command operands outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      fs.writeFileSync(outsideFile, "outside-marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `cat ${outsideFile}` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside-marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects cat option forms before outside file operands", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      fs.writeFileSync(outsideFile, "outside cat option marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `cat -n ${outsideFile}` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside cat option marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("allows parent traversal command operands that resolve inside workspace root", async () => {
      const nestedDir = path.join(tmpRoot, "nested");
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, "inside-parent.txt"), "inside parent");
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: nestedDir,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "cat ../inside-parent.txt" },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("inside parent");
    });

    it("rejects parent traversal command operands that escape workspace root", async () => {
      const nestedDir = path.join(tmpRoot, "nested");
      fs.mkdirSync(nestedDir, { recursive: true });
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: nestedDir,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "cat ../../outside-parent.txt" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("outside the allowed workspace root");
    });

    it("rejects symlink command operands that resolve outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const symlinkPath = path.join(tmpRoot, "outside-file-link");
      const atSymlinkPath = path.join(tmpRoot, "@outside-file-link");
      fs.writeFileSync(outsideFile, "outside-symlink-marker");
      try {
        fs.symlinkSync(outsideFile, symlinkPath);
        fs.symlinkSync(outsideFile, atSymlinkPath);
      } catch {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        if (fs.existsSync(atSymlinkPath)) {
          fs.unlinkSync(atSymlinkPath);
        }
        fs.rmSync(outsideDir, { recursive: true, force: true });
        return;
      }
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: "cat outside-file-link" },
          signal(),
        );
        const atLiteral = await secureTool.execute(
          { command: "cat @outside-file-link" },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside-symlink-marker");

        expect(atLiteral.isError).toBe(true);
        expect(atLiteral.content).toContain("outside the allowed workspace root");
        expect(atLiteral.content).not.toContain("outside-symlink-marker");
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        if (fs.existsSync(atSymlinkPath)) {
          fs.unlinkSync(atSymlinkPath);
        }
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("allows command operands inside workspace root", async () => {
      const insideFile = path.join(tmpRoot, "inside.txt");
      fs.writeFileSync(insideFile, "inside-marker");
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: `cat ${insideFile}` },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("inside-marker");
    });

    it("allows find within the current workspace directory", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "find . -maxdepth 1 -type f" },
        signal(),
      );

      expect(result.isError).toBeUndefined();
    });

    it("allows grep search patterns that look like absolute API paths", async () => {
      const srcDir = path.join(tmpRoot, "src");
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, "routes.txt"), "GET /v1/agent/runs\n");
      fs.writeFileSync(path.join(tmpRoot, "README.md"), "Pattern lines: R and -R\n");
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "grep -r /v1/agent/runs src" },
        signal(),
      );
      const attachedRegexp = await secureTool.execute(
        { command: "grep -eR README.md" },
        signal(),
      );
      const separateRegexp = await secureTool.execute(
        { command: "grep -e -R README.md" },
        signal(),
      );
      const endOfOptionsPattern = await secureTool.execute(
        { command: "grep -- -R README.md" },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("/v1/agent/runs");

      expect(attachedRegexp.isError).toBeUndefined();
      expect(attachedRegexp.content).toContain("Pattern lines");

      expect(separateRegexp.isError).toBeUndefined();
      expect(separateRegexp.content).toContain("-R");

      expect(endOfOptionsPattern.isError).toBeUndefined();
      expect(endOfOptionsPattern.content).toContain("-R");
    });

    it("rejects rg files-only paths outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `rg --files ${outsideDir}` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects rg ignore-file paths outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "ignore");
      fs.writeFileSync(outsideFile, "outside-rg-ignore-marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const spaced = await secureTool.execute(
          { command: `rg --ignore-file ${outsideFile} marker .` },
          signal(),
        );
        const joined = await secureTool.execute(
          { command: `rg --ignore-file=${outsideFile} marker .` },
          signal(),
        );

        expect(spaced.isError).toBe(true);
        expect(spaced.content).toContain("outside the allowed workspace root");
        expect(spaced.content).not.toContain("outside-rg-ignore-marker");

        expect(joined.isError).toBe(true);
        expect(joined.content).toContain("outside the allowed workspace root");
        expect(joined.content).not.toContain("outside-rg-ignore-marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects rg symlink-following options before traversal can escape workspace root", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const longFlag = await secureTool.execute(
        { command: "rg --follow UNIQUE_PHASE_22E ." },
        signal(),
      );
      const shortFlag = await secureTool.execute(
        { command: "rg -L UNIQUE_PHASE_22E ." },
        signal(),
      );
      const clusteredOne = await secureTool.execute(
        { command: "rg -uL UNIQUE_PHASE_22E ." },
        signal(),
      );
      const clusteredTwo = await secureTool.execute(
        { command: "rg -Lu UNIQUE_PHASE_22E ." },
        signal(),
      );

      expect(longFlag.isError).toBe(true);
      expect(longFlag.content).toContain("outside the allowed workspace root");

      expect(shortFlag.isError).toBe(true);
      expect(shortFlag.content).toContain("outside the allowed workspace root");

      expect(clusteredOne.isError).toBe(true);
      expect(clusteredOne.content).toContain("outside the allowed workspace root");

      expect(clusteredTwo.isError).toBe(true);
      expect(clusteredTwo.content).toContain("outside the allowed workspace root");
    });

    it("rejects grep file operands outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      fs.writeFileSync(outsideFile, "outside grep marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `grep -n marker ${outsideFile}` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside grep marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects grep recursive symlink-following options before traversal can escape workspace root", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const separated = await secureTool.execute(
        { command: "grep -R -S UNIQUE_PHASE_22E ." },
        signal(),
      );
      const uppercaseRecursive = await secureTool.execute(
        { command: "grep -R UNIQUE_PHASE_22E ." },
        signal(),
      );
      const clustered = await secureTool.execute(
        { command: "grep -RS UNIQUE_PHASE_22E ." },
        signal(),
      );
      const lowerClusterOne = await secureTool.execute(
        { command: "grep -Sr UNIQUE_PHASE_22E ." },
        signal(),
      );
      const lowerClusterTwo = await secureTool.execute(
        { command: "grep -rS UNIQUE_PHASE_22E ." },
        signal(),
      );
      const directoryRecurse = await secureTool.execute(
        { command: "grep -d recurse -S UNIQUE_PHASE_22E ." },
        signal(),
      );
      const attachedDirectoryRecurse = await secureTool.execute(
        { command: "grep -drecurse -S UNIQUE_PHASE_22E ." },
        signal(),
      );
      const longDirectoryRecurse = await secureTool.execute(
        { command: "grep --directories=recurse -S UNIQUE_PHASE_22E ." },
        signal(),
      );

      expect(separated.isError).toBe(true);
      expect(separated.content).toContain("outside the allowed workspace root");

      expect(uppercaseRecursive.isError).toBe(true);
      expect(uppercaseRecursive.content).toContain("outside the allowed workspace root");

      expect(clustered.isError).toBe(true);
      expect(clustered.content).toContain("outside the allowed workspace root");

      expect(lowerClusterOne.isError).toBe(true);
      expect(lowerClusterOne.content).toContain("outside the allowed workspace root");

      expect(lowerClusterTwo.isError).toBe(true);
      expect(lowerClusterTwo.content).toContain("outside the allowed workspace root");

      expect(directoryRecurse.isError).toBe(true);
      expect(directoryRecurse.content).toContain("outside the allowed workspace root");

      expect(attachedDirectoryRecurse.isError).toBe(true);
      expect(attachedDirectoryRecurse.content).toContain("outside the allowed workspace root");

      expect(longDirectoryRecurse.isError).toBe(true);
      expect(longDirectoryRecurse.content).toContain("outside the allowed workspace root");
    });

    it("rejects grep -R before symlinked directory traversal can escape workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const symlinkPath = path.join(tmpRoot, "outside-grep-link");
      fs.writeFileSync(path.join(outsideDir, "outside.txt"), "phase-22e-outside-workspace-marker");
      try {
        fs.symlinkSync(outsideDir, symlinkPath);
      } catch {
        fs.rmSync(outsideDir, { recursive: true, force: true });
        return;
      }
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: "grep -R phase-22e-outside-workspace-marker ." },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("phase-22e-outside-workspace-marker");
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects grep directory recursion with symlink following before traversal can escape workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const symlinkPath = path.join(tmpRoot, "outside-grep-directory-link");
      fs.writeFileSync(path.join(outsideDir, "outside.txt"), "phase-22e-grep-directory-marker");
      try {
        fs.symlinkSync(outsideDir, symlinkPath);
      } catch {
        fs.rmSync(outsideDir, { recursive: true, force: true });
        return;
      }
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: "grep -d recurse -S phase-22e-grep-directory-marker ." },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("phase-22e-grep-directory-marker");
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects ls recursive symlink-following options before traversal can escape workspace root", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const separated = await secureTool.execute(
        { command: "ls -R -L ." },
        signal(),
      );
      const clustered = await secureTool.execute(
        { command: "ls -RL ." },
        signal(),
      );

      expect(separated.isError).toBe(true);
      expect(separated.content).toContain("outside the allowed workspace root");

      expect(clustered.isError).toBe(true);
      expect(clustered.content).toContain("outside the allowed workspace root");
    });

    it("rejects du symlink-following options before traversal can escape workspace root", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const separated = await secureTool.execute(
        { command: "du -L ." },
        signal(),
      );
      const clustered = await secureTool.execute(
        { command: "du -aL ." },
        signal(),
      );

      expect(separated.isError).toBe(true);
      expect(separated.content).toContain("outside the allowed workspace root");

      expect(clustered.isError).toBe(true);
      expect(clustered.content).toContain("outside the allowed workspace root");
    });

    it("rejects cp recursive symlink-following options before materializing outside content", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "cp -RL . inside-copy" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("outside the allowed workspace root");
    });

    it("rejects rsync recursive symlink-following options before materializing outside content", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "rsync -rL . inside-copy" },
        signal(),
      );
      const copyDirlinks = await secureTool.execute(
        { command: "rsync -rk . inside-copy" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("outside the allowed workspace root");

      expect(copyDirlinks.isError).toBe(true);
      expect(copyDirlinks.content).toContain("outside the allowed workspace root");
    });

    it("rejects sed script file options outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.sed");
      const insideInput = path.join(tmpRoot, "inside-sed-input.txt");
      fs.writeFileSync(outsideFile, "1p\n# outside sed script marker");
      fs.writeFileSync(insideInput, "inside sed input");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `sed -nf${outsideFile} inside-sed-input.txt` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside sed script marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects awk assignment values outside workspace root before scripts can read them", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const symlinkPath = path.join(tmpRoot, "outside-awk-assignment-link");
      const atSymlinkPath = path.join(tmpRoot, "@outside-awk-assignment-link");
      fs.writeFileSync(outsideFile, "outside awk assignment marker");
      fs.writeFileSync(path.join(tmpRoot, "inside.awk"), "{ while ((getline line < P) > 0) print line }\n");
      fs.writeFileSync(path.join(tmpRoot, "inside-awk-input.txt"), "inside awk input\n");
      try {
        fs.symlinkSync(outsideFile, symlinkPath);
        fs.symlinkSync(outsideFile, atSymlinkPath);
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const attached = await secureTool.execute(
          { command: `awk -vP=${outsideFile} -f inside.awk inside-awk-input.txt` },
          signal(),
        );
        const separate = await secureTool.execute(
          { command: `awk -v P=${outsideFile} -f inside.awk inside-awk-input.txt` },
          signal(),
        );
        const bareAssignment = await secureTool.execute(
          { command: `awk -f inside.awk P=${outsideFile} inside-awk-input.txt` },
          signal(),
        );
        const symlinkedAssignment = await secureTool.execute(
          { command: "awk -f inside.awk P=outside-awk-assignment-link inside-awk-input.txt" },
          signal(),
        );
        const atSymlinkedAssignment = await secureTool.execute(
          { command: "awk -f inside.awk P=@outside-awk-assignment-link inside-awk-input.txt" },
          signal(),
        );

        expect(attached.isError).toBe(true);
        expect(attached.content).toContain("outside the allowed workspace root");
        expect(attached.content).not.toContain("outside awk assignment marker");

        expect(separate.isError).toBe(true);
        expect(separate.content).toContain("outside the allowed workspace root");
        expect(separate.content).not.toContain("outside awk assignment marker");

        expect(bareAssignment.isError).toBe(true);
        expect(bareAssignment.content).toContain("outside the allowed workspace root");
        expect(bareAssignment.content).not.toContain("outside awk assignment marker");

        expect(symlinkedAssignment.isError).toBe(true);
        expect(symlinkedAssignment.content).toContain("outside the allowed workspace root");
        expect(symlinkedAssignment.content).not.toContain("outside awk assignment marker");

        expect(atSymlinkedAssignment.isError).toBe(true);
        expect(atSymlinkedAssignment.content).toContain("outside the allowed workspace root");
        expect(atSymlinkedAssignment.content).not.toContain("outside awk assignment marker");
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        if (fs.existsSync(atSymlinkPath)) {
          fs.unlinkSync(atSymlinkPath);
        }
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("allows route-like awk assignment strings when files stay inside the workspace", async () => {
      fs.writeFileSync(path.join(tmpRoot, "inside-print.awk"), "{ print P }\n");
      fs.writeFileSync(path.join(tmpRoot, "inside-awk-print-input.txt"), "inside awk input\n");
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "awk -vP=/v1/agent/runs -f inside-print.awk inside-awk-print-input.txt" },
        signal(),
      );

      expect(result.isError).not.toBe(true);
      expect(result.content).toContain("/v1/agent/runs");
      expect(result.content).not.toContain("outside the allowed workspace root");
    });

    it("rejects awk field separator values outside workspace root before scripts can read them", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const symlinkPath = path.join(tmpRoot, "outside-awk-fs-link");
      fs.writeFileSync(outsideFile, "outside awk field separator marker");
      fs.writeFileSync(path.join(tmpRoot, "inside-fs.awk"), "{ while ((getline line < FS) > 0) print line; exit }\n");
      fs.writeFileSync(path.join(tmpRoot, "inside-awk-fs-input.txt"), "inside awk fs input\n");
      try {
        fs.symlinkSync(outsideFile, symlinkPath);
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const attached = await secureTool.execute(
          { command: `awk -F${outsideFile} -f inside-fs.awk inside-awk-fs-input.txt` },
          signal(),
        );
        const separate = await secureTool.execute(
          { command: `awk -F ${outsideFile} -f inside-fs.awk inside-awk-fs-input.txt` },
          signal(),
        );
        const longForm = await secureTool.execute(
          { command: `awk --field-separator=${outsideFile} -f inside-fs.awk inside-awk-fs-input.txt` },
          signal(),
        );
        const symlinked = await secureTool.execute(
          { command: "awk -Foutside-awk-fs-link -f inside-fs.awk inside-awk-fs-input.txt" },
          signal(),
        );

        expect(attached.isError).toBe(true);
        expect(attached.content).toContain("outside the allowed workspace root");
        expect(attached.content).not.toContain("outside awk field separator marker");

        expect(separate.isError).toBe(true);
        expect(separate.content).toContain("outside the allowed workspace root");
        expect(separate.content).not.toContain("outside awk field separator marker");

        expect(longForm.isError).toBe(true);
        expect(longForm.content).toContain("outside the allowed workspace root");
        expect(longForm.content).not.toContain("outside awk field separator marker");

        expect(symlinked.isError).toBe(true);
        expect(symlinked.content).toContain("outside the allowed workspace root");
        expect(symlinked.content).not.toContain("outside awk field separator marker");
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("allows ordinary awk slash field separators for inside-workspace files", async () => {
      fs.writeFileSync(path.join(tmpRoot, "inside-fs-slash.awk"), "{ print $1 }\n");
      fs.writeFileSync(path.join(tmpRoot, "inside-awk-slash-input.txt"), "alpha/beta\n");
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "awk -F/ -f inside-fs-slash.awk inside-awk-slash-input.txt" },
        signal(),
      );

      expect(result.isError).not.toBe(true);
      expect(result.content).toContain("alpha");
      expect(result.content).not.toContain("outside the allowed workspace root");
    });

    it("rejects sed inline read commands outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const insideInput = path.join(tmpRoot, "inside-sed-read-input.txt");
      fs.writeFileSync(outsideFile, "outside sed read marker");
      fs.writeFileSync(insideInput, "inside sed input");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `sed -n r${outsideFile} inside-sed-read-input.txt` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside sed read marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects sed regex-address read commands outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const insideInput = path.join(tmpRoot, "inside-sed-regex-input.txt");
      fs.writeFileSync(outsideFile, "outside sed regex read marker");
      fs.writeFileSync(insideInput, "Friday inside sed input");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `sed -n /Friday/r${outsideFile} inside-sed-regex-input.txt` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside sed regex read marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects sed read commands after BSD in-place extension arguments", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const insideInput = path.join(tmpRoot, "inside-sed-inplace-input.txt");
      fs.writeFileSync(outsideFile, "outside sed inplace read marker");
      fs.writeFileSync(insideInput, "inside sed input");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `sed -i .bak r${outsideFile} inside-sed-inplace-input.txt` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside sed inplace read marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects sed empty-regex read commands outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const insideInput = path.join(tmpRoot, "inside-sed-empty-regex-input.txt");
      fs.writeFileSync(outsideFile, "outside sed empty regex read marker");
      fs.writeFileSync(insideInput, "Friday inside sed input");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `sed -n -e /Friday/p -e //r${outsideFile} inside-sed-empty-regex-input.txt` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside sed empty regex read marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects sed alternate-delimiter read commands outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const insideInput = path.join(tmpRoot, "inside-sed-alt-delimiter-input.txt");
      fs.writeFileSync(outsideFile, "outside sed alternate delimiter read marker");
      fs.writeFileSync(insideInput, "Friday inside sed input");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `sed -n \\_Friday_r${outsideFile} inside-sed-alt-delimiter-input.txt` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside sed alternate delimiter read marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects sed alphanumeric alternate-delimiter read commands outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const insideInput = path.join(tmpRoot, "inside-sed-alpha-delimiter-input.txt");
      fs.writeFileSync(outsideFile, "outside sed alphanumeric delimiter read marker");
      fs.writeFileSync(insideInput, "Friday inside sed input");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `sed -n \\xFridayxr${outsideFile} inside-sed-alpha-delimiter-input.txt` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside sed alphanumeric delimiter read marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects sed escaped-delimiter read commands outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const insideInput = path.join(tmpRoot, "inside-sed-escaped-delimiter-input.txt");
      fs.writeFileSync(outsideFile, "outside sed escaped delimiter read marker");
      fs.writeFileSync(insideInput, "Friday inside sed input");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `sed -n \\F\\FridayFr${outsideFile} inside-sed-escaped-delimiter-input.txt` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside sed escaped delimiter read marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects find start paths outside workspace even after leading find options", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `find -L ${outsideDir} -maxdepth 1 -type f` },
          signal(),
        );
        const bsdExtended = await secureTool.execute(
          { command: `find -E ${outsideDir} -maxdepth 0 -type d` },
          signal(),
        );
        const bsdSafeXargs = await secureTool.execute(
          { command: `find -X ${outsideDir} -maxdepth 0 -type d` },
          signal(),
        );
        const bsdGrouped = await secureTool.execute(
          { command: `find -EX ${outsideDir} -maxdepth 0 -print` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");

        expect(bsdExtended.isError).toBe(true);
        expect(bsdExtended.content).toContain("outside the allowed workspace root");

        expect(bsdSafeXargs.isError).toBe(true);
        expect(bsdSafeXargs.content).toContain("outside the allowed workspace root");

        expect(bsdGrouped.isError).toBe(true);
        expect(bsdGrouped.content).toContain("outside the allowed workspace root");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects find -follow before traversal can escape workspace root", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "find . -follow -type f -print" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("outside the allowed workspace root");
    });

    it("rejects BSD find -f start paths outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const spaced = await secureTool.execute(
          { command: `find -f ${outsideDir} -maxdepth 1 -type f` },
          signal(),
        );
        const attached = await secureTool.execute(
          { command: `find -f${outsideDir} -maxdepth 1 -type f` },
          signal(),
        );

        expect(spaced.isError).toBe(true);
        expect(spaced.content).toContain("outside the allowed workspace root");

        expect(attached.isError).toBe(true);
        expect(attached.content).toContain("outside the allowed workspace root");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects BSD find attached -f symlink paths that resolve outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const symlinkPath = path.join(tmpRoot, "outside-find-dir-link");
      try {
        try {
          fs.symlinkSync(outsideDir, symlinkPath);
        } catch {
          return;
        }
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: "find -L -foutside-find-dir-link -type f" },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects diff operands outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      fs.writeFileSync(path.join(tmpRoot, "inside-diff.txt"), "inside diff marker");
      fs.writeFileSync(outsideFile, "outside diff marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `diff inside-diff.txt ${outsideFile}` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside diff marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects script file operands outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.py");
      fs.writeFileSync(outsideFile, "print('outside script marker')");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `python3 ${outsideFile}` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside script marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects script eval imports outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.mjs");
      fs.writeFileSync(outsideFile, "console.log('outside eval import marker')");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `node --input-type=module -e import"${outsideFile}"` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside eval import marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects script eval imports nested inside data URLs", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "node --input-type=module -e import\"data:text/javascript,import%20%27file:///tmp/outside.mjs%27\"" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("data URL");
    });

    it("rejects script eval commands when shell execution is disabled", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "node -e 0" },
        signal(),
      );
      const nodePrint = await secureTool.execute(
        { command: "node --print 1+1" },
        signal(),
      );
      const nodePrintAttached = await secureTool.execute(
        { command: "node --print=1+1" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Script eval commands are not allowed");

      expect(nodePrint.isError).toBe(true);
      expect(nodePrint.content).toContain("Script eval commands are not allowed");

      expect(nodePrintAttached.isError).toBe(true);
      expect(nodePrintAttached.content).toContain("Script eval commands are not allowed");
    });

    it("allows node syntax checks for script files inside the workspace", async () => {
      fs.writeFileSync(path.join(tmpRoot, "inside-check.mjs"), "export const ok = true;\n");
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "node -c inside-check.mjs" },
        signal(),
      );

      expect(result.isError).not.toBe(true);
    });

    it("does not mistake node preload option values for clustered eval flags", async () => {
      fs.writeFileSync(path.join(tmpRoot, "preload.js"), "globalThis.fridayPreloadOk = true;\n");
      fs.writeFileSync(path.join(tmpRoot, "inside-node.js"), "if (!globalThis.fridayPreloadOk) process.exit(1);\n");
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const attachedResult = await secureTool.execute(
        { command: "node -r./preload.js inside-node.js" },
        signal(),
      );
      const spacedResult = await secureTool.execute(
        { command: "node -r ./preload.js inside-node.js" },
        signal(),
      );

      expect(attachedResult.content).not.toContain("Script eval commands are not allowed");
      expect(spacedResult.isError).not.toBe(true);
      expect(spacedResult.content).not.toContain("Script eval commands are not allowed");
    });

    it("does not scan ruby or perl attached option values for eval flags", async () => {
      fs.writeFileSync(path.join(tmpRoot, "inside.rb"), "puts 'inside ruby option value marker'\n");
      fs.writeFileSync(path.join(tmpRoot, "inside.pl"), "print \"inside perl option value marker\\n\";\n");
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const rubyEncoding = await secureTool.execute(
        { command: "ruby -Eeuc-jp inside.rb" },
        signal(),
      );
      const rubyPattern = await secureTool.execute(
        { command: "ruby -Fexample inside.rb" },
        signal(),
      );
      const rubyInPlace = await secureTool.execute(
        { command: "ruby -iexample inside.rb" },
        signal(),
      );
      const rubyDirectory = await secureTool.execute(
        { command: "ruby -xexample inside.rb" },
        signal(),
      );
      const rubyKanji = await secureTool.execute(
        { command: "ruby -Ku inside.rb" },
        signal(),
      );
      const perlEncoding = await secureTool.execute(
        { command: "perl -CE inside.pl" },
        signal(),
      );
      const perlDebug = await secureTool.execute(
        { command: "perl -Dexample inside.pl" },
        signal(),
      );
      const perlPattern = await secureTool.execute(
        { command: "perl -Fexample inside.pl" },
        signal(),
      );
      const perlInPlace = await secureTool.execute(
        { command: "perl -iexample inside.pl" },
        signal(),
      );

      expect(rubyEncoding.content).not.toContain("Script eval commands are not allowed");
      expect(rubyPattern.content).not.toContain("Script eval commands are not allowed");
      expect(rubyInPlace.content).not.toContain("Script eval commands are not allowed");
      expect(rubyDirectory.content).not.toContain("Script eval commands are not allowed");
      expect(rubyKanji.content).not.toContain("Script eval commands are not allowed");
      expect(perlEncoding.content).not.toContain("Script eval commands are not allowed");
      expect(perlDebug.content).not.toContain("Script eval commands are not allowed");
      expect(perlPattern.content).not.toContain("Script eval commands are not allowed");
      expect(perlInPlace.content).not.toContain("Script eval commands are not allowed");
    });

    it("rejects ruby load path list components that resolve outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const symlinkPath = path.join(tmpRoot, "outside-ruby-lib");
      fs.writeFileSync(path.join(outsideDir, "leak.rb"), "puts 'outside ruby load path marker'\n");
      fs.mkdirSync(path.join(tmpRoot, "lib"), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, "inside-load-path.rb"), "puts 'inside ruby script marker'\n");
      try {
        fs.symlinkSync(outsideDir, symlinkPath);
      } catch {
        fs.rmSync(outsideDir, { recursive: true, force: true });
        return;
      }
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const attached = await secureTool.execute(
          { command: `ruby -Ioutside-ruby-lib${path.delimiter}lib -rleak inside-load-path.rb` },
          signal(),
        );
        const separate = await secureTool.execute(
          { command: `ruby -I outside-ruby-lib${path.delimiter}lib -rleak inside-load-path.rb` },
          signal(),
        );
        const clustered = await secureTool.execute(
          { command: `ruby -wIoutside-ruby-lib${path.delimiter}lib -rleak inside-load-path.rb` },
          signal(),
        );

        expect(attached.isError).toBe(true);
        expect(attached.content).toContain("outside the allowed workspace root");
        expect(attached.content).not.toContain("outside ruby load path marker");

        expect(separate.isError).toBe(true);
        expect(separate.content).toContain("outside the allowed workspace root");
        expect(separate.content).not.toContain("outside ruby load path marker");

        expect(clustered.isError).toBe(true);
        expect(clustered.content).toContain("outside the allowed workspace root");
        expect(clustered.content).not.toContain("outside ruby load path marker");
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects perl eval clustered after -0 attached input-mode values", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.pl");
      const symlinkPath = path.join(tmpRoot, "outside-perl-link");
      fs.writeFileSync(outsideFile, "print 'outside perl clustered eval marker';\n");
      try {
        fs.symlinkSync(outsideFile, symlinkPath);
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: "perl -0777edo+q:outside-perl-link:" },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("Script eval commands are not allowed");
        expect(result.content).not.toContain("outside perl clustered eval marker");
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects python command eval when shell execution is disabled", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "python3 -c 0" },
        signal(),
      );
      const isolatedCluster = await secureTool.execute(
        { command: "python3 -Ic 0" },
        signal(),
      );
      const optimizedCluster = await secureTool.execute(
        { command: "python3 -OOc 0" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Script eval commands are not allowed");

      expect(isolatedCluster.isError).toBe(true);
      expect(isolatedCluster.content).toContain("Script eval commands are not allowed");

      expect(optimizedCluster.isError).toBe(true);
      expect(optimizedCluster.content).toContain("Script eval commands are not allowed");
    });

    it("does not scan Python value option values for clustered eval flags", async () => {
      fs.writeFileSync(path.join(tmpRoot, "inside-python.py"), "print('inside python option value marker')\n");
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const moduleResult = await secureTool.execute(
        { command: "python3 -m compileall inside-python.py" },
        signal(),
      );

      expect(moduleResult.content).not.toContain("Script eval commands are not allowed");
    });

    it("rejects script eval constructed paths that cannot be statically validated", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      fs.writeFileSync(outsideFile, "outside constructed eval marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `ruby -e IO.send:copy_stream,?/+"${outsideFile.slice(1)}",STDOUT` },
          signal(),
        );
        const clusteredRubyEval = await secureTool.execute(
          { command: `ruby -weIO.send:copy_stream,?/+"${outsideFile.slice(1)}",STDOUT` },
          signal(),
        );
        const zeroModeClusteredRubyEval = await secureTool.execute(
          { command: `ruby -0777eIO.send:copy_stream,?/+"${outsideFile.slice(1)}",STDOUT` },
          signal(),
        );
        const kanjiModeClusteredRubyEval = await secureTool.execute(
          { command: `ruby -KueIO.send:copy_stream,?/+"${outsideFile.slice(1)}",STDOUT` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toMatch(/Script eval commands are not allowed|outside the allowed workspace root/u);
        expect(result.content).not.toContain("outside constructed eval marker");

        expect(clusteredRubyEval.isError).toBe(true);
        expect(clusteredRubyEval.content).toContain("Script eval commands are not allowed");
        expect(clusteredRubyEval.content).not.toContain("outside constructed eval marker");

        expect(zeroModeClusteredRubyEval.isError).toBe(true);
        expect(zeroModeClusteredRubyEval.content).toContain("Script eval commands are not allowed");
        expect(zeroModeClusteredRubyEval.content).not.toContain("outside constructed eval marker");

        expect(kanjiModeClusteredRubyEval.isError).toBe(true);
        expect(kanjiModeClusteredRubyEval.content).toContain("Script eval commands are not allowed");
        expect(kanjiModeClusteredRubyEval.content).not.toContain("outside constructed eval marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects ruby eval loaders outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.rb");
      const symlinkPath = path.join(tmpRoot, "outside-ruby-link");
      fs.writeFileSync(outsideFile, "puts 'outside ruby eval marker'");
      try {
        try {
          fs.symlinkSync(outsideFile, symlinkPath);
        } catch {
          return;
        }
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const absolute = await secureTool.execute(
          { command: `ruby -e load"${outsideFile}"` },
          signal(),
        );
        const symlinked = await secureTool.execute(
          { command: "ruby -e load\"outside-ruby-link\"" },
          signal(),
        );

        expect(absolute.isError).toBe(true);
        expect(absolute.content).toContain("outside the allowed workspace root");
        expect(absolute.content).not.toContain("outside ruby eval marker");

        expect(symlinked.isError).toBe(true);
        expect(symlinked.content).toContain("outside the allowed workspace root");
        expect(symlinked.content).not.toContain("outside ruby eval marker");
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects ruby eval file reads outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      fs.writeFileSync(outsideFile, "outside ruby eval read marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const fileRead = await secureTool.execute(
          { command: `ruby -e File.read"${outsideFile}"` },
          signal(),
        );
        const ioRead = await secureTool.execute(
          { command: `ruby -e IO.read"${outsideFile}"` },
          signal(),
        );
        const fileBinread = await secureTool.execute(
          { command: `ruby -e File.binread"${outsideFile}"` },
          signal(),
        );
        const ioBinread = await secureTool.execute(
          { command: `ruby -e IO.binread"${outsideFile}"` },
          signal(),
        );
        const fileReadlines = await secureTool.execute(
          { command: `ruby -e File.readlines"${outsideFile}"` },
          signal(),
        );
        const ioReadlines = await secureTool.execute(
          { command: `ruby -e IO.readlines"${outsideFile}"` },
          signal(),
        );
        const fileNamespaceRead = await secureTool.execute(
          { command: `ruby -e File::read"${outsideFile}"` },
          signal(),
        );
        const ioNamespaceBinread = await secureTool.execute(
          { command: `ruby -e IO::binread"${outsideFile}"` },
          signal(),
        );

        expect(fileRead.isError).toBe(true);
        expect(fileRead.content).toContain("outside the allowed workspace root");
        expect(fileRead.content).not.toContain("outside ruby eval read marker");

        expect(ioRead.isError).toBe(true);
        expect(ioRead.content).toContain("outside the allowed workspace root");
        expect(ioRead.content).not.toContain("outside ruby eval read marker");

        expect(fileBinread.isError).toBe(true);
        expect(fileBinread.content).toContain("outside the allowed workspace root");
        expect(fileBinread.content).not.toContain("outside ruby eval read marker");

        expect(ioBinread.isError).toBe(true);
        expect(ioBinread.content).toContain("outside the allowed workspace root");
        expect(ioBinread.content).not.toContain("outside ruby eval read marker");

        expect(fileReadlines.isError).toBe(true);
        expect(fileReadlines.content).toContain("outside the allowed workspace root");
        expect(fileReadlines.content).not.toContain("outside ruby eval read marker");

        expect(ioReadlines.isError).toBe(true);
        expect(ioReadlines.content).toContain("outside the allowed workspace root");
        expect(ioReadlines.content).not.toContain("outside ruby eval read marker");

        expect(fileNamespaceRead.isError).toBe(true);
        expect(fileNamespaceRead.content).toContain("outside the allowed workspace root");
        expect(fileNamespaceRead.content).not.toContain("outside ruby eval read marker");

        expect(ioNamespaceBinread.isError).toBe(true);
        expect(ioNamespaceBinread.content).toContain("outside the allowed workspace root");
        expect(ioNamespaceBinread.content).not.toContain("outside ruby eval read marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects ruby eval file open aliases outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      fs.writeFileSync(outsideFile, "outside ruby eval open marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const fileNew = await secureTool.execute(
          { command: `ruby -e File.new"${outsideFile}".read` },
          signal(),
        );
        const bareOpen = await secureTool.execute(
          { command: `ruby -e open"${outsideFile}".read` },
          signal(),
        );
        const kernelOpen = await secureTool.execute(
          { command: `ruby -e Kernel.open"${outsideFile}".read` },
          signal(),
        );
        const fileForeach = await secureTool.execute(
          { command: `ruby -e File.foreach"${outsideFile}"` },
          signal(),
        );

        expect(fileNew.isError).toBe(true);
        expect(fileNew.content).toContain("outside the allowed workspace root");
        expect(fileNew.content).not.toContain("outside ruby eval open marker");

        expect(bareOpen.isError).toBe(true);
        expect(bareOpen.content).toContain("outside the allowed workspace root");
        expect(bareOpen.content).not.toContain("outside ruby eval open marker");

        expect(kernelOpen.isError).toBe(true);
        expect(kernelOpen.content).toContain("outside the allowed workspace root");
        expect(kernelOpen.content).not.toContain("outside ruby eval open marker");

        expect(fileForeach.isError).toBe(true);
        expect(fileForeach.content).toContain("outside the allowed workspace root");
        expect(fileForeach.content).not.toContain("outside ruby eval open marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects ruby eval copy_stream paths outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const outsideTarget = path.join(outsideDir, "copied.txt");
      fs.writeFileSync(outsideFile, "outside ruby copy stream marker");
      fs.writeFileSync(path.join(tmpRoot, "ruby-copy-source.txt"), "inside ruby copy stream marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const fileSource = await secureTool.execute(
          { command: `ruby -e File.copy_stream"${outsideFile}","/dev/stdout"` },
          signal(),
        );
        const ioSource = await secureTool.execute(
          { command: `ruby -e IO.copy_stream"${outsideFile}","/dev/stdout"` },
          signal(),
        );
        const fileTarget = await secureTool.execute(
          { command: `ruby -e File.copy_stream"ruby-copy-source.txt","${outsideTarget}"` },
          signal(),
        );
        const namespaceSource = await secureTool.execute(
          { command: `ruby -e File::copy_stream"${outsideFile}","/dev/stdout"` },
          signal(),
        );

        expect(fileSource.isError).toBe(true);
        expect(fileSource.content).toContain("outside the allowed workspace root");
        expect(fileSource.content).not.toContain("outside ruby copy stream marker");

        expect(ioSource.isError).toBe(true);
        expect(ioSource.content).toContain("outside the allowed workspace root");
        expect(ioSource.content).not.toContain("outside ruby copy stream marker");

        expect(fileTarget.isError).toBe(true);
        expect(fileTarget.content).toContain("outside the allowed workspace root");
        expect(fs.existsSync(outsideTarget)).toBe(false);

        expect(namespaceSource.isError).toBe(true);
        expect(namespaceSource.content).toContain("outside the allowed workspace root");
        expect(namespaceSource.content).not.toContain("outside ruby copy stream marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects ruby eval dynamic dispatch paths outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      fs.writeFileSync(outsideFile, "outside ruby send marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const sendCopyStream = await secureTool.execute(
          { command: `ruby -e IO.send:copy_stream,"${outsideFile}",STDOUT` },
          signal(),
        );
        const sendRead = await secureTool.execute(
          { command: `ruby -e File.send:read,"${outsideFile}"` },
          signal(),
        );
        const publicSendOpen = await secureTool.execute(
          { command: `ruby -e File.public_send:open,"${outsideFile}"` },
          signal(),
        );
        const stringSendCopyStream = await secureTool.execute(
          { command: `ruby -e IO.send"copy_stream","${outsideFile}",STDOUT` },
          signal(),
        );

        expect(sendCopyStream.isError).toBe(true);
        expect(sendCopyStream.content).toContain("outside the allowed workspace root");
        expect(sendCopyStream.content).not.toContain("outside ruby send marker");

        expect(sendRead.isError).toBe(true);
        expect(sendRead.content).toContain("outside the allowed workspace root");
        expect(sendRead.content).not.toContain("outside ruby send marker");

        expect(publicSendOpen.isError).toBe(true);
        expect(publicSendOpen.content).toContain("outside the allowed workspace root");
        expect(publicSendOpen.content).not.toContain("outside ruby send marker");

        expect(stringSendCopyStream.isError).toBe(true);
        expect(stringSendCopyStream.content).toContain("outside the allowed workspace root");
        expect(stringSendCopyStream.content).not.toContain("outside ruby send marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects perl eval loaders outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.pl");
      fs.writeFileSync(outsideFile, "print 'outside perl eval marker'");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `perl -e do"${outsideFile}"` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside perl eval marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects perl q-delimited eval loaders outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.pl");
      fs.writeFileSync(outsideFile, "print 'outside perl q eval marker'");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const doLoader = await secureTool.execute(
          { command: `perl -e do+q[${outsideFile}]` },
          signal(),
        );
        const requireLoader = await secureTool.execute(
          { command: `perl -e require+q[${outsideFile}]` },
          signal(),
        );
        const colonLoader = await secureTool.execute(
          { command: `perl -e do+q:${outsideFile}:` },
          signal(),
        );
        const commaLoader = await secureTool.execute(
          { command: `perl -e require+q,${outsideFile},` },
          signal(),
        );
        const doubleQuotedDoLoader = await secureTool.execute(
          { command: `perl -e do+qq:${outsideFile}:` },
          signal(),
        );
        const doubleQuotedRequireLoader = await secureTool.execute(
          { command: `perl -e require+qq,${outsideFile},` },
          signal(),
        );
        const wordListDoLoader = await secureTool.execute(
          { command: `perl -e do+qw:${outsideFile}:` },
          signal(),
        );
        const wordListRequireLoader = await secureTool.execute(
          { command: `perl -e require+qw,${outsideFile},` },
          signal(),
        );

        expect(doLoader.isError).toBe(true);
        expect(doLoader.content).toContain("outside the allowed workspace root");
        expect(doLoader.content).not.toContain("outside perl q eval marker");

        expect(requireLoader.isError).toBe(true);
        expect(requireLoader.content).toContain("outside the allowed workspace root");
        expect(requireLoader.content).not.toContain("outside perl q eval marker");

        expect(colonLoader.isError).toBe(true);
        expect(colonLoader.content).toContain("outside the allowed workspace root");
        expect(colonLoader.content).not.toContain("outside perl q eval marker");

        expect(commaLoader.isError).toBe(true);
        expect(commaLoader.content).toContain("outside the allowed workspace root");
        expect(commaLoader.content).not.toContain("outside perl q eval marker");

        expect(doubleQuotedDoLoader.isError).toBe(true);
        expect(doubleQuotedDoLoader.content).toContain("outside the allowed workspace root");
        expect(doubleQuotedDoLoader.content).not.toContain("outside perl q eval marker");

        expect(doubleQuotedRequireLoader.isError).toBe(true);
        expect(doubleQuotedRequireLoader.content).toContain("outside the allowed workspace root");
        expect(doubleQuotedRequireLoader.content).not.toContain("outside perl q eval marker");

        expect(wordListDoLoader.isError).toBe(true);
        expect(wordListDoLoader.content).toContain("outside the allowed workspace root");
        expect(wordListDoLoader.content).not.toContain("outside perl q eval marker");

        expect(wordListRequireLoader.isError).toBe(true);
        expect(wordListRequireLoader.content).toContain("outside the allowed workspace root");
        expect(wordListRequireLoader.content).not.toContain("outside perl q eval marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects perl eval open file paths outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      fs.writeFileSync(outsideFile, "outside perl eval open marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const literalOpen = await secureTool.execute(
          { command: `perl -e open+F,"${outsideFile}"and+print+readline+F` },
          signal(),
        );
        const qOpen = await secureTool.execute(
          { command: `perl -e open+F,q[${outsideFile}]and+print+readline+F` },
          signal(),
        );

        expect(literalOpen.isError).toBe(true);
        expect(literalOpen.content).toContain("outside the allowed workspace root");
        expect(literalOpen.content).not.toContain("outside perl eval open marker");

        expect(qOpen.isError).toBe(true);
        expect(qOpen.content).toContain("outside the allowed workspace root");
        expect(qOpen.content).not.toContain("outside perl eval open marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects perl eval ARGV file paths outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      fs.writeFileSync(outsideFile, "outside perl eval argv marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const literalArgv = await secureTool.execute(
          { command: `perl -e @ARGV="${outsideFile}",print+readline` },
          signal(),
        );
        const qArgv = await secureTool.execute(
          { command: `perl -e @ARGV=q[${outsideFile}],print+readline` },
          signal(),
        );
        const indexedLiteralArgv = await secureTool.execute(
          { command: `perl -e @ARGV[0]="${outsideFile}",print+readline` },
          signal(),
        );
        const indexedQArgv = await secureTool.execute(
          { command: `perl -e @ARGV[0]=q[${outsideFile}],print+readline` },
          signal(),
        );
        const signedIndexQArgv = await secureTool.execute(
          { command: `perl -e @ARGV[+0]=q[${outsideFile}],print+readline` },
          signal(),
        );
        const featureEvalArgv = await secureTool.execute(
          { command: `perl -E @ARGV=q[${outsideFile}],say+readline` },
          signal(),
        );

        expect(literalArgv.isError).toBe(true);
        expect(literalArgv.content).toContain("outside the allowed workspace root");
        expect(literalArgv.content).not.toContain("outside perl eval argv marker");

        expect(qArgv.isError).toBe(true);
        expect(qArgv.content).toContain("outside the allowed workspace root");
        expect(qArgv.content).not.toContain("outside perl eval argv marker");

        expect(indexedLiteralArgv.isError).toBe(true);
        expect(indexedLiteralArgv.content).toContain("outside the allowed workspace root");
        expect(indexedLiteralArgv.content).not.toContain("outside perl eval argv marker");

        expect(indexedQArgv.isError).toBe(true);
        expect(indexedQArgv.content).toContain("outside the allowed workspace root");
        expect(indexedQArgv.content).not.toContain("outside perl eval argv marker");

        expect(signedIndexQArgv.isError).toBe(true);
        expect(signedIndexQArgv.content).toContain("outside the allowed workspace root");
        expect(signedIndexQArgv.content).not.toContain("outside perl eval argv marker");

        expect(featureEvalArgv.isError).toBe(true);
        expect(featureEvalArgv.content).toContain("Script eval commands are not allowed");
        expect(featureEvalArgv.content).not.toContain("outside perl eval argv marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects python isolation option before outside script file operands", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.py");
      fs.writeFileSync(outsideFile, "print('outside isolated script marker')");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `python3 -I ${outsideFile}` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside isolated script marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects node require option paths outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.js");
      fs.writeFileSync(outsideFile, "console.log('outside require marker')");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const spaced = await secureTool.execute(
          { command: `node --require ${outsideFile} -e 0` },
          signal(),
        );
        const joined = await secureTool.execute(
          { command: `node --require=${outsideFile} -e 0` },
          signal(),
        );

        expect(spaced.isError).toBe(true);
        expect(spaced.content).toContain("outside the allowed workspace root");
        expect(spaced.content).not.toContain("outside require marker");
        expect(joined.isError).toBe(true);
        expect(joined.content).toContain("outside the allowed workspace root");
        expect(joined.content).not.toContain("outside require marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects node env-file option paths outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.env");
      fs.writeFileSync(outsideFile, "VALUE=outside-env-marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const spaced = await secureTool.execute(
          { command: `node --env-file ${outsideFile} -p process.env.VALUE` },
          signal(),
        );
        const joined = await secureTool.execute(
          { command: `node --env-file=${outsideFile} -p process.env.VALUE` },
          signal(),
        );

        expect(spaced.isError).toBe(true);
        expect(spaced.content).toContain("outside the allowed workspace root");
        expect(spaced.content).not.toContain("outside-env-marker");
        expect(joined.isError).toBe(true);
        expect(joined.content).toContain("outside the allowed workspace root");
        expect(joined.content).not.toContain("outside-env-marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects node env-file bare symlink paths outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.env");
      const symlinkPath = path.join(tmpRoot, "outside-env-link");
      fs.writeFileSync(outsideFile, "VALUE=outside-env-link-marker");
      try {
        fs.symlinkSync(outsideFile, symlinkPath);
      } catch {
        fs.rmSync(outsideDir, { recursive: true, force: true });
        return;
      }
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const spaced = await secureTool.execute(
          { command: "node --env-file outside-env-link -p process.env.VALUE" },
          signal(),
        );
        const joined = await secureTool.execute(
          { command: "node --env-file=outside-env-link -p process.env.VALUE" },
          signal(),
        );

        expect(spaced.isError).toBe(true);
        expect(spaced.content).toContain("outside the allowed workspace root");
        expect(spaced.content).not.toContain("outside-env-link-marker");
        expect(joined.isError).toBe(true);
        expect(joined.content).toContain("outside the allowed workspace root");
        expect(joined.content).not.toContain("outside-env-link-marker");
      } finally {
        fs.unlinkSync(symlinkPath);
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects custom exec env before it can inject outside path reads", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.js");
      fs.writeFileSync(outsideFile, "console.log('outside env injected marker')");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const nodeOptions = await secureTool.execute(
          {
            command: "node -e 0",
            env: { NODE_OPTIONS: `--require=${outsideFile}` },
          },
          signal(),
        );
        const gitConfig = await secureTool.execute(
          {
            command: "git config --global --list",
            env: { GIT_CONFIG_GLOBAL: outsideFile },
          },
          signal(),
        );

        expect(nodeOptions.isError).toBe(true);
        expect(nodeOptions.content).toContain("Custom environment variables are not allowed");
        expect(nodeOptions.content).not.toContain("outside env injected marker");
        expect(gitConfig.isError).toBe(true);
        expect(gitConfig.content).toContain("Custom environment variables are not allowed");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects inline env assignments before they can inject outside path reads", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.js");
      fs.writeFileSync(outsideFile, "console.log('outside inline env marker')");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `env NODE_OPTIONS=--require=${outsideFile} node -e 0` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("Inline environment assignments");
        expect(result.content).not.toContain("outside inline env marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects env-injected file URL reads nested in data URLs", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        {
          command: "node -e 0",
          env: {
            NODE_OPTIONS: " --import=data:text/javascript,import%20%27file:///tmp/outside.mjs%27",
          },
        },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Custom environment variables are not allowed");
    });

    it("rejects git -C paths outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `git -C ${outsideDir} status` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects git no-index diff operands outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      fs.writeFileSync(path.join(tmpRoot, "inside-git-diff.txt"), "inside git diff marker");
      fs.writeFileSync(outsideFile, "outside git diff marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `git diff --no-index inside-git-diff.txt ${outsideFile}` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside git diff marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects bare symlink operands that resolve outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const symlinkPath = path.join(tmpRoot, "outside-sort-link");
      fs.writeFileSync(outsideFile, "outside sort marker");
      try {
        fs.symlinkSync(outsideFile, symlinkPath);
      } catch {
        fs.rmSync(outsideDir, { recursive: true, force: true });
        return;
      }
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: "sort outside-sort-link" },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside sort marker");
      } finally {
        fs.unlinkSync(symlinkPath);
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects uniq bare symlink operands that resolve outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const symlinkPath = path.join(tmpRoot, "outside-uniq-link");
      fs.writeFileSync(outsideFile, "outside uniq marker");
      try {
        fs.symlinkSync(outsideFile, symlinkPath);
      } catch {
        fs.rmSync(outsideDir, { recursive: true, force: true });
        return;
      }
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: "uniq outside-uniq-link" },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside uniq marker");
      } finally {
        fs.unlinkSync(symlinkPath);
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects git no-index bare symlink operands that resolve outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const symlinkPath = path.join(tmpRoot, "outside-git-diff-link");
      fs.writeFileSync(path.join(tmpRoot, "inside-git-diff-link.txt"), "inside git diff link marker");
      fs.writeFileSync(outsideFile, "outside git diff link marker");
      try {
        fs.symlinkSync(outsideFile, symlinkPath);
      } catch {
        fs.rmSync(outsideDir, { recursive: true, force: true });
        return;
      }
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: "git diff --no-index inside-git-diff-link.txt outside-git-diff-link" },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside git diff link marker");
      } finally {
        fs.unlinkSync(symlinkPath);
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects file URL operands before curl can read outside workspace", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "curl file:///tmp/friday-outside.txt" },
        signal(),
      );
      const singleSlash = await secureTool.execute(
        { command: "curl -s file:/tmp/friday-outside.txt" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("file URL");

      expect(singleSlash.isError).toBe(true);
      expect(singleSlash.content).toContain("file URL");
    });

    it("rejects curl config file options outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "curlrc");
      fs.writeFileSync(outsideFile, "url = \"file:///tmp/outside.txt\"");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `curl -K${outsideFile}` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("file:///tmp/outside.txt");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects curl write-out file references outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "curl-format");
      fs.writeFileSync(outsideFile, "outside curl write-out marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const spaced = await secureTool.execute(
          { command: `curl -w @${outsideFile} http://127.0.0.1:9` },
          signal(),
        );
        const joined = await secureTool.execute(
          { command: `curl -w@${outsideFile} http://127.0.0.1:9` },
          signal(),
        );

        expect(spaced.isError).toBe(true);
        expect(spaced.content).toContain("outside the allowed workspace root");
        expect(spaced.content).not.toContain("outside curl write-out marker");

        expect(joined.isError).toBe(true);
        expect(joined.content).toContain("outside the allowed workspace root");
        expect(joined.content).not.toContain("outside curl write-out marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects curl upload and data file references outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "payload.txt");
      fs.writeFileSync(outsideFile, "outside curl payload marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const upload = await secureTool.execute(
          { command: `curl -T${outsideFile} http://127.0.0.1:9/upload` },
          signal(),
        );
        const data = await secureTool.execute(
          { command: `curl --data-binary @${outsideFile} http://127.0.0.1:9/upload` },
          signal(),
        );
        const joinedData = await secureTool.execute(
          { command: `curl --data-binary=@${outsideFile} http://127.0.0.1:9/upload` },
          signal(),
        );

        expect(upload.isError).toBe(true);
        expect(upload.content).toContain("outside the allowed workspace root");
        expect(upload.content).not.toContain("outside curl payload marker");

        expect(data.isError).toBe(true);
        expect(data.content).toContain("outside the allowed workspace root");
        expect(data.content).not.toContain("outside curl payload marker");

        expect(joinedData.isError).toBe(true);
        expect(joinedData.content).toContain("outside the allowed workspace root");
        expect(joinedData.content).not.toContain("outside curl payload marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects curl header and certificate short-option file references outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideHeaderFile = path.join(outsideDir, "headers.txt");
      const outsideCertFile = path.join(outsideDir, "client.pem");
      fs.writeFileSync(outsideHeaderFile, "X-Outside: outside curl header marker");
      fs.writeFileSync(outsideCertFile, "outside curl cert marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const header = await secureTool.execute(
          { command: `curl -H@${outsideHeaderFile} http://127.0.0.1:9` },
          signal(),
        );
        const cert = await secureTool.execute(
          { command: `curl -E${outsideCertFile} https://127.0.0.1:9` },
          signal(),
        );

        expect(header.isError).toBe(true);
        expect(header.content).toContain("outside the allowed workspace root");
        expect(header.content).not.toContain("outside curl header marker");

        expect(cert.isError).toBe(true);
        expect(cert.content).toContain("outside the allowed workspace root");
        expect(cert.content).not.toContain("outside curl cert marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects curl name-at file references outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "query.txt");
      fs.writeFileSync(outsideFile, "outside curl name-at marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const dataUrlencode = await secureTool.execute(
          { command: `curl --data-urlencode name@${outsideFile} http://127.0.0.1:9` },
          signal(),
        );
        const urlQuery = await secureTool.execute(
          { command: `curl --url-query name@${outsideFile} http://127.0.0.1:9` },
          signal(),
        );
        const variable = await secureTool.execute(
          { command: `curl --variable name@${outsideFile} http://127.0.0.1:9` },
          signal(),
        );

        expect(dataUrlencode.isError).toBe(true);
        expect(dataUrlencode.content).toContain("outside the allowed workspace root");
        expect(dataUrlencode.content).not.toContain("outside curl name-at marker");

        expect(urlQuery.isError).toBe(true);
        expect(urlQuery.content).toContain("outside the allowed workspace root");
        expect(urlQuery.content).not.toContain("outside curl name-at marker");

        expect(variable.isError).toBe(true);
        expect(variable.content).toContain("outside the allowed workspace root");
        expect(variable.content).not.toContain("outside curl name-at marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects curl name-at symlink references that resolve outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "query.txt");
      const symlinkPath = path.join(tmpRoot, "outside-query-link");
      fs.writeFileSync(outsideFile, "outside curl name-at symlink marker");
      try {
        try {
          fs.symlinkSync(outsideFile, symlinkPath);
        } catch {
          return;
        }
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: "curl --data-urlencode name@outside-query-link http://127.0.0.1:9" },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside curl name-at symlink marker");
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects attached short-option paths outside workspace for unlisted programs", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.tar");
      fs.writeFileSync(outsideFile, "outside tar marker");
      try {
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: `tar -xOf${outsideFile} marker.txt` },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside tar marker");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects attached short-option bare symlink paths for unlisted programs", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const symlinkPath = path.join(tmpRoot, "outside-base64-link");
      fs.writeFileSync(outsideFile, "outside base64 marker");
      try {
        try {
          fs.symlinkSync(outsideFile, symlinkPath);
        } catch {
          return;
        }
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: "base64 -ioutside-base64-link" },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside base64 marker");
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects tar attached short-option symlink paths that resolve outside workspace root", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-exec-outside-"));
      const outsideFile = path.join(outsideDir, "outside.tar");
      const symlinkPath = path.join(tmpRoot, "outside-tar-link");
      fs.writeFileSync(outsideFile, "outside tar symlink marker");
      try {
        try {
          fs.symlinkSync(outsideFile, symlinkPath);
        } catch {
          return;
        }
        const secureTool = createFridayAgentExecTool({
          defaultWorkdir: tmpRoot,
          workspaceRoot: tmpRoot,
          allowShell: false,
        });

        const result = await secureTool.execute(
          { command: "tar -xOfoutside-tar-link marker.txt" },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("outside the allowed workspace root");
        expect(result.content).not.toContain("outside tar symlink marker");
      } finally {
        if (fs.existsSync(symlinkPath)) {
          fs.unlinkSync(symlinkPath);
        }
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects tar symlink-dereference traversal options before traversal can escape workspace root", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const dereference = await secureTool.execute(
        { command: "tar -chf - ." },
        signal(),
      );
      const lengthFollow = await secureTool.execute(
        { command: "tar -cLf - ." },
        signal(),
      );

      expect(dereference.isError).toBe(true);
      expect(dereference.content).toContain("outside the allowed workspace root");

      expect(lengthFollow.isError).toBe(true);
      expect(lengthFollow.content).toContain("outside the allowed workspace root");
    });

    it("rejects pax symlink-following options before traversal can escape workspace root", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "pax -w -L ." },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("outside the allowed workspace root");
    });

    it("rejects zip default symlink-dereference behavior before traversal can escape workspace root", async () => {
      const secureTool = createFridayAgentExecTool({
        defaultWorkdir: tmpRoot,
        workspaceRoot: tmpRoot,
        allowShell: false,
      });

      const result = await secureTool.execute(
        { command: "zip -0 -r - ." },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("outside the allowed workspace root");
    });
  });

  describe("approval-gated destructive commands", () => {
    it("blocks destructive file deletion commands pending approval", async () => {
      const result = await tool.execute(
        { command: "rm database.dump" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Approval required");
      expect(result.content).toContain("destructive");
    });

    it("blocks shell-driven token mutation commands pending approval", async () => {
      const result = await tool.execute(
        { command: "sed apiToken config.json" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Approval required");
      expect(result.content).toContain("token");
    });
  });

  describe("shell mode behavior", () => {
    let tmpDir: string;

    // Create a temp dir with a test file for glob expansion tests
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-shell-test-"));
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "// test file");

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("shell:false does not expand globs — echo *.ts outputs literal", async () => {
      const noShellTool = createFridayAgentExecTool({
        defaultWorkdir: tmpDir,
        workspaceRoot: tmpDir,
        allowShell: false,
      });

      const result = await noShellTool.execute(
        { command: "echo *.ts", workdir: tmpDir },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      // Without shell, echo receives the literal argument "*.ts"
      expect(result.content.trim()).toBe("*.ts");
    });

    it("shell:true enables glob expansion — echo *.ts outputs filenames", async () => {
      const shellTool = createFridayAgentExecTool({
        defaultWorkdir: tmpDir,
        workspaceRoot: tmpDir,
        allowShell: true,
      });

      const result = await shellTool.execute(
        { command: "echo *.ts", workdir: tmpDir },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      // With shell, the glob expands to the actual filename
      expect(result.content.trim()).toContain("a.ts");
    });
  });
});
