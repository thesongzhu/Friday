// Phase 14.5E module_28e Slice 6.2 — deterministic per-channel setup status
// surface for `GET /v1/setup/channels/status`. The status table is a thin
// deterministic projection of (a) the channel registry health view and
// (b) the v1 channel env tuple presence checked against `process.env`. It
// produces the same proof label vocabulary as the RGG executors (Slices
// 6.6/6.7) so the wizard and the RGG vehicle never disagree on whether a
// channel is `configured`/`not_configured`/`blocked_by_env`/`unsupported`.

import {
  deriveFridayChannelProofLabel,
  type FridayChannelHealthSummary,
  type FridayChannelProofLabel,
  type FridayChannelRegistryView,
  isFridayChannelV1ProofKind,
} from "./friday-channel-registry.js";

export interface FridayChannelSetupStatusRow {
  channelId: string;
  kind: string;
  displayName: string;
  proofLabel: FridayChannelProofLabel;
  credentialStatus: FridayChannelHealthSummary["credentialStatus"];
  blockedReason: string | null;
  requiredEnvVars: readonly string[];
  missingEnvVars: readonly string[];
  lastProofResult: null;
}

export interface FridayChannelSetupStatusResponse {
  channels: FridayChannelSetupStatusRow[];
}

interface ChannelDescriptor {
  channelId: string;
  kind: string;
  // The Lark plugin rewrites its own `kind` to "feishu" at runtime when
  // `useFeishu: true`, so the registry view for the Lark/Feishu v1 row
  // can arrive under either kind. The descriptor declares both the
  // canonical kind and any runtime aliases so the v1 row is the single
  // source of truth — the alias never appears as a separate
  // `unsupported` row.
  aliasKinds: readonly string[];
  displayName: string;
  requiredEnvVars: readonly string[];
}

const V1_CHANNEL_DESCRIPTORS: readonly ChannelDescriptor[] = Object.freeze([
  Object.freeze({
    channelId: "discord",
    kind: "discord",
    aliasKinds: Object.freeze([]),
    displayName: "Discord",
    requiredEnvVars: Object.freeze([
      "FRIDAY_DISCORD_BOT_TOKEN",
      "FRIDAY_DISCORD_SETUP_USER_ID",
      "FRIDAY_DISCORD_GUILD_ID",
      "FRIDAY_DISCORD_CHANNEL_ID",
    ]),
  }),
  Object.freeze({
    channelId: "lark",
    kind: "lark",
    aliasKinds: Object.freeze(["feishu"]),
    displayName: "Lark / Feishu",
    requiredEnvVars: Object.freeze([
      "FRIDAY_LARK_APP_ID",
      "FRIDAY_LARK_APP_SECRET",
      "FRIDAY_LARK_VERIFICATION_TOKEN",
      "FRIDAY_LARK_ENCRYPT_KEY",
      "FRIDAY_LARK_TEST_CHAT_ID",
    ]),
  }),
  Object.freeze({
    channelId: "telegram",
    kind: "telegram",
    aliasKinds: Object.freeze([]),
    displayName: "Telegram",
    requiredEnvVars: Object.freeze([
      "FRIDAY_TELEGRAM_BOT_TOKEN",
      "FRIDAY_TELEGRAM_TEST_CHAT_ID",
    ]),
  }),
]);

export const FRIDAY_CHANNEL_V1_SETUP_DESCRIPTORS = V1_CHANNEL_DESCRIPTORS;

export function buildFridayChannelSetupStatus(input: {
  views?: readonly FridayChannelRegistryView[];
  processEnv?: NodeJS.ProcessEnv;
}): FridayChannelSetupStatusResponse {
  const env = input.processEnv ?? process.env;
  const views = input.views ?? [];
  const viewByKind = new Map(views.map((view) => [view.kind, view]));

  const v1Rows = V1_CHANNEL_DESCRIPTORS.map((descriptor) =>
    buildRow(descriptor, resolveDescriptorView(descriptor, viewByKind), env));

  // Surface any registered non-v1 channels as `unsupported` so the wizard
  // does not silently hide them. Discord/Lark/Feishu/Telegram are covered
  // by the v1 loop above; everything else (slack, webchat, line, whatsapp,
  // qq, signal, irc) falls into this list with `unsupported` proof label.
  const v1Kinds = new Set<string>();
  for (const descriptor of V1_CHANNEL_DESCRIPTORS) {
    v1Kinds.add(descriptor.kind);
    for (const alias of descriptor.aliasKinds) {
      v1Kinds.add(alias);
    }
  }
  const nonV1Rows = views
    .filter((view) => !v1Kinds.has(view.kind))
    .map((view): FridayChannelSetupStatusRow => ({
      channelId: view.kind,
      kind: view.kind,
      displayName: titleCase(view.kind),
      proofLabel: "unsupported",
      credentialStatus: view.health.credentialStatus,
      blockedReason: view.health.blockedReason ?? null,
      requiredEnvVars: [],
      missingEnvVars: [],
      lastProofResult: null,
    }));

  return { channels: [...v1Rows, ...nonV1Rows] };
}

function resolveDescriptorView(
  descriptor: ChannelDescriptor,
  viewByKind: ReadonlyMap<string, FridayChannelRegistryView>,
): FridayChannelRegistryView | undefined {
  const primary = viewByKind.get(descriptor.kind);
  if (primary) return primary;
  for (const alias of descriptor.aliasKinds) {
    const view = viewByKind.get(alias);
    if (view) return view;
  }
  return undefined;
}

function buildRow(
  descriptor: ChannelDescriptor,
  view: FridayChannelRegistryView | undefined,
  env: NodeJS.ProcessEnv,
): FridayChannelSetupStatusRow {
  const missingEnvVars = descriptor.requiredEnvVars.filter(
    (key) => !String(env[key] ?? "").trim(),
  );
  const credentialStatus = view?.health.credentialStatus ?? "unknown";
  const blockedReason = view?.health.blockedReason ?? null;
  const proofLabel = deriveFridayChannelProofLabel({
    kind: descriptor.kind,
    credentialStatus,
    blockedReason: blockedReason ?? undefined,
    envMissingVars: missingEnvVars,
    envRequiredVars: descriptor.requiredEnvVars,
  });
  return {
    channelId: descriptor.channelId,
    kind: descriptor.kind,
    displayName: descriptor.displayName,
    proofLabel,
    credentialStatus,
    blockedReason,
    requiredEnvVars: descriptor.requiredEnvVars,
    missingEnvVars,
    lastProofResult: null,
  };
}

function titleCase(value: string): string {
  if (value.length === 0) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function isFridayChannelV1SetupKind(kind: string): boolean {
  return isFridayChannelV1ProofKind(kind);
}
