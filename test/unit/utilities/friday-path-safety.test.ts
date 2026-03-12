import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveSafePath, openFileWithinRoot, FridaySafeOpenError, isWithinBase } from "#utilities";

// ─── isWithinBase ───

describe("isWithinBase", () => {
  it("returns true when target is within base", () => {
    expect(isWithinBase("/base", "/base/foo/bar.txt")).toBe(true);
  });

  it("returns true when target equals base", () => {
    expect(isWithinBase("/base", "/base")).toBe(true);
  });

  it("returns false when target is outside base (..)", () => {
    expect(isWithinBase("/base/child", "/base")).toBe(false);
  });

  it("returns false when target is a sibling", () => {
    expect(isWithinBase("/base/a", "/base/b")).toBe(false);
  });

  it("returns false for absolute unrelated paths", () => {
    expect(isWithinBase("/base", "/etc/passwd")).toBe(false);
  });

  it("handles base without trailing sep", () => {
    expect(isWithinBase("/base", "/base/sub")).toBe(true);
  });

  it("rejects traversal that resolves outside", () => {
    expect(isWithinBase("/base", "/base/../etc")).toBe(false);
  });
});

// ─── resolveSafePath ───

describe("resolveSafePath", () => {
  it("resolves a safe relative path", () => {
    const result = resolveSafePath("/base", "foo/bar.txt");
    expect(result).toBe(path.resolve("/base", "foo/bar.txt"));
  });

  it("rejects absolute paths", () => {
    expect(() => resolveSafePath("/base", "/etc/passwd")).toThrow("Path must be relative");
  });

  it("rejects .. traversal", () => {
    expect(() => resolveSafePath("/base", "../etc/passwd")).toThrow('must not contain ".."');
  });

  it("rejects nested .. traversal", () => {
    expect(() => resolveSafePath("/base", "foo/../../etc/passwd")).toThrow('must not contain ".."');
  });
});

// ─── openFileWithinRoot ───

describe("openFileWithinRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-path-safety-test-"));
    // Create test files
    fs.writeFileSync(path.join(tmpDir, "valid.txt"), "hello");
    fs.mkdirSync(path.join(tmpDir, "subdir"));
    fs.writeFileSync(path.join(tmpDir, "subdir", "nested.txt"), "nested");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("opens a file within root", () => {
    const result = openFileWithinRoot({ rootDir: tmpDir, relativePath: "valid.txt" });
    expect(result.fd).toBeGreaterThan(0);
    const content = fs.readFileSync(result.resolvedPath, "utf8");
    expect(content).toBe("hello");
    fs.closeSync(result.fd);
  });

  it("opens a nested file within root", () => {
    const result = openFileWithinRoot({ rootDir: tmpDir, relativePath: "subdir/nested.txt" });
    expect(result.fd).toBeGreaterThan(0);
    fs.closeSync(result.fd);
  });

  it("rejects absolute paths", () => {
    expect(() => openFileWithinRoot({ rootDir: tmpDir, relativePath: "/etc/passwd" }))
      .toThrow(FridaySafeOpenError);
  });

  it("rejects .. traversal", () => {
    expect(() => openFileWithinRoot({ rootDir: tmpDir, relativePath: "../etc/passwd" }))
      .toThrow(FridaySafeOpenError);
  });

  it("rejects . segments", () => {
    expect(() => openFileWithinRoot({ rootDir: tmpDir, relativePath: "./valid.txt" }))
      .toThrow(FridaySafeOpenError);
  });

  it("throws not-found for non-existent file", () => {
    try {
      openFileWithinRoot({ rootDir: tmpDir, relativePath: "missing.txt" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridaySafeOpenError);
      expect((err as FridaySafeOpenError).kind).toBe("not-found");
    }
  });

  it("rejects directory as file", () => {
    try {
      openFileWithinRoot({ rootDir: tmpDir, relativePath: "subdir" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridaySafeOpenError);
      expect((err as FridaySafeOpenError).kind).toBe("invalid-path");
    }
  });

  it("rejects symlink escape", () => {
    // Create a symlink pointing outside the root
    const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "friday-outside-"));
    fs.writeFileSync(path.join(outsidePath, "secret.txt"), "secret");
    const symlinkPath = path.join(tmpDir, "escape-link");
    fs.symlinkSync(path.join(outsidePath, "secret.txt"), symlinkPath);

    try {
      openFileWithinRoot({ rootDir: tmpDir, relativePath: "escape-link" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridaySafeOpenError);
      expect((err as FridaySafeOpenError).kind).toBe("invalid-path");
    } finally {
      fs.rmSync(outsidePath, { recursive: true, force: true });
    }
  });

  it("rejects ancestor symlink escape (directory symlink pointing outside root)", () => {
    // Create an outside directory with a secret file
    const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "friday-ancestor-outside-"));
    fs.writeFileSync(path.join(outsidePath, "secret.txt"), "ancestor-escape-secret");

    // Create a symlink DIRECTORY inside the root that points outside
    const symlinkDir = path.join(tmpDir, "evil-dir");
    fs.symlinkSync(outsidePath, symlinkDir);

    try {
      // evil-dir/secret.txt → outsidePath/secret.txt (escapes root via ancestor symlink)
      openFileWithinRoot({ rootDir: tmpDir, relativePath: "evil-dir/secret.txt" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridaySafeOpenError);
      expect((err as FridaySafeOpenError).kind).toBe("invalid-path");
    } finally {
      fs.rmSync(outsidePath, { recursive: true, force: true });
    }
  });

  // ─── Platform-aware O_NOFOLLOW ───

  it("handles platform where O_NOFOLLOW may not be available", () => {
    // This test validates the code doesn't crash regardless of platform
    const result = openFileWithinRoot({ rootDir: tmpDir, relativePath: "valid.txt" });
    expect(result.fd).toBeGreaterThan(0);
    fs.closeSync(result.fd);
  });

  // ─── Error kind mapping ───

  it("maps ENOENT to not-found kind", () => {
    expect(FridaySafeOpenError.kindFromErrno("ENOENT")).toBe("not-found");
  });

  it("maps ENOTDIR to not-found kind", () => {
    expect(FridaySafeOpenError.kindFromErrno("ENOTDIR")).toBe("not-found");
  });

  it("maps ELOOP to invalid-path kind", () => {
    expect(FridaySafeOpenError.kindFromErrno("ELOOP")).toBe("invalid-path");
  });

  it("maps EINVAL to invalid-path kind", () => {
    expect(FridaySafeOpenError.kindFromErrno("EINVAL")).toBe("invalid-path");
  });

  it("maps ENOTSUP to invalid-path kind", () => {
    expect(FridaySafeOpenError.kindFromErrno("ENOTSUP")).toBe("invalid-path");
  });

  it("maps EISDIR to invalid-path kind", () => {
    expect(FridaySafeOpenError.kindFromErrno("EISDIR")).toBe("invalid-path");
  });

  it("defaults to not-found for unknown errno codes", () => {
    expect(FridaySafeOpenError.kindFromErrno("UNKNOWN")).toBe("not-found");
    expect(FridaySafeOpenError.kindFromErrno(undefined)).toBe("not-found");
  });
});
