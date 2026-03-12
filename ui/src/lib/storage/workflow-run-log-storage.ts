// ─── Workflow run log — tracks run IDs per workflow locally ───

const STORAGE_KEY = "friday.workflows.run-log.v1";
const MAX_RUN_IDS = 50;

interface RunLogData {
  [workflowId: string]: {
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

export const workflowRunLogStorage = {
  getRunIds(workflowId: string): string[] {
    const data = load();
    return data[workflowId]?.runIds ?? [];
  },

  appendRunId(workflowId: string, runId: string): void {
    const data = load();
    const entry = data[workflowId] ?? { runIds: [], updatedAt: "" };
    entry.runIds = [runId, ...entry.runIds.filter((id) => id !== runId)].slice(0, MAX_RUN_IDS);
    entry.updatedAt = new Date().toISOString();
    data[workflowId] = entry;
    save(data);
  },

  clearRunLog(workflowId: string): void {
    const data = load();
    delete data[workflowId];
    save(data);
  },
};
