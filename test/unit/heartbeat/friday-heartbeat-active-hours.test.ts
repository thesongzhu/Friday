import { describe, it, expect } from "vitest";

import { isFridayHeartbeatWithinActiveHours } from "../../../src/heartbeat/friday-heartbeat-active-hours.js";

describe("isFridayHeartbeatWithinActiveHours", () => {
  it("returns true when active hours are disabled", () => {
    expect(
      isFridayHeartbeatWithinActiveHours("2026-02-23T10:00:00.000Z", {
        enabled: false,
        startHour: 9,
        endHour: 18,
      }),
    ).toBe(true);
  });

  it("supports normal daytime window", () => {
    expect(
      isFridayHeartbeatWithinActiveHours("2026-02-23T10:00:00.000Z", {
        enabled: true,
        startHour: 9,
        endHour: 18,
        timezone: "UTC",
      }),
    ).toBe(true);

    expect(
      isFridayHeartbeatWithinActiveHours("2026-02-23T20:00:00.000Z", {
        enabled: true,
        startHour: 9,
        endHour: 18,
        timezone: "UTC",
      }),
    ).toBe(false);
  });

  it("supports overnight windows", () => {
    expect(
      isFridayHeartbeatWithinActiveHours("2026-02-23T23:00:00.000Z", {
        enabled: true,
        startHour: 22,
        endHour: 6,
        timezone: "UTC",
      }),
    ).toBe(true);

    expect(
      isFridayHeartbeatWithinActiveHours("2026-02-23T12:00:00.000Z", {
        enabled: true,
        startHour: 22,
        endHour: 6,
        timezone: "UTC",
      }),
    ).toBe(false);
  });
});

