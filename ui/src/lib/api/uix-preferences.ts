import { apiClient } from "./client";

export interface UixPreferenceRecord {
  id: string;
  category: string;
  key: string;
  value: unknown;
  createdAt?: string;
  updatedAt?: string;
}

interface ListUixPreferencesResponse {
  items: UixPreferenceRecord[];
}

interface UpdateUixPreferencesResponse {
  preferences: UixPreferenceRecord[];
  created: number;
  updated: number;
}

export interface UixPreferenceUpsert {
  category: "uix";
  key: string;
  value: unknown;
}

export const uixPreferencesApi = {
  async list(): Promise<UixPreferenceRecord[]> {
    const data = await apiClient.get<ListUixPreferencesResponse>("/v1/uix/preferences?category=uix");
    return data.items;
  },

  async update(preferences: UixPreferenceUpsert[]): Promise<UixPreferenceRecord[]> {
    const data = await apiClient.put<{ preferences: UixPreferenceUpsert[] }, UpdateUixPreferencesResponse>(
      "/v1/uix/preferences",
      { preferences },
    );
    return data.preferences;
  },
};
