import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  createFridayRustHubSystemIntentService,
} from "../../../../src/api/mission-spine/friday-rust-hub-system-intent-service.js";

async function makeFakeAdapter(dir: string, recordPath: string): Promise<string> {
  const adapter = join(dir, "fake-system-intent-adapter.mjs");
  await writeFile(
    adapter,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  args,
  flag: process.env.FRIDAY_SYSTEM_INTENT_RUST_ENTRYPOINT
}));
const valueAfter = (name) => args[args.indexOf(name) + 1];
console.log(JSON.stringify({
  truth_label: "b3_system_intent_rust_dark_entrypoint",
  ok: true,
  live: false,
  db_writes: true,
  os_actuated: false,
  completes_effect: false,
  completes_host_effect: false,
  action: valueAfter("--action"),
  status: "unavailable",
  dry_run: true,
  execution_deferred: false,
  control_lease_id: null,
  gate_reason: null,
  message: "rust_system_action_dry_run_observed"
}));
`,
    "utf8",
  );
  await chmod(adapter, 0o755);
  return adapter;
}

describe("createFridayRustHubSystemIntentService", () => {
  it("bridges to the Rust CLI with an owner-bound intent id and refs-only receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "friday-system-intent-bridge-"));
    try {
      const dbPath = join(dir, "hub.sqlite");
      const recordPath = join(dir, "record.json");
      await writeFile(dbPath, "", "utf8");
      const adapterBin = await makeFakeAdapter(dir, recordPath);
      const service = createFridayRustHubSystemIntentService({
        repoRoot: dir,
        dbPath,
        adapterBin,
        nowMs: () => 1_000,
      });

      const receipt = await service.execute({
        action: "snapshot",
        appIdentifier: "com.example.App",
        targetKind: "url",
        target: "https://example.com/target-url-not-forwarded",
        url: "https://example.com/raw-url-not-forwarded",
        actorId: "u-1",
        actorKind: "api",
        idempotencyKey: "idem-1",
      });

      expect(receipt.result).toMatchObject({
        id: "system-intent:api:u-1:idem-1",
        action: "snapshot",
        status: "unavailable",
        message: "rust_system_action_dry_run_observed",
        performedAt: "1970-01-01T00:00:01.000Z",
        payload: {
          truthLabel: "b3_system_intent_rust_dark_entrypoint",
          live: false,
          dryRun: true,
          osActuated: false,
          completesEffect: false,
          completesHostEffect: false,
        },
      });
      const record = JSON.parse(await readFile(recordPath, "utf8")) as {
        args: string[];
        flag?: string;
      };
      expect(record.flag).toBe("1");
      expect(record.args).toContain("--target-ref");
      expect(record.args[record.args.indexOf("--target-ref") + 1]).toBe("com.example.App");
      expect(record.args).not.toContain("https://example.com/raw-url-not-forwarded");
      expect(record.args).not.toContain("https://example.com/target-url-not-forwarded");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed before spawning when the Rust hub DB is not provisioned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "friday-system-intent-bridge-missing-db-"));
    try {
      const recordPath = join(dir, "record.json");
      const adapterBin = await makeFakeAdapter(dir, recordPath);
      const service = createFridayRustHubSystemIntentService({
        repoRoot: dir,
        dbPath: join(dir, "missing.sqlite"),
        adapterBin,
      });

      await expect(
        service.execute({ action: "snapshot", idempotencyKey: "idem-1" }),
      ).rejects.toMatchObject({
        code: "SYSTEM_INTENT_RUST_ENTRYPOINT_UNAVAILABLE",
        httpStatus: 503,
      });
      expect(existsSync(recordPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
