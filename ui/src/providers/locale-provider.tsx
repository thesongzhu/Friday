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

  // Derive preferred locale from remote preferences — extract a stable primitive.
  const remoteLocaleRaw = values["display.locale"];
  const remoteLocale: AppLocale | null = isAppLocale(remoteLocaleRaw) ? remoteLocaleRaw : null;

  const [locale, setLocaleState] = React.useState<AppLocale>(
    () => remoteLocale ?? readLocalLocale() ?? detectSystemLocale(),
  );

  // Sync from remote preference only when the primitive value actually changes.
  const prevRemoteRef = React.useRef(remoteLocale);
  React.useEffect(() => {
    if (remoteLocale !== null && remoteLocale !== prevRemoteRef.current) {
      prevRemoteRef.current = remoteLocale;
      setLocaleState(remoteLocale);
    }
  }, [remoteLocale]);

  React.useEffect(() => {
    document.documentElement.setAttribute("data-locale", locale);
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  // Stable ref to setPreference to avoid re-creating setLocale on every render.
  const setPreferenceRef = React.useRef(setPreference);
  setPreferenceRef.current = setPreference;

  const setLocale = React.useCallback((nextLocale: AppLocale) => {
    writeLocalLocale(nextLocale);
    setLocaleState(nextLocale);
    setPreferenceRef.current("display.locale", nextLocale);
  }, []);

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
