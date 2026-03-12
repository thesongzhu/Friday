/**
 * Plugin API request/response types.
 */

import type {
  FridayPluginEntity,
  FridayPluginKind,
  FridayPluginSource,
  FridayPluginStatus,
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

// ─── Marketplace Search ───

export interface FridayMarketplaceSearchResponse {
  items: Array<{
    id: string;
    name: string;
    description: string;
    version: string;
    author: string;
    downloads: number;
    updatedAt: string;
  }>;
  total: number;
}

// ─── Marketplace Plugin Detail ───

export interface FridayMarketplacePluginDetailResponse {
  plugin: {
    id: string;
    name: string;
    description: string;
    version: string;
    author: string;
    downloads: number;
    updatedAt: string;
  };
}

// ─── Plugin Versions ───

export interface FridayPluginVersionsResponse {
  versions: Array<{
    version: string;
    installedAt: string;
    status: string;
  }>;
}

// ─── Marketplace Plugin Versions ───

export interface FridayMarketplacePluginVersionsResponse {
  versions: Array<{
    version: string;
    releasedAt: string;
    checksum: string;
  }>;
}

// ─── Marketplace Install ───

export interface FridayMarketplaceInstallResponse {
  plugin: FridayPluginEntity;
}
