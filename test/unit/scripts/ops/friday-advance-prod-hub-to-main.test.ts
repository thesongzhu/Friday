import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const advanceScript = resolve(
  repoRoot,
  "scripts/ops/friday-advance-prod-hub-to-main.sh",
);

function currentOriginMain(): string {
  const result = spawnSync("git", ["rev-parse", "origin/main"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function orderedIndexes(haystack: string, needles: string[]): number[] {
  return needles.map((needle) => {
    const index = haystack.indexOf(needle);
    expect(index, `missing ordered token: ${needle}`).toBeGreaterThanOrEqual(0);
    return index;
  });
}

describe("Friday production advance script", () => {
  it("is shell-parseable", () => {
    const result = spawnSync("bash", ["-n", advanceScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it("requires an explicit signed target SHA instead of blindly advancing origin/main", () => {
    const source = readFileSync(advanceScript, "utf8");

    expect(source).toContain("--signed-sha");
    expect(source).toContain("FRIDAY_ADVANCE_SIGNED_SHA");
    expect(source).toContain("Refusing to deploy without an explicit military SIGN target SHA");
    expect(source).toContain("operator must compare this SHA to the military SIGN report");
    expect(source).not.toContain('TARGET_REF="${TARGET_REF:-origin/main}"');
    expect(source).not.toContain("git reset --hard origin/main");
    expect(source).not.toContain("git pull --ff-only origin main");
    expect(source).toContain("verify_checked_out_signed_target");
  });

  it("hardens the deploy order from checkout through native, Rust, services, and health gates", () => {
    const source = readFileSync(advanceScript, "utf8");

    expect(source).toContain("pnpm install --frozen-lockfile");
    expect(source).toContain("better_sqlite3.node");
    expect(source).toContain("hub_agent_run_server");
    expect(source).toContain("hub_read_projection_server");
    expect(source).toContain("com.friday.rust-agent-run-ws-server");
    expect(source).toContain("com.friday.read-projection-server");
    expect(source).toContain("com.friday.hub");
    expect(source).toContain("/v1/health");
    expect(source).toContain("verify_schema_handshake");
    expect(source).toContain("CURRENT_SCHEMA_VERSION");
    expect(source).toContain("check-read-projection-runtime-freshness.mjs");
    expect(source).toContain("--require-current-schema");
    expect(source).toContain("--require-running-current");
    expect(source).toContain("lockfile/schema changed");
    expect(source).toContain("git rollback is not sufficient");
    expect(source).not.toContain("Deployment order manifest");
    expect(source).not.toContain("grep -q \"CURRENT_SCHEMA_VERSION\"");

    const mainExecutionSource = source.slice(source.indexOf('log "starting signed production advance"'));
    const executableSource = mainExecutionSource
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    const indexes = orderedIndexes(executableSource, [
      "git -C \"${REPO_DIR}\" fetch origin main",
      "git -C \"${REPO_DIR}\" switch main",
      "git -C \"${REPO_DIR}\" checkout \"${SIGNED_SHA}\"",
      "verify_checked_out_signed_target",
      "pnpm install --frozen-lockfile",
      "verify_better_sqlite3_native_binding",
      "--bin hub_agent_run_server --bin hub_read_projection_server",
      "kickstart_launch_agent \"${RUST_WS_LABEL}\"",
      "kickstart_launch_agent \"${READ_PROJECTION_LABEL}\"",
      "kickstart_launch_agent \"${TS_HUB_LABEL}\"",
      "wait_for_http \"${TS_HUB_HEALTH_URL}\"",
      "verify_schema_handshake",
    ]);

    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("prints recovery steps on fail-closed deployment exits", () => {
    const result = spawnSync(
      "bash",
      [
        advanceScript,
        "--repo",
        repoRoot,
        "--signed-sha",
        "0000000",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(73);
    expect(result.stderr).toContain("Recovery checklist");
    expect(result.stderr).toContain("git rollback is not sufficient");
  });

  it("dry-runs the same signed deployment sequence without touching launchd or production state", () => {
    const signedSha = currentOriginMain();
    const result = spawnSync(
      "bash",
      [
        advanceScript,
        "--dry-run",
        "--repo",
        repoRoot,
        "--signed-sha",
        signedSha,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          FRIDAY_ADVANCE_SKIP_NETWORK_HEALTH: "1",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("DRY-RUN");
    expect(result.stdout).toContain(`signed target SHA: ${signedSha}`);

    const indexes = orderedIndexes(result.stdout, [
      "git fetch origin main",
      "git switch main",
      `git checkout ${signedSha}`,
      "verify checked out signed target",
      "pnpm install --frozen-lockfile",
      "verify better_sqlite3.node",
      "cargo build --release",
      "kickstart com.friday.rust-agent-run-ws-server",
      "kickstart com.friday.read-projection-server",
      "kickstart com.friday.hub",
      "GET http://127.0.0.1:3141/v1/health",
      "schema handshake",
    ]);

    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(result.stdout).not.toContain("git pull --ff-only origin main");
  });
});
