import {
  asArray,
  asRecord,
  asString,
  compact,
  requireChannelsContext,
} from "./friday-runtime-skill-utils.mjs";

export async function buildChannelStatusSkill(kind, label, ctx = {}) {
  const channels = requireChannelsContext(ctx);
  const channel = await channels.getChannel(kind);

  if (!channel) {
    return {
      summary: `${label} channel is not registered in this Friday runtime.`,
      nextStep: `Enable and configure the ${label} channel, then rerun this skill to inspect its connection contract and recovery hints.`,
      details: {
        kind,
        registered: false,
      },
    };
  }

  const contract = asRecord(channel.contract);
  const supports = asRecord(contract.supports);
  const allowlist = asRecord(channel.allowlist);
  const curatedSkillIds = asArray(contract.curatedSkillIds).filter((value) => typeof value === "string");
  const diagnostics = asRecord(channel.diagnostics);
  const status = asString(channel.status, "unknown");
  const running = Boolean(channel.running);
  const supportsThreads = Boolean(supports.threads);
  const supportsTyping = Boolean(supports.typing);
  const allowedUsersCount = Number(allowlist.allowedUsersCount ?? 0) || 0;
  const allowedChatsCount = Number(allowlist.allowedChatsCount ?? 0) || 0;

  let nextStep = `Review ${label} diagnostics and retry after fixing config or credentials if the channel is not connected.`;
  if (status === "connected" && running) {
    nextStep = `The ${label} channel is healthy. Use its curated skill suggestions or continue with another channel check if you need broader coverage.`;
  } else if (asString(diagnostics.lastError)) {
    nextStep = `Start with the reported ${label} error, then re-run this skill after reconnecting the channel.`;
  }

  const summary = compact(
    `${label} channel is ${status}${running ? " and running" : ""}. Threads are ${supportsThreads ? "supported" : "not supported"}, typing is ${supportsTyping ? "supported" : "not supported"}, and allowlists cover ${allowedUsersCount} user(s) and ${allowedChatsCount} chat(s).`,
    220,
  );

  return {
    summary,
    nextStep,
    details: {
      kind,
      registered: true,
      status,
      running,
      diagnostics,
      contract,
      supportsThreads,
      supportsTyping,
      curatedSkillIds,
      allowlist,
    },
  };
}
