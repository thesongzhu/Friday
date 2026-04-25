/**
 * Brief secret slots — controlled vocabulary for credentials the UI can set.
 *
 * Each slot maps to one configuration field that holds a `*RefKey` string.
 * The refKey itself is the slot name (deterministic), so saving a secret
 * always writes to the same storage row for that slot. The server decides
 * the refKey to avoid exposing encryption details to the UI.
 */

import type { FridayBriefConfig } from "./friday-brief-config.types.js";

export const FRIDAY_BRIEF_SECRET_SLOTS = [
  "channels.wecom.secret",
  "channels.telegram.botToken",
  "channels.email.password",
  "tts.azure.key",
  "tts.google.apiKey",
  "sources.slack.token",
  "sources.mail.credential",
  "sources.calendar.credential",
  "sources.issues.linear.apiKey",
  "sources.issues.jira.credential",
  "sources.issues.github.token",
] as const;

export type FridayBriefSecretSlot = (typeof FRIDAY_BRIEF_SECRET_SLOTS)[number];

export function isFridayBriefSecretSlot(value: unknown): value is FridayBriefSecretSlot {
  return (
    typeof value === "string"
    && (FRIDAY_BRIEF_SECRET_SLOTS as readonly string[]).includes(value)
  );
}

/** Return the current refKey stored in the config for a given slot. */
export function readSlotRefKey(config: FridayBriefConfig, slot: FridayBriefSecretSlot): string | undefined {
  switch (slot) {
    case "channels.wecom.secret":
      return config.channels.wecom.secretRefKey;
    case "channels.telegram.botToken":
      return config.channels.telegram.botTokenRefKey;
    case "channels.email.password":
      return config.channels.email.passwordRefKey;
    case "tts.azure.key":
      return config.tts.azure.keyRefKey;
    case "tts.google.apiKey":
      return config.tts.google.apiKeyRefKey;
    case "sources.slack.token":
      return config.sources.slack.tokenRefKey;
    case "sources.mail.credential":
      return config.sources.mail.credentialRefKey;
    case "sources.calendar.credential":
      return config.sources.calendar.credentialRefKey;
    case "sources.issues.linear.apiKey":
      return config.sources.issues.linear.apiKeyRefKey;
    case "sources.issues.jira.credential":
      return config.sources.issues.jira.credentialRefKey;
    case "sources.issues.github.token":
      return config.sources.issues.github.tokenRefKey;
  }
}

/**
 * Return a new config with the slot's refKey field set to `refKey` (or cleared
 * when `refKey` is `undefined`). Pure — does not mutate the input.
 */
export function writeSlotRefKey(
  config: FridayBriefConfig,
  slot: FridayBriefSecretSlot,
  refKey: string | undefined,
): FridayBriefConfig {
  switch (slot) {
    case "channels.wecom.secret":
      return {
        ...config,
        channels: { ...config.channels, wecom: { ...config.channels.wecom, secretRefKey: refKey } },
      };
    case "channels.telegram.botToken":
      return {
        ...config,
        channels: {
          ...config.channels,
          telegram: { ...config.channels.telegram, botTokenRefKey: refKey },
        },
      };
    case "channels.email.password":
      return {
        ...config,
        channels: {
          ...config.channels,
          email: { ...config.channels.email, passwordRefKey: refKey },
        },
      };
    case "tts.azure.key":
      return {
        ...config,
        tts: { ...config.tts, azure: { ...config.tts.azure, keyRefKey: refKey } },
      };
    case "tts.google.apiKey":
      return {
        ...config,
        tts: { ...config.tts, google: { ...config.tts.google, apiKeyRefKey: refKey } },
      };
    case "sources.slack.token":
      return {
        ...config,
        sources: {
          ...config.sources,
          slack: { ...config.sources.slack, tokenRefKey: refKey },
        },
      };
    case "sources.mail.credential":
      return {
        ...config,
        sources: {
          ...config.sources,
          mail: { ...config.sources.mail, credentialRefKey: refKey },
        },
      };
    case "sources.calendar.credential":
      return {
        ...config,
        sources: {
          ...config.sources,
          calendar: { ...config.sources.calendar, credentialRefKey: refKey },
        },
      };
    case "sources.issues.linear.apiKey":
      return {
        ...config,
        sources: {
          ...config.sources,
          issues: {
            ...config.sources.issues,
            linear: { ...config.sources.issues.linear, apiKeyRefKey: refKey },
          },
        },
      };
    case "sources.issues.jira.credential":
      return {
        ...config,
        sources: {
          ...config.sources,
          issues: {
            ...config.sources.issues,
            jira: { ...config.sources.issues.jira, credentialRefKey: refKey },
          },
        },
      };
    case "sources.issues.github.token":
      return {
        ...config,
        sources: {
          ...config.sources,
          issues: {
            ...config.sources.issues,
            github: { ...config.sources.issues.github, tokenRefKey: refKey },
          },
        },
      };
  }
}
