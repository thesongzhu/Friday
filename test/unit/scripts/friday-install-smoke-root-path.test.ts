import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

    expect(source).toContain('import { fileURLToPath } from "node:url";');
    expect(source).toContain('fileURLToPath(new URL("../../", import.meta.url))');
    expect(source).not.toContain(".pathname.replace");
  });
});
