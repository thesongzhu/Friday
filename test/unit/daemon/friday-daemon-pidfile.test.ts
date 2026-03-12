import { describe, it, expect, vi } from "vitest";
import {
  readPidRecord,
  writePidRecord,
  removePidFile,
  validatePidFile,
  DAEMON_PID_ERROR_CODES,
} from "../../../src/daemon/friday-daemon-pidfile.js";
import type { FridayDaemonPidFileDeps } from "../../../src/daemon/friday-daemon-pidfile.js";

function createMockDeps(overrides: Partial<FridayDaemonPidFileDeps> = {}): FridayDaemonPidFileDeps {
  return {
    readFile: vi.fn().mockReturnValue(null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    mkdirp: vi.fn(),
    isProcessAlive: vi.fn().mockReturnValue(true),
    nowIso: () => "2026-01-15T10:00:00.000Z",
    ...overrides,
  };
}

describe("readPidRecord", () => {
  it("returns error when file does not exist", () => {
    const deps = createMockDeps({ readFile: vi.fn().mockReturnValue(null) });
    const result = readPidRecord("/tmp/friday.pid", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(DAEMON_PID_ERROR_CODES.PID_FILE_NOT_FOUND);
    }
  });

  it("returns error for invalid JSON", () => {
    const deps = createMockDeps({ readFile: vi.fn().mockReturnValue("not json") });
    const result = readPidRecord("/tmp/friday.pid", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(DAEMON_PID_ERROR_CODES.PID_FILE_CORRUPT);
    }
  });

  it("returns error for non-integer pid", () => {
    const deps = createMockDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify({ pid: "abc", startedAt: "2026-01-01T00:00:00Z" })),
    });
    const result = readPidRecord("/tmp/friday.pid", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(DAEMON_PID_ERROR_CODES.PID_FILE_CORRUPT);
    }
  });

  it("returns valid record", () => {
    const record = { pid: 12345, startedAt: "2026-01-15T09:00:00Z" };
    const deps = createMockDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(record)),
    });
    const result = readPidRecord("/tmp/friday.pid", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pid).toBe(12345);
      expect(result.value.startedAt).toBe("2026-01-15T09:00:00Z");
    }
  });
});

describe("writePidRecord", () => {
  it("writes PID file and creates directory", () => {
    const deps = createMockDeps();
    const result = writePidRecord("/tmp/daemon/friday.pid", "/tmp/daemon", 99999, deps, "1.0.0");
    expect(result.ok).toBe(true);
    expect(deps.mkdirp).toHaveBeenCalledWith("/tmp/daemon");
    expect(deps.writeFile).toHaveBeenCalled();
    if (result.ok) {
      expect(result.value.pid).toBe(99999);
      expect(result.value.version).toBe("1.0.0");
    }
  });

  it("returns error on write failure", () => {
    const deps = createMockDeps({
      writeFile: vi.fn().mockImplementation(() => { throw new Error("Permission denied"); }),
    });
    const result = writePidRecord("/tmp/friday.pid", "/tmp", 12345, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Permission denied");
    }
  });
});

describe("removePidFile", () => {
  it("removes the file", () => {
    const deps = createMockDeps();
    removePidFile("/tmp/friday.pid", deps);
    expect(deps.removeFile).toHaveBeenCalledWith("/tmp/friday.pid");
  });

  it("ignores errors silently", () => {
    const deps = createMockDeps({
      removeFile: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
    });
    expect(() => removePidFile("/tmp/friday.pid", deps)).not.toThrow();
  });
});

describe("validatePidFile", () => {
  it("returns record when process is alive", () => {
    const record = { pid: 12345, startedAt: "2026-01-15T09:00:00Z" };
    const deps = createMockDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(record)),
      isProcessAlive: vi.fn().mockReturnValue(true),
    });
    const result = validatePidFile("/tmp/friday.pid", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pid).toBe(12345);
    }
  });

  it("cleans up stale PID file when process is dead", () => {
    const record = { pid: 12345, startedAt: "2026-01-15T09:00:00Z" };
    const deps = createMockDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify(record)),
      isProcessAlive: vi.fn().mockReturnValue(false),
    });
    const result = validatePidFile("/tmp/friday.pid", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(DAEMON_PID_ERROR_CODES.PROCESS_NOT_RUNNING);
    }
    expect(deps.removeFile).toHaveBeenCalled();
  });

  it("returns error when PID file does not exist", () => {
    const deps = createMockDeps({ readFile: vi.fn().mockReturnValue(null) });
    const result = validatePidFile("/tmp/friday.pid", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(DAEMON_PID_ERROR_CODES.PID_FILE_NOT_FOUND);
    }
  });
});
