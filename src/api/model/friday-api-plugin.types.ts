/**
 * Plugin API request/response types.
 */

import type {
  FridayPluginEntity,
} from "#plugins";

// ─── List Plugins ───

export interface FridayListPluginsResponse {
  items: FridayPluginEntity[];
}

// ─── Get Plugin ───

export interface FridayGetPluginResponse {
  plugin: FridayPluginEntity;
}

// ─── Install Plugin ───

export interface FridayInstallPluginRequest {
  installPath: string;
  userApproved?: boolean;
}

export interface FridayInstallPluginResponse {
  plugin: FridayPluginEntity;
}

// ─── Enable Plugin ───

export interface FridayEnablePluginResponse {
  plugin: FridayPluginEntity;
}

// ─── Disable Plugin ───

export interface FridayDisablePluginResponse {
  plugin: FridayPluginEntity;
}

// ─── Uninstall Plugin ───

export interface FridayUninstallPluginResponse {
  uninstalled: true;
}

// ─── Plugin Versions ───

export interface FridayPluginVersionsResponse {
  versions: Array<{
    version: string;
    installedAt: string;
    status: string;
  }>;
}
