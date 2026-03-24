// ─── Friday Daemon Mode — Background Service ───

export type {
  FridayDaemonRuntimePaths,
  FridayDaemonPidRecord,
  FridayDaemonStatus,
  FridayDaemonConfig,
  FridayDaemonResult,
} from "./friday-daemon.types.js";

export { resolveFridayDaemonPaths } from "./friday-daemon-paths.js";
export {
  createFridayLocalDaemonService,
  formatFridayDaemonStatus,
  resolveFridayDaemonLaunchSpec,
  resolveFridayRepoRootFromModuleUrl,
} from "./friday-daemon-runtime.js";
export type {
  CreateFridayLocalDaemonServiceInput,
  FridayDaemonLaunchSpec,
  ResolveFridayDaemonLaunchSpecInput,
} from "./friday-daemon-runtime.js";

export {
  DAEMON_PID_ERROR_CODES,
  readPidRecord,
  writePidRecord,
  removePidFile,
  validatePidFile,
} from "./friday-daemon-pidfile.js";
export type { FridayDaemonPidFileDeps } from "./friday-daemon-pidfile.js";

export {
  DAEMON_SERVICE_ERROR_CODES,
  createFridayDaemonService,
} from "./friday-daemon-service.js";
export type {
  FridayDaemonProcessControl,
  FridayDaemonServiceDeps,
  FridayDaemonService,
} from "./friday-daemon-service.js";
