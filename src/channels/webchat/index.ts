export { createFridayWebchatChannel, normalizeWebchatMessage } from "./friday-webchat-channel.js";
export type { WebchatChannelDeps } from "./friday-webchat-channel.js";
export { FridayWebchatChannelConfigSchema } from "./webchat-config.schema.js";
export type { FridayWebchatChannelConfig } from "./webchat-config.schema.js";
export type {
  WebchatWsService,
  WebchatInboundMessage,
  WebchatOutboundMessage,
} from "./webchat-service.js";
export { createWebchatWsService, createWebchatWsServiceStub } from "./webchat-service.js";
