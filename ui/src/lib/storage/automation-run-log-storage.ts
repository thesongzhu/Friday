// ─── Automation run log — tracks run IDs per automation locally ───

const STORAGE_KEY = "friday.automations.run-log.v1";
const MAX_RUN_IDS = 50;

interface RunLogData {
  [automationId: string]: {
    runIds: string[];
    updatedAt: string;
  };
}

function load(): RunLogData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as RunLogData;
  } catch {
    return {};
  }
}

function save(data: RunLogData): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export const automationRunLogStorage = {
  getRunIds(automationId: string): string[] {
    const data = load();
    return data[automationId]?.runIds ?? [];
  },

  appendRunId(automationId: string, runId: string): void {
    const data = load();
    const entry = data[automationId] ?? { runIds: [], updatedAt: "" };
    // Prepend (newest first) and cap at MAX_RUN_IDS
    entry.runIds = [runId, ...entry.runIds.filter((id) => id !== runId)].slice(0, MAX_RUN_IDS);
    entry.updatedAt = new Date().toISOString();
    data[automationId] = entry;
    save(data);
  },

  clearRunLog(automationId: string): void {
    const data = load();
    delete data[automationId];
    save(data);
  },
};
