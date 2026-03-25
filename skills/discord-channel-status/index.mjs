import { buildChannelStatusSkill } from "../_shared/channel-status-skill-utils.mjs";

export async function execute(_input = {}, ctx = {}) {
  return buildChannelStatusSkill("discord", "Discord", ctx);
}
