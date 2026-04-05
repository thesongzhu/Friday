import { FridayDomainError } from "#errors";

// ─── Types ───

export interface FridayDockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: "running" | "exited" | "paused" | "restarting" | "created" | "dead";
  ports: string[];
  created: string;
}

export interface FridayDockerContainerLogs {
  containerId: string;
  stdout: string;
  stderr: string;
}

export interface FridayDockerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FridayDockerBuildResult {
  imageId: string;
  tags: string[];
}

export interface FridayDockerComposeResult {
  services: string[];
  status: string;
}

// ─── Service interface ───

export interface FridayDockerService {
  listContainers(options: { all?: boolean }, signal: AbortSignal): Promise<FridayDockerContainer[]>;
  startContainer(containerId: string, signal: AbortSignal): Promise<void>;
  stopContainer(containerId: string, signal: AbortSignal): Promise<void>;
  getContainerLogs(containerId: string, options: { tail?: number }, signal: AbortSignal): Promise<FridayDockerContainerLogs>;
  execInContainer(containerId: string, command: string[], signal: AbortSignal): Promise<FridayDockerExecResult>;
  buildImage(contextPath: string, options: { tag?: string; dockerfile?: string }, signal: AbortSignal): Promise<FridayDockerBuildResult>;
  composeUp(composePath: string, options: { detach?: boolean }, signal: AbortSignal): Promise<FridayDockerComposeResult>;
  composeDown(composePath: string, signal: AbortSignal): Promise<void>;
}

// ─── Provider functions for DI ───

export type FridayDockerListFn = (
  options: { all?: boolean },
  signal: AbortSignal,
) => Promise<FridayDockerContainer[]>;

export type FridayDockerStartFn = (containerId: string, signal: AbortSignal) => Promise<void>;
export type FridayDockerStopFn = (containerId: string, signal: AbortSignal) => Promise<void>;

export type FridayDockerLogsFn = (
  containerId: string,
  options: { tail?: number },
  signal: AbortSignal,
) => Promise<FridayDockerContainerLogs>;

export type FridayDockerExecFn = (
  containerId: string,
  command: string[],
  signal: AbortSignal,
) => Promise<FridayDockerExecResult>;

export type FridayDockerBuildFn = (
  contextPath: string,
  options: { tag?: string; dockerfile?: string },
  signal: AbortSignal,
) => Promise<FridayDockerBuildResult>;

export type FridayDockerComposeUpFn = (
  composePath: string,
  options: { detach?: boolean },
  signal: AbortSignal,
) => Promise<FridayDockerComposeResult>;

export type FridayDockerComposeDownFn = (
  composePath: string,
  signal: AbortSignal,
) => Promise<void>;

export interface FridayDockerServiceOptions {
  listFn: FridayDockerListFn;
  startFn: FridayDockerStartFn;
  stopFn: FridayDockerStopFn;
  logsFn: FridayDockerLogsFn;
  execFn: FridayDockerExecFn;
  buildFn: FridayDockerBuildFn;
  composeUpFn: FridayDockerComposeUpFn;
  composeDownFn: FridayDockerComposeDownFn;
}

// ─── Factory ───

export function createFridayDockerService(
  options: FridayDockerServiceOptions,
): FridayDockerService {
  return {
    listContainers: (opts, signal) => options.listFn(opts, signal),
    startContainer: (id, signal) => options.startFn(id, signal),
    stopContainer: (id, signal) => options.stopFn(id, signal),
    getContainerLogs: (id, opts, signal) => options.logsFn(id, opts, signal),
    execInContainer: (id, cmd, signal) => options.execFn(id, cmd, signal),
    buildImage: (ctx, opts, signal) => options.buildFn(ctx, opts, signal),
    composeUp: (path, opts, signal) => options.composeUpFn(path, opts, signal),
    composeDown: (path, signal) => options.composeDownFn(path, signal),
  };
}
