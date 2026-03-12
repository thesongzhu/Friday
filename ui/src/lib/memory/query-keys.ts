export const memoryKeys = {
  all: ["memory"] as const,

  list: (filters?: {
    namespace?: string;
    source?: string;
    includeExpired?: boolean;
  }) => [...memoryKeys.all, "list", filters ?? {}] as const,

  search: (query: string, filters?: {
    namespace?: string;
    source?: string;
    tagsAny?: string[];
    includeExpired?: boolean;
  }) => [...memoryKeys.all, "search", query, filters ?? {}] as const,

  item: (id: string) =>
    [...memoryKeys.all, "item", id] as const,
};
