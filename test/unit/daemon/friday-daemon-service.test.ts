import { describe, it, expect, vi } from "vitest";
import {
  createFridayDaemonService,
  DAEMON_SERVICE_ERROR_CODES,
} from "../../../src/daemon/friday-daemon-service.js";
import type {
  FridayDaemonServiceDeps,
  FridayDaemonProcessControl,
} from "../../../src/daemon/friday-daemon-service.js";
import type { FridayDaemonPidFileDeps } from "../../../src/daemon/friday-daemon-pidfile.js";
import type { FridayDaemonConfig } from "../../../src/daemon/friday-daemon.types.js";

// ─── Helpers ───

function createMockConfig(): FridayDaemonConfig {
  return {
    paths: {
      runtimeDir: "/tmp/friday-daemon",
      pidFile: "/tmp/friday-daemon/friday.pid",
      stdoutLog: "/tmp/friday-daemon/stdout.log",
      stderrLog: "/tmp/friday-daemon/stderr.log",
    },
    shutdownGraceMs: 5000,
    version: "1.0.0-test",
  };
}

function createMockPidFileDeps(overrides: Partial<FridayDaemonPidFileDeps> = {}): FridayDaemonPidFileDeps {
  return {
    readFile: vi.fn().mockReturnValue(null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    mkdirp: vi.fn(),
    isProcessAlive: vi.fn().mockReturnValue(false),
    nowIso: () => "2026-01-15T10:00:00.000Z",
    ...overrides,
  };
}

function createMockProcessControl(overrides: Partial<FridayDaemonProcessControl> = {}): FridayDaemonProcessControl {
  return {
    spawnDaemon: vi.fn().mockReturnValue({ ok: true, value: { pid: 54321 } }),
    sendSignal: vi.fn().mockReturnValue(true),
    waitForExit: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function createMockDeps(overrides: {
  config?: FridayDaemonConfig;
  pidFileDeps?: Partial<FridayDaemonPidFileDeps>;
  processControl?: Partial<FridayDaemonProcessControl>;
} = {}): FridayDaemonServiceDeps {
  return {
    config: overrides.config ?? createMockConfig(),
    pidFileDeps: createMockPidFileDeps(overrides.pidFileDeps),
    processControl: createMockProcessControl(overrides.processControl),
  };
}

// ─── Tests ───

describe("FridayDaemonService", () => {
  describe("start", () => {
    it("spawns daemon and writes PID file", async () => {
      const deps = createMockDeps();
      const service = createFridayDaemonService(deps);

      const result = await service.start();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pid).toBe(54321);
      }
      expect(deps.processControl.spawnDaemon).toHaveBeenCalledWith(
        "/tmp/friday-daemon/stdout.log",
        "/tmp/friday-daemon/stderr.log",
      );
      expect(deps.pidFileDeps.writeFile).toHaveBeenCalled();
    });

    it("returns error if already running", async () => {
      const record = { pid: 11111, startedAt: "2026-01-15T09:00:00Z" };
      const deps = createMockDeps({
        pidFileDeps: {
          readFile: vi.fn().mockReturnValue(JSON.stringify(record)),
          isProcessAlive: vi.fn().mockReturnValue(true),
        },
      });
      const service = createFridayDaemonService(deps);

      const result = await service.start();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(DAEMON_SERVICE_ERROR_CODES.ALREADY_RUNNING);
      }
    });

    it("returns error if spawn fails", async () => {
      const deps = createMockDeps({
        processControl: {
          spawnDaemon: vi.fn().mockReturnValue({
            ok: false,
            error: { code: "SPAWN_FAILED", message: "Cannot spawn" },
          }),
        },
      });
      const service = createFridayDaemonService(deps);

      const result = await service.start();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(DAEMON_SERVICE_ERROR_CODES.START_FAILED);
      }
    });

    it("kills process and returns error if PID write fails", async () => {
      const deps = createMockDeps({
        pidFileDeps: {
          writeFile: vi.fn().mockImplementation(() => { throw new Error("Disk full"); }),
        },
      });
      const service = createFridayDaemonService(deps);

      const result = await service.start();

      expect(result.ok).toBe(false);
      expect(deps.processControl.sendSignal).toHaveBeenCalledWith(54321, "SIGKILL");
    });
  });

  describe("stop", () => {
    it("sends SIGTERM and cleans up PID file", async () => {
      const record = { pid: 22222, startedAt: "2026-01-15T09:00:00Z" };
      const deps = createMockDeps({
        pidFileDeps: {
          readFile: vi.fn().mockReturnValue(JSON.stringify(record)),
          isProcessAlive: vi.fn().mockReturnValue(true),
        },
      });
      const service = createFridayDaemonService(deps);

      const result = await service.stop();

      expect(result.ok).toBe(true);
      expect(deps.processControl.sendSignal).toHaveBeenCalledWith(22222, "SIGTERM");
      expect(deps.pidFileDeps.removeFile).toHaveBeenCalled();
    });

    it("sends SIGKILL if process does not exit within grace period", async () => {
      const record = { pid: 33333, startedAt: "2026-01-15T09:00:00Z" };
      const deps = createMockDeps({
        pidFileDeps: {
          readFile: vi.fn().mockReturnValue(JSON.stringify(record)),
          isProcessAlive: vi.fn().mockReturnValue(true),
        },
        processControl: {
          sendSignal: vi.fn().mockReturnValue(true),
          waitForExit: vi.fn()
            .mockResolvedValueOnce(false) // grace period expires
            .mockResolvedValueOnce(true), // SIGKILL succeeds
        },
      });
      const service = createFridayDaemonService(deps);

      const result = await service.stop();

      expect(result.ok).toBe(true);
      expect(deps.processControl.sendSignal).toHaveBeenCalledWith(33333, "SIGTERM");
      expect(deps.processControl.sendSignal).toHaveBeenCalledWith(33333, "SIGKILL");
    });

    it("returns error when daemon is not running", async () => {
      const deps = createMockDeps();
      const service = createFridayDaemonService(deps);

      const result = await service.stop();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(DAEMON_SERVICE_ERROR_CODES.NOT_RUNNING);
      }
    });
  });

  describe("restart", () => {
    it("stops running daemon then starts new one", async () => {
      const record = { pid: 44444, startedAt: "2026-01-15T09:00:00Z" };
      let fileContent: string | null = JSON.stringify(record);
      const deps = createMockDeps({
        pidFileDeps: {
          readFile: vi.fn().mockImplementation(() => fileContent),
          isProcessAlive: vi.fn().mockReturnValue(true),
          removeFile: vi.fn().mockImplementation(() => { fileContent = null; }),
        },
      });
      const service = createFridayDaemonService(deps);

      const result = await service.restart();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pid).toBe(54321);
      }
      // Should have sent stop signal for old daemon
      expect(deps.processControl.sendSignal).toHaveBeenCalledWith(44444, "SIGTERM");
    });
  });

  describe("status", () => {
    it("returns not running when no PID file", () => {
      const deps = createMockDeps();
      const service = createFridayDaemonService(deps);

      const status = service.status();

      expect(status.running).toBe(false);
      expect(status.pid).toBeNull();
      expect(status.startedAt).toBeNull();
      expect(status.uptime).toBeNull();
    });

    it("returns running status with uptime", () => {
      const record = { pid: 55555, startedAt: "2026-01-15T09:00:00.000Z" };
      const deps = createMockDeps({
        pidFileDeps: {
          readFile: vi.fn().mockReturnValue(JSON.stringify(record)),
          isProcessAlive: vi.fn().mockReturnValue(true),
        },
      });
      const service = createFridayDaemonService(deps);

      const status = service.status();

      expect(status.running).toBe(true);
      expect(status.pid).toBe(55555);
      expect(status.startedAt).toBe("2026-01-15T09:00:00.000Z");
      expect(status.uptime).toBeGreaterThan(0);
    });
  });
});
