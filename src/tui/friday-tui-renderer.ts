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
      `${BOLD}Hub${RESET} v${hub.version}  `,
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
      lines.push(`${RED}Error: ${state.error}${RESET}`);
    }

    return lines.join("\n") + "\n";
  }

  function renderSessions(sessions: ReadonlyArray<FridayTuiSessionSummary>): string {
    if (sessions.length === 0) return `${DIM}No sessions.${RESET}\n`;
    const lines: string[] = [];
    lines.push(`${BOLD}${"ID".padEnd(12)} ${"Channel".padEnd(16)} ${"Status".padEnd(12)} Created${RESET}`);
    for (const s of sessions) {
      const color = statusColor(s.status);
      lines.push(
        `${s.sessionId.slice(0, 10).padEnd(12)} ` +
        `${s.channelId.slice(0, 14).padEnd(16)} ` +
        `${color}${s.status.padEnd(12)}${RESET} ` +
        `${DIM}${s.createdAt.slice(0, 16)}${RESET}`,
      );
    }
    return lines.join("\n") + "\n";
  }

  function renderJobs(jobs: ReadonlyArray<FridayTuiJobSummary>): string {
    if (jobs.length === 0) return `${DIM}No jobs.${RESET}\n`;
    const lines: string[] = [];
    lines.push(`${BOLD}${"Name".padEnd(28)} ${"Status".padEnd(12)} Last Run${RESET}`);
    for (const j of jobs) {
      const color = statusColor(j.status);
      lines.push(
        `${j.name.slice(0, 26).padEnd(28)} ` +
        `${color}${j.status.padEnd(12)}${RESET} ` +
        `${DIM}${j.lastRunAt?.slice(0, 16) ?? "never"}${RESET}`,
      );
    }
    return lines.join("\n") + "\n";
  }

  function renderPairings(pairings: ReadonlyArray<FridayTuiPairingSummary>): string {
    if (pairings.length === 0) return `${DIM}No pending pairings.${RESET}\n`;
    const lines: string[] = [];
    lines.push(`${BOLD}${"Satellite".padEnd(20)} ${"Type".padEnd(10)} ${"Code".padEnd(12)} Expires${RESET}`);
    for (const p of pairings) {
      lines.push(
        `${MAGENTA}${p.displayName.slice(0, 18).padEnd(20)}${RESET} ` +
        `${p.type.padEnd(10)} ` +
        `${YELLOW}${p.pairingCode.padEnd(12)}${RESET} ` +
        `${DIM}${p.expiresAt.slice(0, 16)}${RESET}`,
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
      lines.push(
        `${DIM}${e.timestamp.slice(11, 19)}${RESET} ` +
        `${CYAN}[${e.type}]${RESET} ${e.message}`,
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
