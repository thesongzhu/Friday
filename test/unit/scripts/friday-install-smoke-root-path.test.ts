import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

describe("install smoke root path handling", () => {
  it("decodes URL-escaped checkout paths before using them as filesystem paths", () => {
    const checkoutRoot = join(tmpdir(), "Friday path #with spaces");
    const scriptUrl = new URL("scripts/ci/install-smoke.mjs", pathToFileURL(`${checkoutRoot}/`));
    const root = fileURLToPath(new URL("../../", scriptUrl)).replace(/\/$/, "");

    expect(root).toBe(checkoutRoot);
    expect(root).not.toContain("%20");
    expect(root).not.toContain("%23");
  });

  it("uses fileURLToPath instead of URL pathname in the install smoke script", () => {
    const source = readFileSync(join(process.cwd(), "scripts/ci/install-smoke.mjs"), "utf8");

    // `fileURLToPath` must be imported from node:url — but the script may legitimately import
    // additional named bindings from the same module (Lane C added `pathToFileURL` for the Rust
    // agent-run proof), so assert the named import is PRESENT rather than the SOLE import.
    expect(source).toMatch(/import \{[^}]*\bfileURLToPath\b[^}]*\} from "node:url";/);
    expect(source).toContain('fileURLToPath(new URL("../../", import.meta.url))');
    expect(source).not.toContain(".pathname.replace");
  });

  it("rejects an occupied localhost port before install smoke can poll health", async () => {
    const scriptUrl = pathToFileURL(join(process.cwd(), "scripts/ci/install-smoke.mjs")).href;
    const { assertInstallSmokePortAvailable } = await import(scriptUrl);
    const blocker = createServer();

    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected localhost TCP address for install smoke port test");
    }

    try {
      await expect(assertInstallSmokePortAvailable(address.port)).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    }
  });
});
