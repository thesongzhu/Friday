import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeImageInput, validateAndNormalizeImages } from "../../../../src/agent/tools/friday-agent-image-analysis-helpers.js";

describe("normalizeImageInput — workspace boundary check (Issue 5)", () => {
  const workspaceRoot = "/home/user/project";

  it("allows a file path within the workspace", () => {
    // Use an absolute path within the fake workspace
    const filePath = path.join(workspaceRoot, "images", "photo.png");
    try {
      normalizeImageInput(filePath, { workspaceRoot });
    } catch (err) {
      // Expected: "Image file not found" (passes boundary check but file doesn't exist)
      expect((err as Error).message).toContain("not found");
    }
  });

  it("rejects a file path outside the workspace", () => {
    expect(() =>
      normalizeImageInput("/etc/passwd", { workspaceRoot }),
    ).toThrow("outside the allowed directories");
  });

  it("rejects traversal paths that escape workspace", () => {
    expect(() =>
      normalizeImageInput("../../etc/shadow", { workspaceRoot }),
    ).toThrow("outside the allowed directories");
  });

  it("rejects absolute paths outside workspace and temp", () => {
    expect(() =>
      normalizeImageInput("/root/.ssh/id_rsa", { workspaceRoot }),
    ).toThrow("outside the allowed directories");
  });

  it("allows a file path within the temp directory", () => {
    const tmpFile = path.join(os.tmpdir(), "test-image.png");
    try {
      normalizeImageInput(tmpFile, { workspaceRoot });
    } catch (err) {
      // Should fail on "not found" not on boundary check
      expect((err as Error).message).toContain("not found");
    }
  });

  it("does not restrict HTTP URLs", () => {
    const result = normalizeImageInput("https://example.com/img.png", { workspaceRoot });
    expect(result.type).toBe("url");
    expect(result.url).toBe("https://example.com/img.png");
  });

  it("does not restrict data URIs", () => {
    const dataUri = "data:image/png;base64,iVBOR";
    const result = normalizeImageInput(dataUri, { workspaceRoot });
    expect(result.type).toBe("base64");
  });
});

describe("validateAndNormalizeImages — workspace boundary propagation", () => {
  const workspaceRoot = "/home/user/project";

  it("passes workspace root to normalizeImageInput", () => {
    const result = validateAndNormalizeImages(["/etc/passwd"], { workspaceRoot });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("outside the allowed directories");
  });

  it("allows valid URLs even with workspace restriction", () => {
    const result = validateAndNormalizeImages(
      ["https://example.com/img.png"],
      { workspaceRoot },
    );
    expect(result.valid).toBe(true);
    expect(result.images).toHaveLength(1);
  });
});
