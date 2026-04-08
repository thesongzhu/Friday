import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sessionsApi } from "@/lib/api/sessions";
import type { FridaySessionStatus } from "@/lib/api/types";

interface SessionMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

interface SessionMessageListResponse {
  items: SessionMessage[];
}

function useSessionList(filter: { status?: string }) {
  return useQuery({
    queryKey: ["sessions", filter],
    queryFn: () => sessionsApi.list({ status: filter.status as FridaySessionStatus | undefined }),
    refetchInterval: 30_000,
  });
}

function useSessionMessages(sessionKey: string | null) {
  return useQuery({
    queryKey: ["session-messages", sessionKey],
    queryFn: async (): Promise<SessionMessage[]> => {
      if (!sessionKey) return [];
      const records = await sessionsApi.listMessages(sessionKey);
      return records as unknown as SessionMessage[];
    },
    enabled: sessionKey !== null,
  });
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function exportSession(sessionKey: string, messages: SessionMessage[], format: "json" | "markdown") {
  let content: string;
  let filename: string;
  let mimeType: string;

  if (format === "json") {
    content = JSON.stringify({ sessionKey, messages }, null, 2);
    filename = `friday-session-${sessionKey}.json`;
    mimeType = "application/json";
  } else {
    const lines = [`# Friday Session: ${sessionKey}\n`];
    for (const msg of messages) {
      lines.push(`## ${msg.role} (${formatDate(msg.createdAt)})\n`);
      lines.push(`${msg.content}\n`);
    }
    content = lines.join("\n");
    filename = `friday-session-${sessionKey}.md`;
    mimeType = "text/markdown";
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function SessionsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const { data: sessions = [], isLoading } = useSessionList({ status: statusFilter || undefined });
  const { data: messages = [] } = useSessionMessages(selectedSession);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
            Sessions
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
            Browse, search, and export conversation history across all surfaces.
          </p>
        </div>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setSelectedSession(null); }}
          className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-1.5 text-sm text-[color:var(--color-text-primary)]"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Session list */}
        <div className="lg:col-span-1">
          {isLoading ? (
            <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-6 text-center text-sm text-[color:var(--color-text-secondary)]">
              Loading sessions...
            </div>
          ) : sessions.length === 0 ? (
            <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-6 text-center text-sm text-[color:var(--color-text-secondary)]">
              No sessions found.
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => (
                <button
                  key={session.key}
                  type="button"
                  onClick={() => setSelectedSession(session.key)}
                  className={`w-full rounded-xl border p-3 text-left transition-colors ${
                    selectedSession === session.key
                      ? "border-indigo-300 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-900/20"
                      : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] hover:bg-[color:var(--color-bg-hover)]"
                  }`}
                >
                  <p className="text-sm font-medium text-[color:var(--color-text-primary)] truncate">
                    {session.key}
                  </p>
                  <div className="mt-1 flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
                    <span>{session.status}</span>
                    {session.channel ? <span>via {session.channel}</span> : null}
                    <span>{formatDate(session.createdAt)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Transcript viewer */}
        <div className="lg:col-span-2">
          {selectedSession ? (
            <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)]">
              <div className="flex items-center justify-between border-b border-[color:var(--color-border-soft)] px-4 py-3">
                <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                  Transcript: {selectedSession}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => exportSession(selectedSession, messages, "json")}
                    className="rounded-lg border border-[color:var(--color-border-soft)] px-3 py-1 text-xs text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-hover)]"
                  >
                    Export JSON
                  </button>
                  <button
                    type="button"
                    onClick={() => exportSession(selectedSession, messages, "markdown")}
                    className="rounded-lg border border-[color:var(--color-border-soft)] px-3 py-1 text-xs text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-hover)]"
                  >
                    Export Markdown
                  </button>
                </div>
              </div>
              <div className="max-h-[600px] overflow-y-auto p-4">
                {messages.length === 0 ? (
                  <p className="text-sm text-[color:var(--color-text-secondary)]">No messages in this session.</p>
                ) : (
                  <div className="space-y-4">
                    {messages.map((msg) => (
                      <div key={msg.id} className="rounded-lg bg-[color:var(--color-bg-base)] p-3">
                        <div className="flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
                          <span className="font-medium">{msg.role}</span>
                          <span>{formatDate(msg.createdAt)}</span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-[color:var(--color-text-primary)]">{msg.content}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-8 text-center text-sm text-[color:var(--color-text-secondary)]">
              Select a session to view its transcript.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
