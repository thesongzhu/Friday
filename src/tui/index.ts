/**
 * TUI — Terminal User Interface for Friday operations.
 *
 * @module tui
 */

export {
  type FridayTuiView,
  type FridayTuiState,
  type FridayTuiHubStatus,
  type FridayTuiSessionSummary,
  type FridayTuiJobSummary,
  type FridayTuiPairingSummary,
  type FridayTuiEvent,
  type FridayTuiCommand,
  type FridayTuiConfig,
  DEFAULT_TUI_CONFIG,
  createInitialTuiState,
} from "./friday-tui.types.js";

export {
  type FridayTuiApiClientDeps,
  type FridayTuiApiResult,
  type FridayTuiApiClient,
  createFridayTuiApiClient,
} from "./friday-tui-api-client.js";

export {
  type FridayTuiRenderer,
  createFridayTuiRenderer,
} from "./friday-tui-renderer.js";

export {
  type FridayTuiControllerDeps,
  type FridayTuiController,
  parseTuiInput,
  createFridayTuiController,
} from "./friday-tui-controller.js";
