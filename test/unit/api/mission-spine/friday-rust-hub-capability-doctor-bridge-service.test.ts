import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFridayRustHubCapabilityDoctorService } from "../../../../src/api/mission-spine/friday-rust-hub-capability-doctor-bridge-service.js";

/**
 * REFS-ONLY capability-doctor bridge test. Spawns a SCRIPTED MOCK bin (no real cargo, no
 * provider CLI, no live Anthropic round-trip, no quota, no secret) supplied as
 * `adapterBin`. The mock records its argv to a sidecar file so the test can assert that
 * `--validate-keys` is passed ONLY when the caller explicitly requests it (the quota
 * gate). NO test here ever runs the real live key-validation arm.
 */
describe("friday-rust-hub-capability-doctor-bridge-service (DARK refs-only bridge)", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  function setup(mockBody: string): { binPath: string; argvPath: string } {
    scratch = mkdtempSync(join(tmpdir(), "friday-hub-capability-doctor-"));
    const argvPath = join(scratch, "argv.json");
    const binPath = join(scratch, "hub_capability_doctor_mock.mjs");
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

  const CLI_ONLY_BODY = `
    process.stdout.write(JSON.stringify({
      truth_label: "rust_capability_doctor",
      proof_only: true,
      ok: true,
      cli_detected: [
        { provider: "codex", installed: true, authenticated: true, detail: "logged_in" },
        { provider: "claude", installed: true, authenticated: false, detail: "not_logged_in" },
      ],
      cli_logged_in: ["codex"],
      key_validation_probed: false,
      key_validation: null,
      confirmed_valid_keys: null,
    }));
  `;

  it("default (validateKeys unset) runs CLI-only and NEVER passes --validate-keys (quota gate)", async () => {
    const { binPath, argvPath } = setup(CLI_ONLY_BODY);
    const service = createFridayRustHubCapabilityDoctorService({ adapterBin: binPath });

    const receipt = await service.doctor();

    expect(receipt).toMatchObject({
      truthLabel: "rust_capability_doctor",
      proofOnly: true,
      cliLoggedIn: ["codex"],
      keyValidationProbed: false,
      keyValidation: null,
      confirmedValidKeys: null,
    });
    // The zero-quota default MUST NOT pass --validate-keys.
    expect(readArgv(argvPath)).toEqual([]);
  });

  it("validateKeys:false also never passes --validate-keys", async () => {
    const { binPath, argvPath } = setup(CLI_ONLY_BODY);
    const service = createFridayRustHubCapabilityDoctorService({ adapterBin: binPath });

    await service.doctor({ validateKeys: false });

    expect(readArgv(argvPath)).toEqual([]);
  });

  it("validateKeys:true passes --validate-keys and parses the live key section", async () => {
    const { binPath, argvPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_capability_doctor",
        proof_only: true,
        ok: true,
        cli_detected: [
          { provider: "codex", installed: true, authenticated: true, detail: "logged_in" },
          { provider: "claude", installed: true, authenticated: false, detail: "not_logged_in" },
        ],
        cli_logged_in: ["codex"],
        key_validation_probed: true,
        key_validation: [
          { provider: "deepseek", label: "valid", status: null, detail: null },
          { provider: "anthropic", label: "invalid", status: 401, detail: null },
        ],
        confirmed_valid_keys: ["deepseek"],
      }));
    `);
    const service = createFridayRustHubCapabilityDoctorService({ adapterBin: binPath });

    const receipt = await service.doctor({ validateKeys: true });

    // The ONLY way --validate-keys crosses the bridge is an explicit true.
    expect(readArgv(argvPath)).toEqual(["--validate-keys"]);
    expect(receipt.keyValidationProbed).toBe(true);
    expect(receipt.keyValidation).toEqual([
      { provider: "deepseek", label: "valid", status: null, detail: null },
      { provider: "anthropic", label: "invalid", status: 401, detail: null },
    ]);
    expect(receipt.confirmedValidKeys).toEqual(["deepseek"]);
  });

  it("rejects a not-probed payload that carries a non-null key section (honesty contract)", async () => {
    const { binPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_capability_doctor",
        proof_only: true,
        ok: true,
        cli_detected: [{ provider: "codex", installed: true, authenticated: true, detail: "logged_in" }],
        cli_logged_in: ["codex"],
        key_validation_probed: false,
        key_validation: [{ provider: "anthropic", label: "credential_missing", status: null, detail: null }],
        confirmed_valid_keys: null,
      }));
    `);
    const service = createFridayRustHubCapabilityDoctorService({ adapterBin: binPath });

    await expect(service.doctor()).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_CAPABILITY_DOCTOR_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed (503) on a non-zero exit", async () => {
    const { binPath } = setup(`
      process.stderr.write("hub_capability_doctor_unavailable: bad_args");
      process.exit(2);
    `);
    const service = createFridayRustHubCapabilityDoctorService({ adapterBin: binPath });

    await expect(service.doctor()).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_CAPABILITY_DOCTOR_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on malformed JSON", async () => {
    const { binPath } = setup(`process.stdout.write("not json {");`);
    const service = createFridayRustHubCapabilityDoctorService({ adapterBin: binPath });

    await expect(service.doctor()).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_CAPABILITY_DOCTOR_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on the wrong truth label (copy-paste guard)", async () => {
    const { binPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        ok: true,
        cli_detected: [],
        cli_logged_in: [],
        key_validation_probed: false,
        key_validation: null,
        confirmed_valid_keys: null,
      }));
    `);
    const service = createFridayRustHubCapabilityDoctorService({ adapterBin: binPath });

    await expect(service.doctor()).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_CAPABILITY_DOCTOR_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on timeout", async () => {
    const { binPath } = setup(`setTimeout(() => process.stdout.write("late"), 5000);`);
    const service = createFridayRustHubCapabilityDoctorService({ adapterBin: binPath, timeoutMs: 200 });

    await expect(service.doctor()).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_CAPABILITY_DOCTOR_UNAVAILABLE",
      httpStatus: 503,
    });
  });
});
