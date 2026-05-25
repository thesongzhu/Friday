# Channel System Design

## 1. `FridayChannelPlugin` Interface And Lifecycle
Use an instance-oriented plugin contract with explicit `init -> start -> stop` lifecycle and host-provided callbacks.

```ts
export type FridayChannelKind = "qq" | "lark" | "feishu" | string;

export interface FridayChannelPlugin<TConfig = unknown> {
  readonly kind: FridayChannelKind;
  readonly instanceId: string;
  readonly capabilities: FridayChannelCapabilities;

  init(ctx: FridayChannelPluginInitContext<TConfig>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;

  send(message: FridayChannelOutboundMessage): Promise<FridayChannelSendResult>;
}

export interface FridayChannelPluginInitContext<TConfig> {
  config: TConfig;
  nowIso: () => string;
  onMessage: (message: FridayChannelInboundMessage) => Promise<void>;
  onEvent?: (event: FridayChannelEvent) => Promise<void>;
  resolveSecret: (ref: string) => Promise<string>;
}
```

Lifecycle behavior:
1. `init` validates config, resolves credentials, wires callbacks, prepares clients.
2. `start` opens gateway/websocket subscriptions and begins ingest.
3. `stop` closes streams and flushes in-flight state.
4. `send` is always available after `start`.
5. `init` is called once per instance, not per message.

## 2. Channel Registry And Routing Architecture
Add a dedicated runtime layer under plugins/channels:

1. `FridayChannelRegistry`: register, start, stop, and lookup channel instances.
2. `FridayChannelIngressRouter`: receives `onMessage` callbacks, applies allowlist/dedupe, routes to session bridge.
3. `FridayChannelSessionBridge`: maps channel identity to session key and persists inbound/outbound transcript entries.
4. `FridayChannelAgentOrchestrator`: triggers agent runs for inbound messages and returns assistant output.
5. `FridayChannelEgressRouter`: sends outbound messages via registry and persists delivery outcome.

Inbound flow:
1. Channel plugin emits normalized inbound message.
2. Router checks `enabled`, allowlist, and idempotency key.
3. Session bridge creates/gets session and appends user message.
4. Agent orchestrator runs or continues session.
5. Agent output is sent through egress router and stored as assistant message.

Outbound flow:
1. Agent output resolves target session/channel instance.
2. Registry calls plugin `send`.
3. Delivery metadata is persisted into session message metadata.

## 3. QQ Channel Implementation Plan (Priority 1)
Implement as bundled core channel plugin `friday.channel.qq`.

1. Transport mode: QQ Bot gateway (no public webhook port required).
2. Credentials: `app_id` + `app_secret` with cached token refresh.
3. Startup: token bootstrap, gateway URL fetch, websocket connect, heartbeat/reconnect loop.
4. Inbound events: message create, DM/group/guild variants, optional reaction events.
5. Normalization: map QQ event payload to unified inbound model with raw payload preserved in metadata.
6. Outbound send: use official QQ message send endpoints based on conversation type.
7. Reliability: sequence checkpoint, exponential reconnect backoff, duplicate event suppression by `platform_message_id`.
8. Allowlist: `allowed_users`, `allowed_groups`, `allowed_guilds` checked before session append.
9. Security: secrets resolved through env/secret refs, never logged raw.

## 4. Lark/Feishu Channel Implementation Plan (Priority 2)
Implement as bundled core plugin with region support: `friday.channel.lark` and `friday.channel.feishu` sharing core client.

1. Default mode: websocket event stream.
2. Optional mode: webhook (for environments preferring HTTP callback).
3. Credentials: `app_id` + `app_secret`, optional `encrypt_key`.
4. Region switch: `open.larksuite.com` (Lark) and `open.feishu.cn` (Feishu).
5. Inbound events: `im.message.receive_*` and reaction events where enabled.
6. Decryption: if `encrypt_key` present, decrypt event envelope before normalization.
7. Outbound send: message send API with support for text/image/file/reply/thread semantics.
8. Reliability: envelope ACK, reconnect with jitter backoff, idempotency on `event_id/message_id`.
9. Allowlist: `allowed_users`, `allowed_chats`, `allowed_tenants` filters.

## 5. Unified Message Model
Evolve from string-only content into typed parts covering text/image/file/reaction.

```ts
export type FridayMessagePart =
  | { type: "text"; text: string }
  | { type: "image"; image: { url?: string; fileId?: string; mimeType?: string; width?: number; height?: number } }
  | { type: "file"; file: { url?: string; fileId?: string; filename: string; mimeType?: string; size?: number } }
  | { type: "reaction"; reaction: { emoji: string; targetMessageId: string; action: "add" | "remove" } };

export interface FridayChannelInboundMessage {
  platformMessageId: string;
  channelKind: FridayChannelKind;
  instanceId: string;
  conversationId: string;
  chatKind: "dm" | "group" | "channel" | "thread";
  senderId: string;
  senderName?: string;
  occurredAt: string;
  parts: FridayMessagePart[];
  replyToMessageId?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}
```

Mapping rule:
1. `contentText` for sessions is derived from `parts` (concatenate text and placeholders for non-text parts).
2. Full `parts` and raw payload remain in metadata for rich downstream handling.

## 6. Config Schema For Channels
Extend `FridayConfig` in `src/config/friday-config.types.ts` and schema in `src/config/friday-config.schema.ts`:

```ts
channels: {
  enabled: boolean;
  autoStart: boolean;
  defaultAgentId: string;
  instances: FridayChannelInstanceConfig[];
}
```

`FridayChannelInstanceConfig` union:
1. QQ:
   - `kind: "qq"`
   - `id`
   - `enabled`
   - `appId`
   - `appSecretRef`
   - `sandbox?`
   - `allowedUsers?`
   - `allowedGroups?`
   - `allowedGuilds?`
2. Lark/Feishu:
   - `kind: "lark" | "feishu"`
   - `id`
   - `enabled`
   - `appId`
   - `appSecretRef`
   - `encryptKeyRef?`
   - `mode: "websocket" | "webhook"`
   - `allowedUsers?`
   - `allowedChats?`
   - `allowedTenants?`

Config source-of-truth decision:
1. Runtime uses `config.json5` typed config.
2. Setup wizard writes through config service, not split between `friday_setup_state` and `hub_settings`.
3. Keep `friday_setup_state.channels_json` as onboarding draft only, not runtime authority.

## 7. Agent Integration (Inbound -> Agent Run -> Outbound)
Add a channel-aware orchestration service without replacing current agent runtime:

1. `FridayChannelAgentOrchestrator.handleInbound(sessionKey, message)`:
   - appends user message to session service
   - builds task input from latest session context
   - calls `agentRuntime.executeRun({ task, sessionKey })`
2. On completion:
   - append assistant message to session
   - send via egress router to original channel conversation
3. On failure:
   - append tool/error assistant message with failure metadata
   - optional channel error reply depending policy
4. Session mapping:
   - channel segment uses `instanceId` (normalized)
   - accountId from channel instance config or default
   - DM collapses chatId to senderId via existing session key normalization
5. Idempotency:
   - inbound `idempotencyKey = <instanceId>:<platformMessageId>`
   - outbound `idempotencyKey = <runId>:<sessionSeq>`

## 8. File Structure And Module Boundaries
Proposed additions:

1. `src/plugins/channels/model/friday-channel-message.types.ts`
2. `src/plugins/channels/model/friday-channel-config.types.ts`
3. `src/plugins/channels/runtime/friday-channel-registry.ts`
4. `src/plugins/channels/runtime/friday-channel-ingress-router.ts`
5. `src/plugins/channels/runtime/friday-channel-egress-router.ts`
6. `src/plugins/channels/runtime/friday-channel-session-bridge.ts`
7. `src/plugins/channels/runtime/friday-channel-agent-orchestrator.ts`
8. `src/plugins/channels/runtime/friday-channel-runtime.ts`
9. `src/plugins/channels/builtin/qq/friday-qq-channel-plugin.ts`
10. `src/plugins/channels/builtin/qq/friday-qq-gateway-client.ts`
11. `src/plugins/channels/builtin/lark/friday-lark-channel-plugin.ts`
12. `src/plugins/channels/builtin/lark/friday-lark-websocket-client.ts`
13. `src/plugins/channels/builtin/lark/friday-lark-signature.ts`
14. `src/config/friday-config.types.ts` update
15. `src/config/friday-config.schema.ts` update
16. `src/hub/friday-hub-bootstrap.ts` startup/shutdown wiring
17. `src/api/http/routes/friday-setup-routes.ts` channel kind + config integration update

## 9. Test Strategy
Unit:
1. Channel config schema validation for QQ/Lark/Feishu.
2. Ingress router allowlist, dedupe, and session key mapping.
3. Unified message mapper for QQ and Lark payload fixtures.
4. QQ gateway reconnect/heartbeat/token refresh logic.
5. Lark websocket envelope ACK/decrypt/parse logic.
6. Egress routing and send result persistence.

Integration:
1. End-to-end inbound message to session append to agent run to outbound send.
2. Idempotent duplicate inbound event suppression.
3. Runtime startup/shutdown ordering with enabled/disabled channel instances.
4. Failure paths: token expiry, websocket disconnect, send API 429/5xx retry policy.

E2E:
1. Mock QQ gateway stream + send API.
2. Mock Lark/Feishu websocket stream + send API.
3. Setup-wizard save -> config projection -> runtime effective channels.
4. Multi-instance isolation (two QQ bots, two Lark tenants) with correct routing.

If you want, I can convert this into a concrete phased implementation plan (PR-sized tasks with estimated blast radius per file).
