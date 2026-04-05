import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

// ─── Language mapping ───

const LANG_MAP = {
  // Common aliases
  chinese: "zh", mandarin: "zh", "zh-cn": "zh", "zh-tw": "zh-TW",
  japanese: "ja", korean: "ko", english: "en", spanish: "es",
  french: "fr", german: "de", italian: "it", portuguese: "pt",
  russian: "ru", arabic: "ar", hindi: "hi", thai: "th",
  vietnamese: "vi", turkish: "tr", dutch: "nl", polish: "pl",
  swedish: "sv", czech: "cs", indonesian: "id", malay: "ms",
};

const LANG_NAMES = {
  zh: "Chinese", "zh-TW": "Chinese (Traditional)", ja: "Japanese",
  ko: "Korean", en: "English", es: "Spanish", fr: "French",
  de: "German", it: "Italian", pt: "Portuguese", ru: "Russian",
  ar: "Arabic", hi: "Hindi", th: "Thai", vi: "Vietnamese",
  tr: "Turkish", nl: "Dutch", pl: "Polish", sv: "Swedish",
  cs: "Czech", id: "Indonesian", ms: "Malay",
};

function normalizeLanguage(lang) {
  if (!lang) return null;
  const lower = lang.toLowerCase().trim();
  // Direct code match
  if (LANG_NAMES[lower]) return lower;
  if (LANG_NAMES[lang]) return lang;
  // Alias match
  if (LANG_MAP[lower]) return LANG_MAP[lower];
  // Return as-is (trust the LLM)
  return lang;
}

function getLanguageName(code) {
  return LANG_NAMES[code] ?? code;
}

// ─── Formality helpers ───

const FORMALITY_INSTRUCTIONS = {
  formal: "Use formal, polite language appropriate for business or official communication.",
  informal: "Use casual, conversational language.",
  neutral: "Use a balanced, neutral tone.",
};

// ─── Domain-specific instructions ───

const DOMAIN_INSTRUCTIONS = {
  technical: "Preserve technical terminology accurately. Use standard industry terms.",
  legal: "Use precise legal terminology. Maintain formal structure.",
  medical: "Use correct medical terminology. Be precise with drug names and conditions.",
  casual: "Keep it natural and conversational. Prioritize readability over literal accuracy.",
  literary: "Preserve the tone, style, and literary devices of the original.",
  marketing: "Adapt the message for the target audience. Localize idioms and cultural references.",
};

// ─── Main executor ───

export async function execute(input = {}) {
  const text = asString(input.text ?? input.content);
  const targetLang = asString(input.targetLang ?? input.target);
  const sourceLang = asString(input.sourceLang ?? input.source);
  const formality = asString(input.formality ?? "neutral");
  const domain = asString(input.domain);

  if (!text) {
    throw new Error("translation-assistant requires text input.");
  }
  if (!targetLang) {
    throw new Error("translation-assistant requires a target language.");
  }

  const normalizedTarget = normalizeLanguage(targetLang);
  const normalizedSource = sourceLang ? normalizeLanguage(sourceLang) : null;

  // Build translation prompt for the LLM
  const parts = [];
  parts.push(`Translate the following text to ${getLanguageName(normalizedTarget)}:`);
  if (normalizedSource) {
    parts.push(`Source language: ${getLanguageName(normalizedSource)}.`);
  }
  parts.push(FORMALITY_INSTRUCTIONS[formality] ?? FORMALITY_INSTRUCTIONS.neutral);
  if (domain && DOMAIN_INSTRUCTIONS[domain]) {
    parts.push(DOMAIN_INSTRUCTIONS[domain]);
  }
  parts.push("");
  parts.push("---");
  parts.push(text);
  parts.push("---");
  parts.push("");
  parts.push("Provide only the translated text, without explanations or annotations.");

  const translationPrompt = parts.join("\n");

  return {
    summary: `Translation request: ${normalizedSource ? getLanguageName(normalizedSource) : "auto"} → ${getLanguageName(normalizedTarget)} (${compact(text, 60)})`,
    nextStep: "The translation prompt has been prepared. Use the LLM to generate the translation, or use DeepL API via web_fetch if FRIDAY_DEEPL_API_KEY is configured.",
    details: {
      sourceText: compact(text, 500),
      sourceLang: normalizedSource ? getLanguageName(normalizedSource) : "auto-detect",
      targetLang: getLanguageName(normalizedTarget),
      targetLangCode: normalizedTarget,
      formality,
      domain: domain || "general",
      translationPrompt,
      charCount: text.length,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      deeplHint: "If FRIDAY_DEEPL_API_KEY is set, use web_fetch with https://api-free.deepl.com/v2/translate for higher quality translations.",
    },
  };
}
