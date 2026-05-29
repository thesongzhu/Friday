import { describe, expect, it } from "vitest";

import {
  classifyShellRisk,
  getApprovalRequiredReasonForExecCommand,
  getApprovalRequiredReasonForFileMutation,
  getPolicyDeniedReasonForToolCall,
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

    it("classifies destructive FLAGS on otherwise-safe programs as destructive", () => {
      expect(classifyShellRisk("git reset --hard")).toMatchObject({ level: "destructive", program: "git" });
      expect(classifyShellRisk("git reset --hard origin/main")).toMatchObject({ level: "destructive", program: "git" });
      expect(classifyShellRisk("git clean -fdx")).toMatchObject({ level: "destructive", program: "git" });
      expect(classifyShellRisk("git checkout --force main")).toMatchObject({ level: "destructive", program: "git" });
      expect(classifyShellRisk("find . -delete")).toMatchObject({ level: "destructive", program: "find" });
    });

    it("detects destructive flags even behind git GLOBAL options (the common agentic form)", () => {
      // git global options (-C <path>, -c k=v, --no-pager, --git-dir=…) shift the subcommand;
      // these must NOT bypass the gate. (BLOCKED_SHELL_PATTERNS rejects metachars, so paths here
      // are plain.)
      expect(classifyShellRisk("git -C repo reset --hard")).toMatchObject({ level: "destructive", program: "git" });
      expect(classifyShellRisk("git --no-pager clean -fdx")).toMatchObject({ level: "destructive", program: "git" });
      expect(classifyShellRisk("git -c core.editor=vi reset --hard")).toMatchObject({ level: "destructive", program: "git" });
      expect(classifyShellRisk("git --git-dir=somedir clean -fd")).toMatchObject({ level: "destructive", program: "git" });
      expect(classifyShellRisk("git --work-tree wt checkout --force main")).toMatchObject({ level: "destructive", program: "git" });
      // benign subcommand behind a global option stays safe
      expect(classifyShellRisk("git -C repo status")).toMatchObject({ level: "safe", program: "git" });
    });

    it("keeps benign git/find invocations safe (no flag false-positives)", () => {
      expect(classifyShellRisk("git status")).toMatchObject({ level: "safe", program: "git" });
      expect(classifyShellRisk("git reset HEAD file.txt")).toMatchObject({ level: "safe", program: "git" });
      expect(classifyShellRisk("git clean -n")).toMatchObject({ level: "safe", program: "git" });
      expect(classifyShellRisk("find . -name pattern")).toMatchObject({ level: "safe", program: "find" });
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

    it("requires approval for destructive flags on otherwise-safe programs", () => {
      expect(getApprovalRequiredReasonForExecCommand("git reset --hard")).toContain("approval");
      expect(getApprovalRequiredReasonForExecCommand("git clean -fdx")).toContain("approval");
      expect(getApprovalRequiredReasonForExecCommand("find . -delete")).toContain("approval");
      // Behind git global options (the common agentic form) must also require approval.
      expect(getApprovalRequiredReasonForExecCommand("git -C repo reset --hard")).toContain("approval");
      expect(getApprovalRequiredReasonForExecCommand("git --no-pager clean -fdx")).toContain("approval");
    });

    it("allows safe read-only commands", () => {
      expect(getApprovalRequiredReasonForExecCommand("ls -la")).toBeNull();
      expect(getApprovalRequiredReasonForExecCommand("cat file.txt")).toBeNull();
      expect(getApprovalRequiredReasonForExecCommand("git status")).toBeNull();
      expect(getApprovalRequiredReasonForExecCommand("git reset HEAD file.txt")).toBeNull();
      expect(getApprovalRequiredReasonForExecCommand("git clean -n")).toBeNull();
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

    it("blocks browser navigation to dangerous URL schemes", () => {
      expect(getApprovalRequiredReasonForToolCall("browser", { action: "navigate", url: "file:///etc/passwd" })).toContain("approval");
      expect(getApprovalRequiredReasonForToolCall("browser", { action: "navigate", url: "javascript:alert(1)" })).toContain("approval");
      expect(getApprovalRequiredReasonForToolCall("browser", { action: "navigate", url: "data:text/html,<script>" })).toContain("approval");
    });

    it("allows browser navigation to https URLs", () => {
      expect(getApprovalRequiredReasonForToolCall("browser", { action: "navigate", url: "https://example.com" })).toBeNull();
    });

    it("blocks canvas eval action", () => {
      expect(getApprovalRequiredReasonForToolCall("canvas", { action: "eval" })).toContain("approval");
      expect(getApprovalRequiredReasonForToolCall("canvas", { action: "evaluate" })).toContain("approval");
    });

    it("blocks xhs publish/post/comment actions", () => {
      expect(getApprovalRequiredReasonForToolCall("xhs", { action: "post" })).toContain("approval");
      expect(getApprovalRequiredReasonForToolCall("xhs", { action: "publish" })).toContain("approval");
      expect(getApprovalRequiredReasonForToolCall("xhs", { action: "comment" })).toContain("approval");
    });

    it("allows xhs read actions", () => {
      expect(getApprovalRequiredReasonForToolCall("xhs", { action: "search" })).toBeNull();
      expect(getApprovalRequiredReasonForToolCall("xhs", { action: "read" })).toBeNull();
    });

    it("blocks desktop launch_app and close_app", () => {
      expect(getApprovalRequiredReasonForToolCall("desktop", { action: "launch_app" })).toContain("approval");
      expect(getApprovalRequiredReasonForToolCall("desktop", { action: "close_app" })).toContain("approval");
    });

    it("blocks tts speak and synthesize", () => {
      expect(getApprovalRequiredReasonForToolCall("tts", { action: "speak" })).toContain("approval");
      expect(getApprovalRequiredReasonForToolCall("tts", { action: "synthesize" })).toContain("approval");
    });

    it("blocks mutating provider actions", () => {
      expect(getApprovalRequiredReasonForToolCall("provider", { action: "update", providerId: "prov-1" })).toContain("approval");
      expect(getApprovalRequiredReasonForToolCall("provider", { action: "set_default", providerId: "prov-1" })).toContain("approval");
      expect(getApprovalRequiredReasonForToolCall("provider", { action: "oauth_complete", providerId: "prov-1" })).toContain("approval");
    });

    it("blocks Guide Lens preference mutations", () => {
      expect(getApprovalRequiredReasonForToolCall("guide_lens", { action: "update_preferences" })).toContain("approval");
      expect(getApprovalRequiredReasonForToolCall("guide_lens", { action: "update_avatar" })).toContain("approval");
      expect(getApprovalRequiredReasonForToolCall("guide_lens", { action: "snapshot" })).toBeNull();
    });

    it("allows safe tool calls", () => {
      expect(getApprovalRequiredReasonForToolCall("read", { path: "file.txt" })).toBeNull();
      expect(getApprovalRequiredReasonForToolCall("web_fetch", { url: "https://example.com" })).toBeNull();
      expect(getApprovalRequiredReasonForToolCall("browser", { action: "screenshot" })).toBeNull();
      expect(getApprovalRequiredReasonForToolCall("desktop", { action: "screenshot" })).toBeNull();
      expect(getApprovalRequiredReasonForToolCall("canvas", { action: "render" })).toBeNull();
      expect(getApprovalRequiredReasonForToolCall("tts", { action: "status" })).toBeNull();
      expect(getApprovalRequiredReasonForToolCall("provider", { action: "list" })).toBeNull();
      expect(getApprovalRequiredReasonForToolCall("provider", { action: "routing" })).toBeNull();
    });

    it("allows exec with safe commands", () => {
      expect(getApprovalRequiredReasonForToolCall("exec", { command: "ls -la" })).toBeNull();
      expect(getApprovalRequiredReasonForToolCall("exec", { command: "git status" })).toBeNull();
    });

    it("allows write to normal files", () => {
      expect(getApprovalRequiredReasonForToolCall("write", { path: "main.ts", content: "code" })).toBeNull();
    });
  });

  describe("getPolicyDeniedReasonForToolCall", () => {
    it("blocks provider mutations for informational guidance prompts", () => {
      expect(
        getPolicyDeniedReasonForToolCall(
          "How do I connect my Anthropic API key? Please guide me step by step.",
          "provider",
          { action: "update", providerId: "prov-1" },
        ),
      ).toContain("must not mutate provider configuration");
    });

    it("allows explicit execution requests to proceed to approval handling", () => {
      expect(
        getPolicyDeniedReasonForToolCall(
          "Connect my Anthropic API key now.",
          "provider",
          { action: "update", providerId: "prov-1" },
        ),
      ).toBeNull();
    });

    it("allows non-mutating provider actions on guidance prompts", () => {
      expect(
        getPolicyDeniedReasonForToolCall(
          "How do I connect my Anthropic API key? Please guide me step by step.",
          "provider",
          { action: "list" },
        ),
      ).toBeNull();
    });
  });
});
