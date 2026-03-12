import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  resolveStateDir,
  resolveFridayDbPath,
} from "#state";

describe("resolveStateDir", () => {
  const fakeHome = "/fakehome";
  const homedir = () => fakeHome;

  it("FRIDAY_STATE_DIR override wins", () => {
    const result = resolveStateDir({
      env: { FRIDAY_STATE_DIR: "/custom/state" },
      homedir,
      existsSync: () => false,
    });
    expect(result).toBe("/custom/state");
  });

  it("~ expansion works in FRIDAY_STATE_DIR", () => {
    const result = resolveStateDir({
      env: { FRIDAY_STATE_DIR: "~/my-friday/state" },
      homedir,
      existsSync: () => false,
    });
    expect(result).toBe(path.join(fakeHome, "my-friday", "state"));
  });

  it("existing platform path wins over legacy path (Phase 8+)", () => {
    const legacyPath = path.join(fakeHome, ".friday", "state");
    const platformPath = path.join(
      fakeHome,
      "Library",
      "Application Support",
      "Friday",
      "state",
    );
    const result = resolveStateDir({
      env: {},
      platform: "darwin",
      homedir,
      existsSync: (p) => p === legacyPath || p === platformPath,
    });
    expect(result).toBe(platformPath);
  });

  it("legacy path used when platform path absent", () => {
    const legacyPath = path.join(fakeHome, ".friday", "state");
    const result = resolveStateDir({
      env: {},
      platform: "darwin",
      homedir,
      existsSync: (p) => p === legacyPath,
    });
    expect(result).toBe(legacyPath);
  });

  it("existing platform path chosen when legacy default absent", () => {
    const platformPath = path.join(
      fakeHome,
      "Library",
      "Application Support",
      "Friday",
      "state",
    );
    const result = resolveStateDir({
      env: {},
      platform: "darwin",
      homedir,
      existsSync: (p) => p === platformPath,
    });
    expect(result).toBe(platformPath);
  });

  it("fallback path is platform path when neither exists", () => {
    const platformPath = path.join(
      fakeHome,
      "Library",
      "Application Support",
      "Friday",
      "state",
    );
    const result = resolveStateDir({
      env: {},
      platform: "darwin",
      homedir,
      existsSync: () => false,
    });
    expect(result).toBe(platformPath);
  });

  it("linux uses XDG_STATE_HOME", () => {
    const xdgPath = path.join("/custom/xdg", "friday");
    const result = resolveStateDir({
      env: { XDG_STATE_HOME: "/custom/xdg" },
      platform: "linux",
      homedir,
      existsSync: (p) => p === xdgPath,
    });
    expect(result).toBe(xdgPath);
  });
});

describe("resolveFridayDbPath", () => {
  it("returns friday.db under state dir", () => {
    const result = resolveFridayDbPath({
      env: { FRIDAY_STATE_DIR: "/tmp/state" },
      homedir: () => "/fakehome",
      existsSync: () => false,
    });
    expect(result).toBe(path.join("/tmp/state", "friday.db"));
  });
});
