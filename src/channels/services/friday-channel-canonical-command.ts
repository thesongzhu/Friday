// Phase 14.5E module_28e Slice 6.3 — deterministic canonical command +
// risk preview routing for channel-triggered actions.
//
// Channel inbound messages flow through this module as:
//
//   natural language → canonical command → risk level → risk preview
//   (low/medium → in-channel confirmation, high → owner-link request)
//
// The verb/target → risk table is a curated allowlist; there is no LLM
// call, no free-form NLU, and no fuzzy match. The same input always
// produces the same canonical command and the same risk level so the
// downstream owner-link verifier (Slice 6.4) can rely on a stable
// `actionId` and `riskLevel`.

export type FridayChannelRiskLevel = "low" | "medium" | "high";

export type FridayChannelCanonicalVerb =
  | "status"
  | "diagnose"
  | "preview_repair"
  | "apply_repair"
  | "rollback"
  | "rotate_credential"
  | "approve_action"
  | "execute_action";

export interface FridayChannelCanonicalCommand {
  readonly verb: FridayChannelCanonicalVerb;
  readonly target: string;
  readonly args: Readonly<Record<string, string>>;
  readonly riskLevel: FridayChannelRiskLevel;
}

export interface FridayChannelCanonicalCommandParseInput {
  readonly channelKind: string;
  readonly chatId: string;
  readonly chatType: "direct" | "group";
  readonly senderId: string;
  readonly text: string;
}

export interface FridayChannelRiskPreview {
  readonly actionId: string;
  readonly channelKind: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly command: FridayChannelCanonicalCommand;
  readonly previewText: string;
  readonly confirmation: "in_channel" | "owner_link";
}

export interface FridayChannelOwnerLinkRequest {
  readonly actionId: string;
  readonly channelKind: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly command: FridayChannelCanonicalCommand;
  readonly previewText: string;
  readonly ownerLinkPath: string;
  readonly riskLevel: "high";
}

export type FridayChannelDispatchOutcome =
  | { kind: "no_match" }
  | { kind: "risk_preview"; preview: FridayChannelRiskPreview }
  | { kind: "owner_link_required"; request: FridayChannelOwnerLinkRequest };

interface CanonicalRule {
  readonly pattern: RegExp;
  readonly verb: FridayChannelCanonicalVerb;
  readonly target: string;
  readonly riskLevel: FridayChannelRiskLevel;
}

// Curated allowlist. Every entry must declare `riskLevel` explicitly so
// the table is reviewable. New verbs require an explicit edit here and a
// matching unit test; there is no fallback that lowers risk silently.
const CANONICAL_RULES: readonly CanonicalRule[] = [
  { pattern: /^\s*(?:friday\s+)?status\s*$/i, verb: "status", target: "runtime", riskLevel: "low" },
  { pattern: /^\s*(?:friday\s+)?(?:health|ping)\s*$/i, verb: "status", target: "runtime", riskLevel: "low" },
  { pattern: /^\s*(?:friday\s+)?diagnose\s*$/i, verb: "diagnose", target: "doctor", riskLevel: "low" },
  {
    pattern: /^\s*(?:friday\s+)?(?:preview\s+repair|repair\s+preview|fix\s+preview)\s*$/i,
    verb: "preview_repair",
    target: "auto_fix",
    riskLevel: "medium",
  },
  {
    pattern: /^\s*(?:friday\s+)?(?:apply\s+repair|run\s+repair|fix)\s*$/i,
    verb: "apply_repair",
    target: "auto_fix",
    riskLevel: "high",
  },
  {
    pattern: /^\s*(?:friday\s+)?(?:rollback|undo)\s*$/i,
    verb: "rollback",
    target: "auto_fix",
    riskLevel: "high",
  },
  {
    pattern: /^\s*(?:friday\s+)?(?:rotate\s+credential|rotate\s+secret|rotate\s+token)\s*$/i,
    verb: "rotate_credential",
    target: "secrets",
    riskLevel: "high",
  },
  {
    pattern: /^\s*(?:friday\s+)?approve\s+([A-Za-z0-9_\-:.]{4,128})\s*$/i,
    verb: "approve_action",
    target: "approval",
    riskLevel: "high",
  },
  {
    pattern: /^\s*(?:friday\s+)?execute\s+([A-Za-z0-9_\-:.]{4,128})\s*$/i,
    verb: "execute_action",
    target: "approval",
    riskLevel: "high",
  },
];

export function parseFridayChannelCanonicalCommand(
  input: FridayChannelCanonicalCommandParseInput,
): FridayChannelCanonicalCommand | null {
  const text = String(input.text ?? "").trim();
  if (text.length === 0) {
    return null;
  }
  for (const rule of CANONICAL_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const args: Record<string, string> = {};
    if (rule.verb === "approve_action" || rule.verb === "execute_action") {
      const target = match[1]?.trim() ?? "";
      if (target.length === 0) {
        return null;
      }
      args.actionId = target;
    }
    return Object.freeze({
      verb: rule.verb,
      target: rule.target,
      args: Object.freeze(args),
      riskLevel: rule.riskLevel,
    });
  }
  return null;
}

function buildActionId(input: {
  channelKind: string;
  chatId: string;
  senderId: string;
  verb: FridayChannelCanonicalVerb;
  target: string;
  args: Readonly<Record<string, string>>;
}): string {
  const carriedActionId = input.args.actionId;
  if (carriedActionId && carriedActionId.length > 0) {
    return carriedActionId;
  }
  const slug = [input.channelKind, input.chatId, input.senderId, input.verb, input.target]
    .map((segment) => String(segment ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"))
    .filter((segment) => segment.length > 0)
    .join(":");
  return slug || `${input.channelKind}:${input.verb}:${input.target}`;
}

function buildPreviewText(command: FridayChannelCanonicalCommand): string {
  const argsText = Object.entries(command.args)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const suffix = argsText.length > 0 ? ` (${argsText})` : "";
  return `Friday canonical command: ${command.verb} ${command.target}${suffix} [risk=${command.riskLevel}]`;
}

export function buildFridayChannelOwnerLinkPath(actionId: string): string {
  return `/v1/channels/actions/${encodeURIComponent(actionId)}/owner-approve`;
}

// Phase 14.5E module_28e Slice 6.3 — deterministic reply-text helper for
// the live inbound channel binding. The hub channel handler invokes
// `routeFridayChannelDispatch` on every inbound text message and, if the
// outcome is not `no_match`, calls this helper to format the reply that
// `channelRegistry.send()` delivers back to the originating chat.
//
// The reply text is intentionally narrow:
//   - low/medium → the preview text plus a one-line note that the
//     channel does not auto-execute (consistent with the dispatcher's
//     `confirmation: "in_channel"` shape; the channel surfaces what was
//     recognized without claiming an execute path that does not exist in
//     Phase 14.5E scope);
//   - high → the preview text plus the owner-link path (per the
//     bound-principal contract, high-risk actions cannot be approved or
//     executed from a channel message alone; the channel may only point
//     the owner at the owner-link).
//
// The returned string never includes secrets, tokens, or HMACs — the
// owner-link path is a relative URL the owner opens via the local
// Assistant / API surface, which mints the signed token separately.
export function buildFridayChannelDispatchReplyText(
  outcome: FridayChannelDispatchOutcome,
): string | null {
  if (outcome.kind === "no_match") return null;
  if (outcome.kind === "risk_preview") {
    return (
      `${outcome.preview.previewText}\n\n`
      + `Preview only. Friday will not auto-execute this command from the channel; `
      + `use the local Assistant or API surface to confirm.`
    );
  }
  return (
    `${outcome.request.previewText}\n\n`
    + `High-risk action requires an owner-signed approval. Owner-link path: `
    + `${outcome.request.ownerLinkPath}`
  );
}

export function routeFridayChannelDispatch(
  input: FridayChannelCanonicalCommandParseInput,
): FridayChannelDispatchOutcome {
  const command = parseFridayChannelCanonicalCommand(input);
  if (!command) {
    return { kind: "no_match" };
  }
  const actionId = buildActionId({
    channelKind: input.channelKind,
    chatId: input.chatId,
    senderId: input.senderId,
    verb: command.verb,
    target: command.target,
    args: command.args,
  });
  const previewText = buildPreviewText(command);
  if (command.riskLevel === "high") {
    return {
      kind: "owner_link_required",
      request: {
        actionId,
        channelKind: input.channelKind,
        chatId: input.chatId,
        senderId: input.senderId,
        command,
        previewText,
        ownerLinkPath: buildFridayChannelOwnerLinkPath(actionId),
        riskLevel: "high",
      },
    };
  }
  return {
    kind: "risk_preview",
    preview: {
      actionId,
      channelKind: input.channelKind,
      chatId: input.chatId,
      senderId: input.senderId,
      command,
      previewText,
      confirmation: "in_channel",
    },
  };
}
