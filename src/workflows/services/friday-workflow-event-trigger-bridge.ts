import type { JsonObject } from "../model/friday-workflow.types.js";
import type { FridayWorkflowTriggerService } from "./friday-workflow-trigger-service.js";

// ─── Types ───

export interface FridayWorkflowEventTriggerBridgeEvent {
  source: string;
  event: string;
  payload: JsonObject;
}

export interface FridayWorkflowEventTriggerBridge {
  onEvent(event: FridayWorkflowEventTriggerBridgeEvent): Promise<number>;
}

export interface CreateFridayWorkflowEventTriggerBridgeDeps {
  triggerService: FridayWorkflowTriggerService;
}

// ─── Factory ───

export function createFridayWorkflowEventTriggerBridge(
  deps: CreateFridayWorkflowEventTriggerBridgeDeps,
): FridayWorkflowEventTriggerBridge {
  return {
    async onEvent(event) {
      // Use design Section 4 handleEvent — not legacy matchEvent
      return deps.triggerService.handleEvent({
        source: event.source,
        event: event.event,
        payload: event.payload,
      });
    },
  };
}
