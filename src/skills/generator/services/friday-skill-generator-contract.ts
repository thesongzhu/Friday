import type { FridaySkillGenerationTurn } from "../model/friday-skill-generator.types.js";

export interface FridaySkillGenerationContract {
  expectedSkillId?: string;
  expectedVersion?: string;
  requiredOutputMarkers: string[];
  preserveExistingSkillId: boolean;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function extractFirstCapture(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  return match?.[1]?.trim();
}

function extractAllCaptures(text: string, pattern: RegExp): string[] {
  const results: string[] = [];
  const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (const match of text.matchAll(regex)) {
    const candidate = match[1]?.trim();
    if (candidate) {
      results.push(candidate);
    }
  }
  return results;
}

function collectContractTexts(input: {
  goal: string;
  spec?: Record<string, unknown> | null;
  turns?: FridaySkillGenerationTurn[];
}): string[] {
  const texts = [input.goal];
  if (input.spec) {
    const successTests = input.spec["successTests"];
    if (Array.isArray(successTests)) {
      for (const item of successTests) {
        if (typeof item === "string" && item.trim().length > 0) {
          texts.push(item.trim());
        }
      }
    }
    const constraints = input.spec["constraints"];
    if (Array.isArray(constraints)) {
      for (const item of constraints) {
        if (typeof item === "string" && item.trim().length > 0) {
          texts.push(item.trim());
        }
      }
    }
  }
  for (const turn of input.turns ?? []) {
    if (turn.role === "user" && turn.content.trim().length > 0) {
      texts.push(turn.content.trim());
    }
  }
  return texts;
}

function extractExpectedSkillId(texts: readonly string[], spec?: Record<string, unknown> | null): string | undefined {
  const fromSpec = spec?.["id"];
  if (typeof fromSpec === "string" && fromSpec.trim().length > 0) {
    return fromSpec.trim();
  }
  for (const text of [...texts].reverse()) {
    const captured = extractFirstCapture(text, /manifest id(?:\s+to)?\s+"([^"]+)"/i)
      ?? extractFirstCapture(text, /skill id(?:\s+to)?\s+"([^"]+)"/i);
    if (captured) {
      return captured;
    }
  }
  return undefined;
}

function extractExpectedVersion(texts: readonly string[], spec?: Record<string, unknown> | null): string | undefined {
  const fromSpec = spec?.["version"];
  if (typeof fromSpec === "string" && fromSpec.trim().length > 0) {
    return fromSpec.trim();
  }
  for (const text of [...texts].reverse()) {
    const captured = extractFirstCapture(text, /manifest version(?:\s+to)?\s+"([^"]+)"/i)
      ?? extractFirstCapture(text, /version(?:\s+to)?\s+"([^"]+)"/i);
    if (captured) {
      return captured;
    }
  }
  return undefined;
}

function extractRequiredOutputMarkers(texts: readonly string[]): string[] {
  for (const text of [...texts].reverse()) {
    const markers: string[] = [];
    markers.push(...extractAllCaptures(text, /must output the exact string\s+"([^"]+)"/gi));
    markers.push(...extractAllCaptures(text, /output the exact string\s+"([^"]+)"/gi));
    markers.push(...extractAllCaptures(text, /include the exact marker\s+"([^"]+)"/gi));
    markers.push(...extractAllCaptures(text, /must include the exact marker\s+"([^"]+)"/gi));
    markers.push(...extractAllCaptures(text, /say exactly\s+"([^"]+)"/gi));
    markers.push(...extractAllCaptures(text, /reply with exactly this text and nothing else:\s*"([^"]+)"/gi));
    markers.push(...extractAllCaptures(text, /reply with exactly this json and nothing else:\s*(\{[\s\S]+?\})/gi));
    if (markers.length > 0) {
      return uniqueStrings(markers);
    }
  }
  return [];
}

export function extractFridaySkillGenerationContract(input: {
  goal: string;
  spec?: Record<string, unknown> | null;
  turns?: FridaySkillGenerationTurn[];
}): FridaySkillGenerationContract {
  const texts = collectContractTexts(input);
  const joined = texts.join("\n");
  return {
    expectedSkillId: extractExpectedSkillId(texts, input.spec),
    expectedVersion: extractExpectedVersion(texts, input.spec),
    requiredOutputMarkers: extractRequiredOutputMarkers(texts),
    preserveExistingSkillId:
      /keep the exact same manifest id/i.test(joined) ||
      /do not create a new skill id/i.test(joined) ||
      /same skill id/i.test(joined),
  };
}
