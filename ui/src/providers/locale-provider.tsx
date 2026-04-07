import * as React from "react";
import { detectSystemLocale, isAppLocale, type AppLocale } from "@/lib/i18n/localized-text";
import { useUixPreferences } from "@/hooks/use-uix-preferences";

const LOCALE_STORAGE_KEY = "friday.uix.display-locale";

interface LocaleContextValue {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
}

const LocaleContext = React.createContext<LocaleContextValue | null>(null);

function readLocalLocale(): AppLocale | null {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return isAppLocale(raw) ? raw : null;
}

function writeLocalLocale(locale: AppLocale): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  }
}

export function LocaleProvider(props: { children: React.ReactNode }) {
  const { values, setPreference } = useUixPreferences();
  const preferredLocale = isAppLocale(values["display.locale"])
    ? values["display.locale"]
    : null;
  const [locale, setLocaleState] = React.useState<AppLocale>(() => preferredLocale ?? readLocalLocale() ?? detectSystemLocale());

  React.useEffect(() => {
    const nextLocale = preferredLocale ?? readLocalLocale() ?? detectSystemLocale();
    setLocaleState(nextLocale);
  }, [preferredLocale]);

  const setLocale = React.useCallback((nextLocale: AppLocale) => {
    writeLocalLocale(nextLocale);
    setLocaleState(nextLocale);
    setPreference("display.locale", nextLocale);
  }, [setPreference]);

  const value = React.useMemo<LocaleContextValue>(() => ({
    locale,
    setLocale,
  }), [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{props.children}</LocaleContext.Provider>;
}

export function useAppLocale(): LocaleContextValue {
  const context = React.useContext(LocaleContext);
  if (!context) {
    throw new Error("useAppLocale must be used within LocaleProvider");
  }
  return context;
}
