import { createFridayOperatorClient } from "@friday-operator-client";
import { apiClient } from "./client";

const fridayOperatorClient = createFridayOperatorClient({
  transport: apiClient,
  createIdempotencyKey() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  },
});

export const systemApi = Object.assign(fridayOperatorClient, {
  getCurrentState: () => fridayOperatorClient.getState(),
});
