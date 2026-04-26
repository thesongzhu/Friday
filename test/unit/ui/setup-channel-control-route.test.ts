import { describe, expect, it } from "vitest";

import {
  SETUP_CHANNEL_CONTROL_CONFIRMATION,
  SETUP_CHANNEL_CONTROL_GUARDS,
  SETUP_CHANNEL_CONTROL_ROUTE_STEPS,
} from "@/lib/setup/channel-control-route";

describe("setup channel control route copy", () => {
  it("shows that connected channels enter the full Friday agent route", () => {
    expect(SETUP_CHANNEL_CONTROL_ROUTE_STEPS.map((step) => step.en)).toEqual([
      "Channel message",
      "Session and identity",
      "Orchestration engine",
      "Agent, tools, skills, memory",
      "Reply after safety gates",
    ]);

    expect(SETUP_CHANNEL_CONTROL_ROUTE_STEPS.map((step) => step.zh).join(" ")).toContain("编排引擎");
    expect(SETUP_CHANNEL_CONTROL_ROUTE_STEPS.map((step) => step.zh).join(" ")).toContain("Agent");
    expect(SETUP_CHANNEL_CONTROL_ROUTE_STEPS.map((step) => step.zh).join(" ")).toContain("skills");
    expect(SETUP_CHANNEL_CONTROL_ROUTE_STEPS.map((step) => step.zh).join(" ")).toContain("记忆");
  });

  it("states full enabled control without bypassing safety gates", () => {
    const zh = SETUP_CHANNEL_CONTROL_GUARDS.map((guard) => guard.zh).join(" ");
    const en = SETUP_CHANNEL_CONTROL_GUARDS.map((guard) => guard.en).join(" ");

    expect(zh).toContain("完整能力");
    expect(en).toContain("full enabled capability set");
    expect(zh).toContain("不能绕过");
    expect(en).toContain("cannot bypass");
    expect(zh).toContain("human gate");
    expect(en).toContain("sensitive-action limits");
  });

  it("requires explicit user confirmation before channel control is saved", () => {
    expect(SETUP_CHANNEL_CONTROL_CONFIRMATION.zh).toContain("我确认");
    expect(SETUP_CHANNEL_CONTROL_CONFIRMATION.zh).toContain("执行任务");
    expect(SETUP_CHANNEL_CONTROL_CONFIRMATION.en).toContain("I understand");
    expect(SETUP_CHANNEL_CONTROL_CONFIRMATION.en).toContain("sensitive actions");
  });
});
