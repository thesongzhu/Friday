import { apiClient } from "./client";

// ─── Types ───

export type FridayAssetInventoryCategory = "runtime" | "knowledge" | "automation";

export interface FridayAssetInventoryItem {
  category: FridayAssetInventoryCategory;
  kind: string;
  id: string;
  displayName: string;
  status: string;
  details: Record<string, unknown>;
  controls: {
    canDelete?: boolean;
    canDisable?: boolean;
    viewUrl?: string;
  };
}

// ─── Response wrappers ───

interface ListInventoryResponse {
  items: FridayAssetInventoryItem[];
  categories: FridayAssetInventoryCategory[];
}

// ─── API ───

export const assetsApi = {
  async listInventory(): Promise<ListInventoryResponse> {
    return apiClient.get<ListInventoryResponse>("/v1/assets/inventory");
  },
};
