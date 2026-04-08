export interface LocalizedText {
  zh: string;
  en: string;
}

export type AppLocale = "zh" | "en";

export function localizedText(zh: string, en: string): LocalizedText {
  return { zh, en };
}

export function resolveLocalizedText(text: LocalizedText, locale: AppLocale): string {
  return locale === "zh" ? text.zh : text.en;
}

export function localize(locale: AppLocale, zh: string, en: string): string {
  return locale === "zh" ? zh : en;
}

export function detectSystemLocale(): AppLocale {
  if (typeof navigator === "undefined") {
    return "en";
  }
  const candidates = [
    navigator.language,
    ...(navigator.languages ?? []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return candidates.some((value) => value.toLowerCase().startsWith("zh")) ? "zh" : "en";
}

export function isAppLocale(value: unknown): value is AppLocale {
  return value === "zh" || value === "en";
}
