import {
  normalizeGatewayOptions,
  validateGatewayUrl,
} from "../../agent/tools/friday-agent-gateway-validation.js";
import type { GatewayValidationOptions } from "../../agent/tools/friday-agent-gateway-validation.js";

// ─── Types ───

export interface FridayGatewayStatus {
  healthy: boolean;
  version?: string;
  uptime?: number;
  pid?: number;
  url?: string;
}

export interface FridayGatewayConfigEntry {
  key: string;
  value: unknown;
}

export interface FridayGatewayServiceOptions {
  /** Function to query gateway health. */
  statusFn: (signal: AbortSignal) => Promise<FridayGatewayStatus>;
  /** Function to restart the gateway process. */
  restartFn: (signal: AbortSignal) => Promise<{ success: boolean; message: string }>;
  /** Function to get a config value. */
  configGetFn: (key: string, signal: AbortSignal) => Promise<FridayGatewayConfigEntry | null>;
  /** Function to set a config value. */
  configSetFn: (key: string, value: unknown, signal: AbortSignal) => Promise<{ success: boolean; key: string; value: unknown }>;
  /** Function to trigger a gateway update. */
  updateFn: (signal: AbortSignal) => Promise<{ success: boolean; message: string; version?: string }>;
  /** Gateway URL validation options. */
  validationOptions?: GatewayValidationOptions;
}

export interface FridayGatewayService {
  status(signal: AbortSignal): Promise<FridayGatewayStatus>;
  restart(signal: AbortSignal): Promise<{ success: boolean; message: string }>;
  configGet(key: string, signal: AbortSignal): Promise<FridayGatewayConfigEntry | null>;
  configSet(key: string, value: unknown, signal: AbortSignal): Promise<{ success: boolean; key: string; value: unknown }>;
  update(signal: AbortSignal): Promise<{ success: boolean; message: string; version?: string }>;
  validateUrl(url: string): { valid: boolean; error?: string };
}

// ─── Factory ───

export function createFridayGatewayService(
  options: FridayGatewayServiceOptions,
): FridayGatewayService {
  const { statusFn, restartFn, configGetFn, configSetFn, updateFn } = options;
  const validationOpts = normalizeGatewayOptions(options.validationOptions);

  return {
    async status(signal: AbortSignal): Promise<FridayGatewayStatus> {
      return statusFn(signal);
    },

    async restart(signal: AbortSignal): Promise<{ success: boolean; message: string }> {
      return restartFn(signal);
    },

    async configGet(key: string, signal: AbortSignal): Promise<FridayGatewayConfigEntry | null> {
      return configGetFn(key, signal);
    },

    async configSet(
      key: string,
      value: unknown,
      signal: AbortSignal,
    ): Promise<{ success: boolean; key: string; value: unknown }> {
      return configSetFn(key, value, signal);
    },

    async update(
      signal: AbortSignal,
    ): Promise<{ success: boolean; message: string; version?: string }> {
      return updateFn(signal);
    },

    validateUrl(url: string): { valid: boolean; error?: string } {
      const result = validateGatewayUrl(url, validationOpts);
      return { valid: result.valid, error: result.error };
    },
  };
}
