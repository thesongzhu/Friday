/**
 * Reply Routing — Ensure replies always reach the correct originating channel.
 *
 * @module routing
 */

export {
  type FridayReplyRouteContext,
  type FridayReplySendPolicy,
  type FridayQueuedReply,
  type FridayReplyDeliveryResult,
  type FridayReplyDestination,
  type FridayReplyRoutingConfig,
  DEFAULT_REPLY_ROUTING_CONFIG,
} from "./friday-reply-routing.types.js";

export {
  type FridayReplyRouteRepository,
  createFridayReplyRouteRepository,
} from "./friday-reply-route-repository.js";

export {
  type FridayReplyQueueRepository,
  createFridayReplyQueueRepository,
} from "./friday-reply-queue-repository.js";

export {
  type FridayReplyRoutingServiceDeps,
  type FridayReplyRoutingService,
  createFridayReplyRoutingService,
} from "./friday-reply-routing-service.js";

export {
  type FridayReplyQueueDrainResult,
  type FridayReplyQueueJobDeps,
  type FridayReplyQueueJob,
  createFridayReplyQueueJob,
} from "./friday-reply-queue-job.js";
