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
