import type { FridayChannelSendOptions } from "./friday-channel.types.js";

const DOUBLE_ASTERISK_MARKDOWN_CHANNELS = new Set(["discord"]);
const SINGLE_ASTERISK_MARKDOWN_CHANNELS = new Set(["slack", "whatsapp"]);

type MarkdownStrongMode = "strip" | "single-asterisk";

function transformOutsideCode(text: string, transform: (segment: string) => string): string {
  let output = "";
  let index = 0;

  while (index < text.length) {
    if (text.startsWith("```", index)) {
      const end = text.indexOf("```", index + 3);
      if (end === -1) {
        output += text.slice(index);
        break;
      }
      output += text.slice(index, end + 3);
      index = end + 3;
      continue;
    }

    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end === -1) {
        output += text.slice(index);
        break;
      }
      output += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }

    const nextTick = text.indexOf("`", index);
    const segmentEnd = nextTick === -1 ? text.length : nextTick;
    output += transform(text.slice(index, segmentEnd));
    index = segmentEnd;
  }

  return output;
}

function transformMarkdownStrongMarkers(text: string, mode: MarkdownStrongMode): string {
  return transformOutsideCode(text, (segment) => {
    const replacement = mode === "single-asterisk" ? "*$1*" : "$1";
    return segment
      .replace(/\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*/g, replacement)
      .replace(/__([^\s_](?:[\s\S]*?[^\s_])?)__/g, replacement);
  });
}

export function formatFridayChannelOutboundText(channelKind: string, text: string): string {
  const normalizedKind = channelKind.trim().toLowerCase();
  if (DOUBLE_ASTERISK_MARKDOWN_CHANNELS.has(normalizedKind)) {
    return text;
  }
  if (SINGLE_ASTERISK_MARKDOWN_CHANNELS.has(normalizedKind)) {
    return transformMarkdownStrongMarkers(text, "single-asterisk");
  }
  return transformMarkdownStrongMarkers(text, "strip");
}

export function formatFridayChannelOutboundSendOptions(
  channelKind: string,
  options: FridayChannelSendOptions,
): FridayChannelSendOptions {
  if (options.approval) {
    return options;
  }

  const text = formatFridayChannelOutboundText(channelKind, options.text);
  return text === options.text ? options : { ...options, text };
}
