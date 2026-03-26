const LAST_SKILL_GENERATOR_SESSION_KEY = "friday.skills.generator.last-session-id";

function readStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readLastSkillGeneratorSessionId(): string | null {
  const storage = readStorage();
  const value = storage?.getItem(LAST_SKILL_GENERATOR_SESSION_KEY) ?? null;
  return value && value.trim().length > 0 ? value : null;
}

export function writeLastSkillGeneratorSessionId(sessionId: string): void {
  const storage = readStorage();
  if (!storage) return;
  storage.setItem(LAST_SKILL_GENERATOR_SESSION_KEY, sessionId);
}

export function clearLastSkillGeneratorSessionId(): void {
  const storage = readStorage();
  if (!storage) return;
  storage.removeItem(LAST_SKILL_GENERATOR_SESSION_KEY);
}
