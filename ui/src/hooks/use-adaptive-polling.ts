import { useEffect, useState } from "react";

function readVisibilityState() {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return {
      hidden: false,
      online: true,
      focused: true,
    };
  }

  return {
    hidden: document.visibilityState === "hidden",
    online: window.navigator.onLine,
    focused: document.hasFocus(),
  };
}

export function useAdaptivePollingInterval(input: {
  activeMs: number;
  backgroundMs?: number;
}): number | false {
  const [state, setState] = useState(readVisibilityState);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }

    const refresh = () => setState(readVisibilityState());
    window.addEventListener("focus", refresh);
    window.addEventListener("blur", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    document.addEventListener("visibilitychange", refresh);

    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("blur", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  if (!state.online || state.hidden) {
    return false;
  }

  if (!state.focused) {
    return input.backgroundMs ?? Math.max(input.activeMs * 3, input.activeMs + 10_000);
  }

  return input.activeMs;
}
