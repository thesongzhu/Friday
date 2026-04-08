import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

/**
 * Performance benchmark: verifies that route modules can be imported within
 * a time threshold. Uses dynamic import to measure module load cost.
 *
 * Pattern follows test/e2e/ui/friday-surface-interaction-benchmark.test.ts
 * but focuses on module-level import latency rather than browser rendering.
 */

const IMPORT_THRESHOLD_MS = 2_000;

async function measureImport(modulePath: string): Promise<number> {
  const startedAt = performance.now();
  await import(modulePath);
  return performance.now() - startedAt;
}

describe("friday surface load times — module import benchmarks", () => {
  it("deeplink parser module imports within threshold", async () => {
    const elapsedMs = await measureImport(
      "../../src/deeplink/friday-deeplink-parser.js",
    );
    expect(elapsedMs).toBeLessThan(IMPORT_THRESHOLD_MS);
  });

  it("channel registry module imports within threshold", async () => {
    const elapsedMs = await measureImport(
      "../../src/channels/friday-channel-registry.js",
    );
    expect(elapsedMs).toBeLessThan(IMPORT_THRESHOLD_MS);
  });

  it("provider fallback module imports within threshold", async () => {
    const elapsedMs = await measureImport(
      "../../src/providers/routing/friday-provider-fallback.js",
    );
    expect(elapsedMs).toBeLessThan(IMPORT_THRESHOLD_MS);
  });

  it("security policy extension chain module imports within threshold", async () => {
    const elapsedMs = await measureImport(
      "../../src/security/policy-extension-chain.js",
    );
    expect(elapsedMs).toBeLessThan(IMPORT_THRESHOLD_MS);
  });

  it("secret ref module imports within threshold", async () => {
    const elapsedMs = await measureImport(
      "../../src/security/friday-secret-ref.js",
    );
    expect(elapsedMs).toBeLessThan(IMPORT_THRESHOLD_MS);
  });

  it("provider types module imports within threshold", async () => {
    const elapsedMs = await measureImport(
      "../../src/providers/model/friday-provider.types.js",
    );
    expect(elapsedMs).toBeLessThan(IMPORT_THRESHOLD_MS);
  });
});
