/**
 * R1 — write-friday-release-manifest source-only mode. Locks down:
 *   - releaseMode field is "source-only";
 *   - currentMilestone reflects the npm/source-only public v1 local candidate;
 *   - releaseClaim.boundary contains the RELEASE_CLAIM-mandated paragraph;
 *   - macOS/iOS/Android/Windows platforms all show availability:
 *     "not_in_this_release" (no inferred shipping_beta_baseline status);
 *   - Sparkle / Homebrew / TestFlight / Play channels all show availability:
 *     "not_in_this_release";
 *   - Homebrew cask file is NOT emitted into dist/releases/homebrew/Casks/.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "ops", "write-friday-release-manifest.mjs");

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-source-only-"));
  // Minimal fixture mirroring the layout the manifest writer needs.
  const packageJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  await fs.mkdir(path.join(tmpRoot, "packaging", "homebrew", "Casks"), { recursive: true });
  await fs.writeFile(path.join(tmpRoot, "package.json"), JSON.stringify({ version: packageJson.version }), "utf8");
  await fs.writeFile(
    path.join(tmpRoot, "packaging", "homebrew", "Casks", "friday.rb.template"),
    "cask 'friday' do\n  version '{{VERSION}}'\n  sha256 '{{SHA256}}'\n  url '{{URL}}'\nend\n",
    "utf8",
  );
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("write-friday-release-manifest source-only mode", () => {
  it("emits releaseMode=source-only, releaseClaim boundary, and marks all platforms/channels as not_in_this_release; no homebrew cask", async () => {
    const result = spawnSync("node", [SCRIPT_PATH], {
      env: {
        ...process.env,
        FRIDAY_RELEASE_REPO_ROOT: tmpRoot,
        FRIDAY_RELEASE_TAG: "v1.0.1",
        FRIDAY_RELEASE_DOWNLOAD_BASE_URL: "https://example.invalid/releases/v1.0.1",
        FRIDAY_RELEASE_MODE: "source-only",
      },
      encoding: "utf8",
    });
    expect(result.status, `manifest stderr: ${result.stderr}`).toBe(0);

    const jsonPath = path.join(tmpRoot, "dist", "releases", "Friday.release-manifest.json");
    const mdPath = path.join(tmpRoot, "dist", "releases", "Friday.release-manifest.md");
    const manifest = JSON.parse(await fs.readFile(jsonPath, "utf8"));

    expect(manifest.releaseMode).toBe("source-only");
    expect(manifest.currentMilestone).toBe("npm_source_only_public_v1_local_candidate");

    expect(manifest.releaseClaim).toBeTruthy();
    expect(String(manifest.releaseClaim.boundary)).toContain("This release is npm/source-only");
    expect(String(manifest.releaseClaim.boundary)).toContain("Desktop, Homebrew, notarized macOS");

    for (const platform of ["macos", "ios", "android", "windows"]) {
      const entry = (manifest.platforms as Array<Record<string, unknown>>).find(
        (p) => p.platform === platform,
      );
      expect(entry, `platform ${platform} missing from manifest`).toBeTruthy();
      expect(entry?.availability).toBe("not_in_this_release");
    }

    for (const channel of ["sparkle", "homebrew", "testflight", "playInternal"]) {
      const ch = (manifest.channels as Record<string, { availability: string }>)[channel];
      expect(ch?.availability, `channel ${channel} availability`).toBe("not_in_this_release");
    }

    const homebrewCask = path.join(tmpRoot, "dist", "releases", "homebrew", "Casks", "friday.rb");
    await expect(fs.access(homebrewCask)).rejects.toBeTruthy();

    const md = await fs.readFile(mdPath, "utf8");
    expect(md).toContain("Release Mode: `source-only`");
    expect(md).toContain("Release Claim Boundary");
  });
});
