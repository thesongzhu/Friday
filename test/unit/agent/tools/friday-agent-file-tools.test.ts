import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createFridayAgentFileTools } from "#agent";

describe("FridayAgentFileTools", () => {
  let tools: ReturnType<typeof createFridayAgentFileTools>;
  let readTool: ReturnType<typeof createFridayAgentFileTools>[number];
  let writeTool: ReturnType<typeof createFridayAgentFileTools>[number];
  let editTool: ReturnType<typeof createFridayAgentFileTools>[number];

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-file-tools-"));
    tools = createFridayAgentFileTools({ workspaceRoot: tmpDir });
    readTool = tools.find((t) => t.name === "read")!;
    writeTool = tools.find((t) => t.name === "write")!;
    editTool = tools.find((t) => t.name === "edit")!;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function signal(): AbortSignal {
    return new AbortController().signal;
  }

  // ─── Read tool ───

  describe("read", () => {
    it("reads file contents", async () => {
      const filePath = path.join(tmpDir, "test.txt");
      fs.writeFileSync(filePath, "hello world\nsecond line\n");

      const result = await readTool.execute({ path: filePath }, signal());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("hello world");
      expect(result.content).toContain("second line");
    });

    it("supports offset parameter (1-indexed)", async () => {
      const filePath = path.join(tmpDir, "lines.txt");
      fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\n");

      const result = await readTool.execute(
        { path: filePath, offset: 2 },
        signal(),
      );

      expect(result.content).not.toContain("line1");
      expect(result.content).toContain("line2");
      expect(result.content).toContain("line3");
    });

    it("supports limit parameter", async () => {
      const filePath = path.join(tmpDir, "lines.txt");
      fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\n");

      const result = await readTool.execute(
        { path: filePath, limit: 2 },
        signal(),
      );

      expect(result.content).toContain("line1");
      expect(result.content).toContain("line2");
      expect(result.content).not.toContain("line3");
    });

    it("returns error for non-existent file", async () => {
      const result = await readTool.execute(
        { path: path.join(tmpDir, "nonexistent.txt") },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Failed to read file");
    });

    it("requires path parameter", async () => {
      await expect(
        readTool.execute({}, signal()),
      ).rejects.toThrow("path is required");
    });
  });

  // ─── Write tool ───

  describe("write", () => {
    it("writes content to file", async () => {
      const filePath = path.join(tmpDir, "output.txt");

      const result = await writeTool.execute(
        { path: filePath, content: "hello world" },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("bytes");
      expect(fs.readFileSync(filePath, "utf8")).toBe("hello world");
    });

    it("creates parent directories", async () => {
      const filePath = path.join(tmpDir, "nested", "dir", "file.txt");

      await writeTool.execute(
        { path: filePath, content: "nested content" },
        signal(),
      );

      expect(fs.readFileSync(filePath, "utf8")).toBe("nested content");
    });

    it("overwrites existing file", async () => {
      const filePath = path.join(tmpDir, "overwrite.txt");
      fs.writeFileSync(filePath, "old content");

      await writeTool.execute(
        { path: filePath, content: "new content" },
        signal(),
      );

      expect(fs.readFileSync(filePath, "utf8")).toBe("new content");
    });

    it("rejects symlink targets and keeps target content unchanged", async () => {
      const targetPath = path.join(tmpDir, "target.txt");
      const symlinkPath = path.join(tmpDir, "target-link.txt");
      fs.writeFileSync(targetPath, "keep-this-content");
      fs.symlinkSync(targetPath, symlinkPath);

      const result = await writeTool.execute(
        { path: symlinkPath, content: "new-content" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(fs.readFileSync(targetPath, "utf8")).toBe("keep-this-content");
    });

    it("blocks writing token-like values without approval", async () => {
      const filePath = path.join(tmpDir, "config.json");
      fs.writeFileSync(filePath, JSON.stringify({ apiToken: "old-token" }, null, 2));

      const result = await writeTool.execute(
        { path: filePath, content: JSON.stringify({ apiToken: "new-token" }, null, 2) },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Approval required");
      expect(fs.readFileSync(filePath, "utf8")).toContain("old-token");
    });
  });

  // ─── Edit tool ───

  describe("edit", () => {
    it("replaces exact text in file", async () => {
      const filePath = path.join(tmpDir, "edit.txt");
      fs.writeFileSync(filePath, "Hello World");

      const result = await editTool.execute(
        { path: filePath, oldText: "World", newText: "Friday" },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      expect(fs.readFileSync(filePath, "utf8")).toBe("Hello Friday");
    });

    it("returns error when oldText not found", async () => {
      const filePath = path.join(tmpDir, "edit.txt");
      fs.writeFileSync(filePath, "Hello World");

      const result = await editTool.execute(
        { path: filePath, oldText: "Missing", newText: "Replaced" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("oldText not found");
    });

    it("replaces only the first occurrence", async () => {
      const filePath = path.join(tmpDir, "multi.txt");
      fs.writeFileSync(filePath, "aaa bbb aaa");

      await editTool.execute(
        { path: filePath, oldText: "aaa", newText: "ccc" },
        signal(),
      );

      expect(fs.readFileSync(filePath, "utf8")).toBe("ccc bbb aaa");
    });

    it("supports replacing with empty string", async () => {
      const filePath = path.join(tmpDir, "delete.txt");
      fs.writeFileSync(filePath, "remove this part");

      await editTool.execute(
        { path: filePath, oldText: " this part", newText: "" },
        signal(),
      );

      expect(fs.readFileSync(filePath, "utf8")).toBe("remove");
    });

    it("rejects editing symlink that resolves outside workspace", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-file-tools-outside-"));
      const outsideFile = path.join(outsideDir, "outside.txt");
      const symlinkPath = path.join(tmpDir, "outside-link.txt");
      try {
        fs.writeFileSync(outsideFile, "outside data");
        fs.symlinkSync(outsideFile, symlinkPath);

        const result = await editTool.execute(
          { path: symlinkPath, oldText: "outside", newText: "inside" },
          signal(),
        );

        expect(result.isError).toBe(true);
        expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside data");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("blocks editing token-like values without approval", async () => {
      const filePath = path.join(tmpDir, "config.json");
      fs.writeFileSync(filePath, JSON.stringify({ apiToken: "old-token", mode: "safe" }, null, 2));

      const result = await editTool.execute(
        { path: filePath, oldText: '\"apiToken\": \"old-token\"', newText: '\"apiToken\": \"new-token\"' },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Approval required");
      expect(fs.readFileSync(filePath, "utf8")).toContain("old-token");
    });
  });

  // ─── Path traversal prevention ───

  describe("path traversal prevention", () => {
    it("rejects paths containing '..' segments", async () => {
      const filePath = `${tmpDir}/../escape.txt`;
      const result = await readTool.execute({ path: filePath }, signal());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('"." or ".." segments');
    });

    it("rejects paths containing '.' segments", async () => {
      const filePath = `${tmpDir}/./sneaky.txt`;
      const result = await readTool.execute({ path: filePath }, signal());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('"." or ".." segments');
    });

    it("rejects 'a/../b' traversal paths", async () => {
      const filePath = `${tmpDir}/a/../b`;
      const result = await readTool.execute({ path: filePath }, signal());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('"." or ".." segments');
    });

    it("rejects backslash traversal 'a\\\\..\\\\b'", async () => {
      const filePath = `${tmpDir}/a\\..\\b`;
      const result = await readTool.execute({ path: filePath }, signal());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('"." or ".." segments');
    });

    it("rejects write to traversal paths", async () => {
      const filePath = `${tmpDir}/../escape.txt`;
      const result = await writeTool.execute(
        { path: filePath, content: "hacked" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('"." or ".." segments');
    });

    it("rejects edit on traversal paths", async () => {
      const filePath = `${tmpDir}/../escape.txt`;
      const result = await editTool.execute(
        { path: filePath, oldText: "a", newText: "b" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('"." or ".." segments');
    });
  });

  // ─── Tool definitions ───

  it("returns three tools: read, write, edit", () => {
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(["read", "write", "edit"]);
  });

  // ─── Relative paths anchor at the workspace root (read/write parity) ───
  // Regression for the write/edit bug where a bare relative path (e.g.
  // "summary.json") resolved against process.cwd() (outside the workspace) and
  // was rejected as "outside the allowed workspace root", forcing a failed retry.
  // `read` always anchored at the workspace root; `write`/`edit` did not.
  describe("relative paths anchor at the workspace root", () => {
    let cwdDir: string;
    let origCwd: string;

    beforeEach(() => {
      origCwd = process.cwd();
      // CWD deliberately set to a dir that is NOT the workspace root.
      cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-file-tools-cwd-"));
      process.chdir(cwdDir);
    });

    afterEach(() => {
      process.chdir(origCwd);
      fs.rmSync(cwdDir, { recursive: true, force: true });
    });

    it("write resolves a bare relative path against the workspace root, not the CWD", async () => {
      const result = await writeTool.execute(
        { path: "summary.json", content: '{"count":12,"sum":216,"max":42}' },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      // lands in the workspace root ...
      expect(fs.existsSync(path.join(tmpDir, "summary.json"))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, "summary.json"), "utf8")).toBe(
        '{"count":12,"sum":216,"max":42}',
      );
      // ... and NOT in the process CWD
      expect(fs.existsSync(path.join(cwdDir, "summary.json"))).toBe(false);
    });

    it("write resolves a relative subdir path against the workspace root", async () => {
      const result = await writeTool.execute(
        { path: "out/data.json", content: "x" },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      expect(fs.existsSync(path.join(tmpDir, "out", "data.json"))).toBe(true);
      expect(fs.existsSync(path.join(cwdDir, "out", "data.json"))).toBe(false);
    });

    it("edit resolves a relative path against the workspace root", async () => {
      fs.writeFileSync(path.join(tmpDir, "note.txt"), "hello world");

      const result = await editTool.execute(
        { path: "note.txt", oldText: "world", newText: "friday" },
        signal(),
      );

      expect(result.isError).toBeUndefined();
      expect(fs.readFileSync(path.join(tmpDir, "note.txt"), "utf8")).toBe("hello friday");
    });

    it("still rejects absolute paths outside the workspace root", async () => {
      const outside = path.join(cwdDir, "escape.json");
      const result = await writeTool.execute({ path: outside, content: "x" }, signal());

      expect(result.isError).toBe(true);
      expect(result.content).toContain("outside the allowed workspace root");
      expect(fs.existsSync(outside)).toBe(false);
    });

    it("still rejects '..' traversal segments in a relative path", async () => {
      const result = await writeTool.execute({ path: "../escape.json", content: "x" }, signal());

      expect(result.isError).toBe(true);
      expect(result.content).toContain('"." or ".." segments');
      expect(fs.existsSync(path.join(cwdDir, "escape.json"))).toBe(false);
      expect(fs.existsSync(path.join(path.dirname(tmpDir), "escape.json"))).toBe(false);
    });
  });
});
