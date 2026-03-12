import { describe, expect, it } from "vitest";

import {
  FRIDAY_CHANNEL_CAPABILITY_MATRIX,
  buildFridayChannelSecretRef,
  getFridayChannelSecretFieldDescriptors,
  parseFridayChannelSecretRef,
  parseFridayEnvSecretRef,
  resolveFridayChannelSecretPolicy,
} from "#channels";

describe("Friday channel security policy helpers", () => {
  it("round-trips channel secret refs", () => {
    const ref = buildFridayChannelSecretRef("channel:discord:0:token");
    expect(parseFridayChannelSecretRef(ref)).toBe("channel:discord:0:token");
  });

  it("parses env secret refs", () => {
    expect(parseFridayEnvSecretRef("$DISCORD_BOT_TOKEN")).toBe("DISCORD_BOT_TOKEN");
    expect(parseFridayEnvSecretRef("DISCORD_BOT_TOKEN")).toBeNull();
  });

  it("resolves secret policy with strict default", () => {
    expect(resolveFridayChannelSecretPolicy(undefined)).toBe("strict");
    expect(resolveFridayChannelSecretPolicy("compat")).toBe("compat");
    expect(resolveFridayChannelSecretPolicy("garbage")).toBe("strict");
  });

  it("returns dynamic secret requirements for slack http mode", () => {
    const fields = getFridayChannelSecretFieldDescriptors("slack", { mode: "http" });
    const signingSecret = fields.find((item) => item.field === "signingSecret");
    expect(signingSecret?.required).toBe(true);
  });

  it("returns dynamic secret requirements for whatsapp cloud-api mode", () => {
    const fields = getFridayChannelSecretFieldDescriptors("whatsapp", { provider: "cloud-api" });
    const accessToken = fields.find((item) => item.field === "accessToken");
    expect(accessToken?.required).toBe(true);
  });

  it("exposes capability matrix entries for supported kinds", () => {
    expect(FRIDAY_CHANNEL_CAPABILITY_MATRIX.discord.supportsTyping).toBe(true);
    expect(FRIDAY_CHANNEL_CAPABILITY_MATRIX.telegram.supportsOutbound).toBe(true);
    expect(FRIDAY_CHANNEL_CAPABILITY_MATRIX.webchat.supportsInbound).toBe(true);
  });
});
