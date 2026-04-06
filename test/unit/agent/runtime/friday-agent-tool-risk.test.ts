import { describe, expect, it } from "vitest";

import {
  classifyShellRisk,
  getApprovalRequiredReasonForExecCommand,
  getApprovalRequiredReasonForFileMutation,
  getApprovalRequiredReasonForToolCall,
} from "../../../../src/agent/runtime/friday-agent-tool-risk.js";

describe("friday-agent-tool-risk", () => {
  // ─── classifyShellRisk ───

  describe("classifyShellRisk", () => {
    it("classifies empty command as safe", () => {
      expect(classifyShellRisk("")).toEqual({ level: "safe", reason: "empty command" });
      expect(classifyShellRisk("   ")).toEqual({ level: "safe", reason: "empty command" });
    });

    it("blocks shell metacharacters", () => {
      expect(classifyShellRisk("echo hello; rm -rf /")).toMatchObject({ level: "blocked" });
      expect(classifyShellRisk("cat file | grep x")).toMatchObject({ level: "blocked" });
      expect(classifyShellRisk("echo $(whoami)")).toMatchObject({ level: "blocked" });
      expect(classifyShellRisk("echo `whoami`")).toMatchObject({ level: "blocked" });
    });

    it("classifies rm as destructive even without metacharacters", () => {
      const result = classifyShellRisk("rm -rf /data");
      expect(result.level).toBe("destructive");
      expect(result.program).toBe("rm");
    });

    it("classifies unlink as destructive", () => {
      expect(classifyShellRisk("unlink myfile.txt")).toMatchObject({ level: "destructive", program: "unlink" });
    });

    it("classifies shred as destructive", () => {
      expect(classifyShellRisk("shred secrets.txt")).toMatchObject({ level: "destructive", program: "shred" });
    });

    it("classifies truncate as destructive", () => {
      expect(classifyShellRisk("truncate -s 0 database.log")).toMatchObject({ level: "destructive", program: "truncate" });
    });

    it("classifies dd as destructive", () => {
      expect(classifyShellRisk("dd if=/dev/zero of=/dev/sda")).toMatchObject({ level: "destructive", program: "dd" });
    });

    it("classifies mkfs as destructive", () => {
      expect(classifyShellRisk("mkfs.ext4 /dev/sda1")).toMatchObject({ level: "destructive", program: "mkfs.ext4" });
    });

    it("classifies kill as destructive", () => {
      expect(classifyShellRisk("kill -9 1234")).toMatchObject({ level: "destructive", program: "kill" });
    });

    it("classifies killall as destructive", () => {
      expect(classifyShellRisk("killall node")).toMatchObject({ level: "destructive", program: "killall" });
    });

    it("classifies pkill as destructive", () => {
      expect(classifyShellRisk("pkill -f my-process")).toMatchObject({ level: "destructive", program: "pkill" });
    });

    it("classifies known safe programs as safe", () => {
      expect(classifyShellRisk("ls -la")).toMatchObject({ level: "safe", program: "ls" });
      expect(classifyShellRisk("cat file.txt")).toMatchObject({ level: "safe", program: "cat" });
      expect(classifyShellRisk("git status")).toMatchObject({ level: "safe", program: "git" });
      expect(classifyShellRisk("npm install")).toMatchObject({ level: "safe", program: "npm" });
      expect(classifyShellRisk("curl https://example.com")).toMatchObject({ level: "safe", program: "curl" });
    });

    it("classifies unknown programs as guarded", () => {
      expect(classifyShellRisk("my-custom-tool --force")).toMatchObject({ level: "guarded" });
    });

    it("classifies sensitive credential manipulation as destructive", () => {
      const result = classifyShellRisk("python apiToken=new-token config.json");
      expect(result.level).toBe("destructive");
    });

    it("classifies protected artifact deletion as destructive", () => {
      const result = classifyShellRisk("python delete database.dump");
      expect(result.level).toBe("destructive");
    });
  });

  // ─── getApprovalRequiredReasonForExecCommand ───

  describe("getApprovalRequiredReasonForExecCommand", () => {
    it("blocks rm commands", () => {
      expect(getApprovalRequiredReasonForExecCommand("rm -rf /data")).toContain("approval");
    });

    it("blocks unlink commands", () => {
      expect(getApprovalRequiredReasonForExecCommand("unlink myfile.txt")).toContain("approval");
    });

    it("blocks interpreter-style deletion of dump artifacts", () => {
      expect(
        getApprovalRequiredReasonForExecCommand("python delete database.dump"),
      ).toContain("approval");
    });

    it("blocks token mutation commands even when the mutator is generic", () => {
      expect(
        getApprovalRequiredReasonForExecCommand("python apiToken=new-token config.json"),
      ).toContain("token");
    });

    it("allows safe read-only commands", () => {
      expect(getApprovalRequiredReasonForExecCommand("ls -la")).toBeNull();
      expect(getApprovalRequiredReasonForExecCommand("cat file.txt")).toBeNull();
      expect(getApprovalRequiredReasonForExecCommand("git status")).toBeNull();
    });

    it("returns null for empty command", () => {
      expect(getApprovalRequiredReasonForExecCommand("")).toBeNull();
    });
  });

  // ─── getApprovalRequiredReasonForFileMutation ───

  describe("getApprovalRequiredReasonForFileMutation", () => {
    it("blocks dump-like artifact mutation", () => {
      expect(
        getApprovalRequiredReasonForFileMutation("database.dump", ["rotated"]),
      ).toContain("approval");
    });

    it("blocks config writes that assign token-like keys", () => {
      expect(
        getApprovalRequiredReasonForFileMutation("config.json", ['"apiToken": "new-token"']),
      ).toContain("token");
    });

    it("blocks backup file mutations", () => {
      expect(getApprovalRequiredReasonForFileMutation("app.bak", ["data"])).toContain("approval");
      expect(getApprovalRequiredReasonForFileMutation("data.backup", ["data"])).toContain("approval");
    });

    it("blocks database file mutations", () => {
      expect(getApprovalRequiredReasonForFileMutation("data.sqlite", ["data"])).toContain("approval");
      expect(getApprovalRequiredReasonForFileMutation("app.db", ["data"])).toContain("approval");
      expect(getApprovalRequiredReasonForFileMutation("schema.sql", ["data"])).toContain("approval");
    });

    it("blocks archive file mutations", () => {
      expect(getApprovalRequiredReasonForFileMutation("release.tar", ["data"])).toContain("approval");
      expect(getApprovalRequiredReasonForFileMutation("backup.gz", ["data"])).toContain("approval");
      expect(getApprovalRequiredReasonForFileMutation("dist.zip", ["data"])).toContain("approval");
    });

    it("allows mutation of regular source files", () => {
      expect(getApprovalRequiredReasonForFileMutation("main.ts", ["code"])).toBeNull();
      expect(getApprovalRequiredReasonForFileMutation("readme.md", ["text"])).toBeNull();
      expect(getApprovalRequiredReasonForFileMutation("config.json", ["normal data"])).toBeNull();
    });

    it("blocks sensitive assignment in file content", () => {
      expect(
        getApprovalRequiredReasonForFileMutation("app.py", ['secret="leaked"']),
      ).toContain("token");
      expect(
        getApprovalRequiredReasonForFileMutation("env.sh", ["export API_TOKEN=abc123"]),
      ).toContain("token");
    });
  });

  // ─── getApprovalRequiredReasonForToolCall (cross-tool) ───

  describe("getApprovalRequiredReasonForToolCall", () => {
    it("blocks exec tool with rm command", () => {
      expect(getApprovalRequiredReasonForToolCall("exec", { command: "rm -rf /data" })).toContain("approval");
    });

    it("blocks write tool to protected artifact", () => {
      expect(getApprovalRequiredReasonForToolCall("write", { path: "database.dump", content: "overwritten" })).toContain("approval");
    });

    it("blocks edit tool with token mutation", () => {
      expect(getApprovalRequiredReasonForToolCall("edit", {
        path: "config.json",
        oldText: '"apiToken": "old"',
        newText: '"apiToken": "rotated"',
      })).toContain("token");
    });

    it("blocks browser evaluate action", () => {
      expect(getApprovalRequiredReasonForToolCall("browser", { action: "evaluate" })).toContain("approval");
    });

    it("blocks desktop launch_app and close_app", () => {
      expect(getApprovalRequiredReasonForToolCall("desktop", { action: "launch_app" })).toContain("approval");
      expect(getApprovalRequiredReasonForToolCall("desktop", { action: "close_app" })).toContain("approval");
    });

    it("allows safe tool calls", () => {
      expect(getApprovalRequiredReasonForToolCall("read", { path: "file.txt" })).toBeNull();
      expect(getApprovalRequiredReasonForToolCall("web_fetch", { url: "https://example.com" })).toBeNull();
      expect(getApprovalRequiredReasonForToolCall("browser", { action: "screenshot" })).toBeNull();
      expect(getApprovalRequiredReasonForToolCall("desktop", { action: "screenshot" })).toBeNull();
    });

    it("allows exec with safe commands", () => {
      expect(getApprovalRequiredReasonForToolCall("exec", { command: "ls -la" })).toBeNull();
      expect(getApprovalRequiredReasonForToolCall("exec", { command: "git status" })).toBeNull();
    });

    it("allows write to normal files", () => {
      expect(getApprovalRequiredReasonForToolCall("write", { path: "main.ts", content: "code" })).toBeNull();
    });
  });
});
