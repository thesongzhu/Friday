import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFridayRustHubProvidersDetectService } from "../../../../src/api/mission-spine/friday-rust-hub-providers-detect-bridge-service.js";

/**
 * REFS-ONLY providers-detect bridge test. Spawns a SCRIPTED MOCK bin (no real cargo, no
 * provider CLI, no quota, no secret) supplied as `adapterBin`, mirroring the chmod-0o755
 * shebang-mock idiom from the run-readback sibling. The mock records its argv to a sidecar
 * file so the test can assert the exact `--probe` selection that crossed the bridge.
 */
describe("friday-rust-hub-providers-detect-bridge-service (DARK refs-only bridge)", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  function setup(mockBody: string): { binPath: string; argvPath: string } {
    scratch = mkdtempSync(join(tmpdir(), "friday-hub-providers-detect-"));
    const argvPath = join(scratch, "argv.json");
    const binPath = join(scratch, "hub_providers_detect_mock.mjs");
    // The mock records the args it received (minus node + script path) then runs the body.
    writeFileSync(
      binPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
${mockBody}
`,
    );
    chmodSync(binPath, 0o755);
    return { binPath, argvPath };
  }

  function readArgv(argvPath: string): string[] {
    return JSON.parse(readFileSync(argvPath, "utf8")) as string[];
  }

  it("parses a valid refs-only detect on the happy path and defaults to --probe both", async () => {
    const { binPath, argvPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_providers_detect",
        proof_only: true,
        ok: true,
        detected: [
          { provider: "codex", installed: true, authenticated: true, detail: "logged_in" },
          { provider: "claude", installed: true, authenticated: false, detail: "not_logged_in" },
        ],
        ready_providers: ["codex"],
        any_authenticated: true,
        all_authenticated: false,
      }));
    `);
    const service = createFridayRustHubProvidersDetectService({ adapterBin: binPath });

    const receipt = await service.detect();

    expect(receipt).toMatchObject({
      truthLabel: "rust_providers_detect",
      proofOnly: true,
      readyProviders: ["codex"],
      anyAuthenticated: true,
      allAuthenticated: false,
    });
    expect(receipt.detected).toEqual([
      { provider: "codex", installed: true, authenticated: true, detail: "logged_in" },
      { provider: "claude", installed: true, authenticated: false, detail: "not_logged_in" },
    ]);
    // Default selection is `both`.
    expect(readArgv(argvPath)).toEqual(["--probe", "both"]);
  });

  it("passes the requested probe selection through to the bin", async () => {
    const { binPath, argvPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_providers_detect",
        proof_only: true,
        ok: true,
        detected: [{ provider: "claude", installed: false, authenticated: false, detail: "not_installed" }],
        ready_providers: [],
        any_authenticated: false,
        all_authenticated: false,
      }));
    `);
    const service = createFridayRustHubProvidersDetectService({ adapterBin: binPath });

    await service.detect({ probe: "claude" });

    expect(readArgv(argvPath)).toEqual(["--probe", "claude"]);
  });

  it("fails closed (503) on a non-zero exit", async () => {
    const { binPath } = setup(`
      process.stderr.write("hub_providers_detect_unavailable: bad_args");
      process.exit(2);
    `);
    const service = createFridayRustHubProvidersDetectService({ adapterBin: binPath });

    await expect(service.detect()).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_PROVIDERS_DETECT_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on malformed JSON", async () => {
    const { binPath } = setup(`process.stdout.write("not json {");`);
    const service = createFridayRustHubProvidersDetectService({ adapterBin: binPath });

    await expect(service.detect()).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_PROVIDERS_DETECT_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on the wrong truth label (copy-paste guard)", async () => {
    const { binPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        ok: true,
        detected: [],
        ready_providers: [],
        any_authenticated: false,
        all_authenticated: false,
      }));
    `);
    const service = createFridayRustHubProvidersDetectService({ adapterBin: binPath });

    await expect(service.detect()).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_PROVIDERS_DETECT_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed when the bin reports ok:false", async () => {
    const { binPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_providers_detect",
        proof_only: true,
        ok: false,
        error_kind: "bad_args",
      }));
    `);
    const service = createFridayRustHubProvidersDetectService({ adapterBin: binPath });

    await expect(service.detect()).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_PROVIDERS_DETECT_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("rejects an entry carrying a raw CLI stream field", async () => {
    const { binPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_providers_detect",
        proof_only: true,
        ok: true,
        detected: [
          { provider: "codex", installed: true, authenticated: true, detail: "logged_in", stdout: "raw cli text" },
        ],
        ready_providers: ["codex"],
        any_authenticated: true,
        all_authenticated: false,
      }));
    `);
    const service = createFridayRustHubProvidersDetectService({ adapterBin: binPath });

    await expect(service.detect()).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_PROVIDERS_DETECT_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on timeout", async () => {
    const { binPath } = setup(`setTimeout(() => process.stdout.write("late"), 5000);`);
    const service = createFridayRustHubProvidersDetectService({ adapterBin: binPath, timeoutMs: 200 });

    await expect(service.detect()).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_PROVIDERS_DETECT_UNAVAILABLE",
      httpStatus: 503,
    });
  });
});
