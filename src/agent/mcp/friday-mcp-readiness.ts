import type { SkillManifestV2, SkillMcpServerRequirement } from "#skills";
import type { FridayMcpServerConfig, FridayMcpServerState } from "./friday-mcp-adapter.types.js";

export interface FridayMcpServerReadiness {
  name: string;
  connected: boolean;
  authenticated: boolean;
  transport?: FridayMcpServerConfig["transport"];
  state?: FridayMcpServerState["state"];
}

export interface FridaySkillMcpReadiness {
  ready: boolean;
  blockers: string[];
  requirements?: {
    mcpServers: SkillMcpServerRequirement[];
  };
}

const AUTH_HEADER_KEYS = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
  "token",
];

function hasConfiguredAuthHeaders(headers: Record<string, string> | undefined): boolean {
  if (!headers) {
    return false;
  }

  return Object.entries(headers).some(([key, value]) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return false;
    }
    const normalizedKey = key.trim().toLowerCase();
    return AUTH_HEADER_KEYS.some((candidate) => normalizedKey === candidate);
  });
}

export function listFridayMcpServerReadiness(input: {
  servers: readonly FridayMcpServerConfig[];
  serverStates?: readonly FridayMcpServerState[];
}): FridayMcpServerReadiness[] {
  const serverStateById = new Map(
    (input.serverStates ?? []).map((state) => [state.serverId.toLowerCase(), state]),
  );

  return input.servers.map((server) => {
    const normalizedId = server.id.trim().toLowerCase();
    const state = serverStateById.get(normalizedId);
    const transport = server.transport ?? (server.url ? "http" : "stdio");
    const authenticated = transport === "stdio"
      ? true
      : hasConfiguredAuthHeaders(server.headers);

    return {
      name: server.id,
      connected: true,
      authenticated,
      transport,
      state: state?.state,
    };
  });
}

export function evaluateFridaySkillMcpReadiness(input: {
  manifest: Pick<SkillManifestV2, "requirements">;
  servers: readonly FridayMcpServerReadiness[];
}): FridaySkillMcpReadiness {
  const requirements = (input.manifest.requirements.mcpServers ?? []).map((requirement) => ({
    name: requirement.name,
    auth: requirement.auth,
  }));

  if (requirements.length === 0) {
    return {
      ready: true,
      blockers: [],
    };
  }

  const serverByName = new Map(
    input.servers.map((server) => [server.name.trim().toLowerCase(), server]),
  );
  const blockers: string[] = [];

  for (const requirement of requirements) {
    const server = serverByName.get(requirement.name.trim().toLowerCase());
    if (!server?.connected) {
      blockers.push(`Required MCP server "${requirement.name}" is not configured for this deployment.`);
      continue;
    }
    if (requirement.auth === "authenticated" && !server.authenticated) {
      blockers.push(`Required MCP server "${requirement.name}" is not authenticated.`);
    }
  }

  return {
    ready: blockers.length === 0,
    blockers,
    requirements: {
      mcpServers: requirements,
    },
  };
}
