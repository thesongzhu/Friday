export { createFridayIrcChannel, normalizeIrcPrivmsg } from "./friday-irc-channel.js";
export type { IrcChannelDeps } from "./friday-irc-channel.js";
export { FridayIrcChannelConfigSchema } from "./irc-config.schema.js";
export type { FridayIrcChannelConfig } from "./irc-config.schema.js";
export type {
  IrcConnectionService,
  IrcPrivmsgEvent,
  IrcConnectionOptions,
} from "./irc-service.js";
export { createIrcConnectionServiceStub } from "./irc-service.js";
