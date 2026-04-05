import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
  truncateOutput,
} from "./friday-agent-tool-helpers.js";
import type { FridayDockerService } from "../../containers/friday-docker-service.js";

// ─── Constants ───

const MAX_LOG_BYTES = 50_000;

// ─── Types ───

export interface CreateFridayAgentDockerToolOptions {
  dockerService: FridayDockerService;
}

// ─── Factory ───

export function createFridayAgentDockerTool(
  options: CreateFridayAgentDockerToolOptions,
): FridayAgentToolDefinition {
  const { dockerService } = options;

  return {
    name: "docker",
    description:
      "Manage Docker containers and images. Operations: " +
      "'list' lists containers, 'start'/'stop' start/stop a container, " +
      "'logs' retrieves container logs, 'exec' runs a command in a container, " +
      "'build' builds a Docker image, 'compose_up'/'compose_down' manages Docker Compose.",
    parameters: {
      properties: {
        operation: {
          type: "string",
          enum: ["list", "start", "stop", "logs", "exec", "build", "compose_up", "compose_down"],
          description: "The Docker operation to perform.",
        },
        containerId: {
          type: "string",
          description: "Container ID or name (for start/stop/logs/exec).",
        },
        command: {
          type: "array",
          items: { type: "string" },
          description: "Command to execute in container (for exec), e.g. ['ls', '-la'].",
        },
        contextPath: {
          type: "string",
          description: "Build context directory path (for build).",
        },
        composePath: {
          type: "string",
          description: "Path to docker-compose.yml (for compose_up/compose_down).",
        },
        tag: {
          type: "string",
          description: "Image tag (for build).",
        },
        dockerfile: {
          type: "string",
          description: "Dockerfile path relative to context (for build).",
        },
        tail: {
          type: "number",
          description: "Number of log lines to retrieve (for logs, default: 100).",
        },
        all: {
          type: "boolean",
          description: "Include stopped containers (for list, default: false).",
        },
      },
      required: ["operation"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const operation = readStringParam(args, "operation", { required: true });

      try {
        switch (operation) {
          case "list": {
            const all = readBooleanParam(args, "all") ?? false;
            const containers = await dockerService.listContainers({ all }, signal);
            return jsonResult({ count: containers.length, containers });
          }

          case "start": {
            const containerId = readStringParam(args, "containerId", { required: true });
            await dockerService.startContainer(containerId, signal);
            return jsonResult({ started: true, containerId });
          }

          case "stop": {
            const containerId = readStringParam(args, "containerId", { required: true });
            await dockerService.stopContainer(containerId, signal);
            return jsonResult({ stopped: true, containerId });
          }

          case "logs": {
            const containerId = readStringParam(args, "containerId", { required: true });
            const tail = readNumberParam(args, "tail", { integer: true }) ?? 100;
            const logs = await dockerService.getContainerLogs(containerId, { tail }, signal);
            return jsonResult({
              containerId: logs.containerId,
              stdout: truncateOutput(logs.stdout, MAX_LOG_BYTES),
              stderr: truncateOutput(logs.stderr, MAX_LOG_BYTES),
            });
          }

          case "exec": {
            const containerId = readStringParam(args, "containerId", { required: true });
            const command = readStringArrayParam(args, "command", { required: true });
            const result = await dockerService.execInContainer(containerId, command, signal);
            return jsonResult({
              exitCode: result.exitCode,
              stdout: truncateOutput(result.stdout, MAX_LOG_BYTES),
              stderr: truncateOutput(result.stderr, MAX_LOG_BYTES),
            });
          }

          case "build": {
            const contextPath = readStringParam(args, "contextPath", { required: true });
            const tag = readStringParam(args, "tag");
            const dockerfile = readStringParam(args, "dockerfile");
            const result = await dockerService.buildImage(contextPath, { tag, dockerfile }, signal);
            return jsonResult({ imageId: result.imageId, tags: result.tags });
          }

          case "compose_up": {
            const composePath = readStringParam(args, "composePath", { required: true });
            const result = await dockerService.composeUp(composePath, { detach: true }, signal);
            return jsonResult({ services: result.services, status: result.status });
          }

          case "compose_down": {
            const composePath = readStringParam(args, "composePath", { required: true });
            await dockerService.composeDown(composePath, signal);
            return jsonResult({ composePath, status: "down" });
          }

          default:
            return errorResult(
              `Unknown operation "${operation}". Valid: list, start, stop, logs, exec, build, compose_up, compose_down.`,
            );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Docker operation aborted.");
        }
        return errorResult(`Docker error: ${message}`);
      }
    },
  };
}
