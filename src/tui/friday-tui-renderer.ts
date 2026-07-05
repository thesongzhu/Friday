/**
 * TUI Renderer — Pure functions that produce ANSI-formatted terminal output
 * from the current TUI state. No side effects — the controller decides when
 * to write to stdout.
 *
 * @module tui/friday-tui-renderer
 */

import type {
  FridayTuiEvent,
  FridayTuiHubStatus,
  FridayTuiJobSummary,
  FridayTuiPairingSummary,
  FridayTuiSessionSummary,
  FridayTuiState,
  FridayTuiView,
} from "./friday-tui.types.js";

// ─── ANSI helpers ───

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

const ANSI_ESCAPE_SEQUENCE_PATTERN = /(?:\x1B\][\s\S]*?(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-Z\\-_])/g;
const TERMINAL_CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F-\x9F]/g;
const DIRECTIONAL_FORMAT_CONTROL_PATTERN = /[\u202A-\u202E\u2066-\u2069]/g;

function sanitizeTuiText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "")
    .replace(TERMINAL_CONTROL_CHAR_PATTERN, "")
    .replace(DIRECTIONAL_FORMAT_CONTROL_PATTERN, "");
}

function tuiText(value: string, maxLength?: number): string {
  const sanitized = sanitizeTuiText(value);
  return typeof maxLength === "number" ? sanitized.slice(0, maxLength) : sanitized;
}

// ─── Interface ───

export interface FridayTuiRenderer {
  renderFrame(state: FridayTuiState): string;
  renderStatusBar(state: FridayTuiState): string;
  renderHelp(): string;
}

// ─── Factory ───

export function createFridayTuiRenderer(): FridayTuiRenderer {
  function renderHeader(view: FridayTuiView): string {
    const title = {
      dashboard: "Dashboard",
      sessions: "Sessions",
      jobs: "Jobs",
      pairing: "Satellite Pairing",
      events: "Live Events",
      help: "Help",
    }[view];

    return `${BOLD}${CYAN}── Friday TUI ── ${title}${RESET}\n`;
  }

  function renderHubStatus(hub: FridayTuiHubStatus | null): string {
    if (!hub) return `${DIM}Hub status: loading...${RESET}\n`;
    const upMin = Math.floor(hub.uptime / 60);
    return [
      `${BOLD}Hub${RESET} v${tuiText(hub.version)}  `,
      `${GREEN}up ${upMin}m${RESET}  `,
      `sessions: ${hub.activeSessions}  `,
      `jobs: ${hub.runningJobs}  `,
      `satellites: ${hub.connectedSatellites}`,
    ].join("") + "\n";
  }

  function statusColor(status: string): string {
    if (status === "active" || status === "online" || status === "running") return GREEN;
    if (status === "pending" || status === "degraded" || status === "pending_approval") return YELLOW;
    if (status === "error" || status === "offline" || status === "failed") return RED;
    return DIM;
  }

  function renderDashboard(state: FridayTuiState): string {
    const lines: string[] = [];
    lines.push(renderHubStatus(state.hubStatus));
    lines.push("");

    // Quick counts
    const activeCount = state.sessions.filter(s => s.status === "active").length;
    const pendingPairings = state.pairings.length;
    const runningJobs = state.jobs.filter(j => j.status === "running").length;

    lines.push(`${BOLD}Quick Summary${RESET}`);
    lines.push(`  Active sessions:    ${activeCount}`);
    lines.push(`  Running jobs:       ${runningJobs}`);
    lines.push(`  Pending pairings:   ${pendingPairings}`);
    lines.push(`  Recent events:      ${state.events.length}`);

    if (state.error) {
      lines.push("");
      lines.push(`${RED}Error: ${tuiText(state.error)}${RESET}`);
    }

    return lines.join("\n") + "\n";
  }

  function renderSessions(sessions: ReadonlyArray<FridayTuiSessionSummary>): string {
    if (sessions.length === 0) return `${DIM}No sessions.${RESET}\n`;
    const lines: string[] = [];
    lines.push(`${BOLD}${"ID".padEnd(12)} ${"Channel".padEnd(16)} ${"Status".padEnd(12)} Created${RESET}`);
    for (const s of sessions) {
      const sessionId = tuiText(s.sessionId, 10);
      const channelId = tuiText(s.channelId, 14);
      const status = tuiText(s.status);
      const createdAt = tuiText(s.createdAt, 16);
      const color = statusColor(status);
      lines.push(
        `${sessionId.padEnd(12)} ` +
        `${channelId.padEnd(16)} ` +
        `${color}${status.padEnd(12)}${RESET} ` +
        `${DIM}${createdAt}${RESET}`,
      );
    }
    return lines.join("\n") + "\n";
  }

  function renderJobs(jobs: ReadonlyArray<FridayTuiJobSummary>): string {
    if (jobs.length === 0) return `${DIM}No jobs.${RESET}\n`;
    const lines: string[] = [];
    lines.push(`${BOLD}${"Name".padEnd(28)} ${"Status".padEnd(12)} Last Run${RESET}`);
    for (const j of jobs) {
      const name = tuiText(j.name, 26);
      const status = tuiText(j.status);
      const lastRunAt = j.lastRunAt ? tuiText(j.lastRunAt, 16) : "never";
      const color = statusColor(status);
      lines.push(
        `${name.padEnd(28)} ` +
        `${color}${status.padEnd(12)}${RESET} ` +
        `${DIM}${lastRunAt}${RESET}`,
      );
    }
    return lines.join("\n") + "\n";
  }

  function renderPairings(pairings: ReadonlyArray<FridayTuiPairingSummary>): string {
    if (pairings.length === 0) return `${DIM}No pending pairings.${RESET}\n`;
    const lines: string[] = [];
    lines.push(`${BOLD}${"Satellite".padEnd(20)} ${"Type".padEnd(10)} ${"Code".padEnd(12)} Expires${RESET}`);
    for (const p of pairings) {
      const displayName = tuiText(p.displayName, 18);
      const type = tuiText(p.type);
      const pairingCode = tuiText(p.pairingCode);
      const expiresAt = tuiText(p.expiresAt, 16);
      lines.push(
        `${MAGENTA}${displayName.padEnd(20)}${RESET} ` +
        `${type.padEnd(10)} ` +
        `${YELLOW}${pairingCode.padEnd(12)}${RESET} ` +
        `${DIM}${expiresAt}${RESET}`,
      );
    }
    lines.push("");
    lines.push(`${DIM}Commands: approve <id> | reject <id> [reason]${RESET}`);
    return lines.join("\n") + "\n";
  }

  function renderEvents(events: ReadonlyArray<FridayTuiEvent>): string {
    if (events.length === 0) return `${DIM}No events yet.${RESET}\n`;
    const lines: string[] = [];
    const recent = events.slice(-20);
    for (const e of recent) {
      const timestamp = tuiText(e.timestamp, 19).slice(11, 19);
      const type = tuiText(e.type);
      const message = tuiText(e.message);
      lines.push(
        `${DIM}${timestamp}${RESET} ` +
        `${CYAN}[${type}]${RESET} ${message}`,
      );
    }
    return lines.join("\n") + "\n";
  }

  function viewBody(state: FridayTuiState): string {
    switch (state.currentView) {
      case "dashboard": return renderDashboard(state);
      case "sessions": return renderSessions(state.sessions);
      case "jobs": return renderJobs(state.jobs);
      case "pairing": return renderPairings(state.pairings);
      case "events": return renderEvents(state.events);
      case "help": return renderHelp();
    }
  }

  function renderHelp(): string {
    return [
      `${BOLD}Navigation${RESET}`,
      `  d  Dashboard`,
      `  s  Sessions`,
      `  j  Jobs`,
      `  p  Pairing`,
      `  e  Events`,
      `  h  Help`,
      `  r  Refresh`,
      `  q  Quit`,
      "",
      `${BOLD}Actions${RESET}`,
      `  approve <satelliteId>      Approve pending pairing`,
      `  reject <satelliteId>       Reject pending pairing`,
      `  heartbeat                  Trigger heartbeat check`,
      "",
    ].join("\n") + "\n";
  }

  function renderStatusBar(state: FridayTuiState): string {
    const conn = state.isConnected ? `${GREEN}connected${RESET}` : `${RED}disconnected${RESET}`;
    const refresh = state.lastRefreshedAt ? `${DIM}last: ${state.lastRefreshedAt.slice(11, 19)}${RESET}` : "";
    return `${DIM}[${state.currentView}]${RESET} ${conn} ${refresh}  ${DIM}h=help q=quit${RESET}\n`;
  }

  return {
    renderFrame(state: FridayTuiState): string {
      return renderHeader(state.currentView) + viewBody(state) + "\n" + renderStatusBar(state);
    },
    renderStatusBar,
    renderHelp,
  };
}
