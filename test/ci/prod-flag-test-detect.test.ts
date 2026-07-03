import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function detector() {
  return await import(pathToFileURL(join(repoRoot, "scripts", "ci", "lib", "prod-flag-test-detect.mjs")).href);
}

describe("prod-flag Rust test detection", () => {
  it("marks a bare #[ignore] Rust mapping as ignored", async () => {
    const { resolveRustTest } = await detector();

    expect(
      resolveRustTest(
        `#[ignore]\n#[tokio::test]\nasync fn mapped_loop_test() {}\n`,
        "mapped_loop_test"
      )
    ).toMatchObject({ declared: true, ignored: true });
  });

  it("marks #[ignore = reason] Rust mappings as ignored", async () => {
    const { resolveRustTest } = await detector();

    expect(
      resolveRustTest(
        `#[ignore = "live: needs key"]\nfn mapped_loop_test() {}\n`,
        "mapped_loop_test"
      )
    ).toMatchObject({ declared: true, ignored: true });
  });

  it("marks multiline ignore reasons as ignored", async () => {
    const { resolveRustTest } = await detector();

    expect(
      resolveRustTest(
        `#[ignore = "live: requires KEY (proof). \\\n    run with --ignored"]\nfn mapped_loop_test() {}\n`,
        "mapped_loop_test"
      )
    ).toMatchObject({ declared: true, ignored: true });
  });

  it("marks cfg_attr ignore as ignored fail-closed", async () => {
    const { resolveRustTest } = await detector();

    expect(
      resolveRustTest(
        `#[cfg_attr(not(feature = "live"), ignore)]\nfn mapped_loop_test() {}\n`,
        "mapped_loop_test"
      )
    ).toMatchObject({ declared: true, ignored: true });
  });

  it("does not over-reject a normal Rust test", async () => {
    const { resolveRustTest } = await detector();

    expect(
      resolveRustTest(`#[tokio::test]\nasync fn mapped_loop_test() {}\n`, "mapped_loop_test")
    ).toEqual({ declared: true, ignored: false });
  });

  it("does not let an ignored sibling bleed into the mapped test", async () => {
    const { resolveRustTest } = await detector();

    expect(
      resolveRustTest(
        `#[ignore]\nfn live_sibling() { let _x = 1; }\n\n#[test]\nfn mapped_loop_test() {}\n`,
        "mapped_loop_test"
      )
    ).toEqual({ declared: true, ignored: false });
  });

  it("rejects a prod flag mapped to an ignored Rust test", () => {
    const tempRepo = mkdtempSync(join(tmpdir(), "friday-prod-flag-fixture-"));
    const manifestPath = join(tempRepo, "docs", "ops", "prod-flags-manifest.json");
    const rustTestPath = join(tempRepo, "rust-core", "crates", "friday-hub", "tests", "mapped.rs");

    try {
      mkdirSync(dirname(manifestPath), { recursive: true });
      mkdirSync(dirname(rustTestPath), { recursive: true });
      writeFileSync(
        rustTestPath,
        `#[ignore = "live"]\n#[test]\nfn mapped_loop_test() {}\n`,
        "utf8"
      );
      writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            flags: [
              {
                flag: "FRIDAY_TEST_PROD_FLAG",
                process: "rust-ws-wrapper",
                prod_state: "on",
                closes_loop: "fixture ignored-test loop",
                coverage: "loop-e2e",
                e2e_test: "rust-core/crates/friday-hub/tests/mapped.rs::mapped_loop_test",
              },
            ],
          },
          null,
          2
        ),
        "utf8"
      );

      const result = spawnSync(process.execPath, ["scripts/ci/verify-prod-flag-tests.mjs"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          FRIDAY_PROD_FLAGS_MANIFEST_PATH: manifestPath,
          FRIDAY_PROD_FLAGS_REPO_ROOT: tempRepo,
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("FRIDAY_TEST_PROD_FLAG");
      expect(`${result.stdout}\n${result.stderr}`).toContain("#[ignore]");
    } finally {
      rmSync(tempRepo, { force: true, recursive: true });
    }
  });

  it("keeps the current production manifest passing", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/ci/verify-prod-flag-tests.mjs"], {
        cwd: repoRoot,
        stdio: "pipe",
      })
    ).not.toThrow();
  });
});
