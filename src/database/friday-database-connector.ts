import { FridayDomainError } from "#errors";

// ─── Types ───

export interface FridayDatabaseConnection {
  name: string;
  connectionString: string;
  type: "sqlite" | "postgresql" | "mysql";
  readOnly: boolean;
}

export interface FridayDatabaseQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export interface FridayDatabaseSchemaResult {
  tables: FridayDatabaseTableInfo[];
}

export interface FridayDatabaseTableInfo {
  name: string;
  columns: FridayDatabaseColumnInfo[];
  rowCount?: number;
}

export interface FridayDatabaseColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export type FridayDatabaseQueryFn = (
  connection: FridayDatabaseConnection,
  sql: string,
  params: unknown[],
  options: { maxRows: number; signal: AbortSignal },
) => Promise<FridayDatabaseQueryResult>;

export type FridayDatabaseSchemaFn = (
  connection: FridayDatabaseConnection,
  signal: AbortSignal,
) => Promise<FridayDatabaseSchemaResult>;

export type FridayDatabaseListTablesFn = (
  connection: FridayDatabaseConnection,
  signal: AbortSignal,
) => Promise<string[]>;

export interface FridayDatabaseConnectorOptions {
  /** Named database connections. */
  connections: Record<string, FridayDatabaseConnection>;
  /** Provider function for executing queries. */
  queryFn: FridayDatabaseQueryFn;
  /** Provider function for fetching schema. */
  schemaFn: FridayDatabaseSchemaFn;
  /** Provider function for listing tables. */
  listTablesFn: FridayDatabaseListTablesFn;
  /** Maximum rows returned per query (default: 500). */
  maxRows?: number;
}

export interface FridayDatabaseConnector {
  listConnections(): string[];
  query(connectionName: string, sql: string, params: unknown[], signal: AbortSignal): Promise<FridayDatabaseQueryResult>;
  schema(connectionName: string, signal: AbortSignal): Promise<FridayDatabaseSchemaResult>;
  listTables(connectionName: string, signal: AbortSignal): Promise<string[]>;
}

// ─── Safety ───

const FORBIDDEN_KEYWORDS = new Set([
  "DROP", "DELETE", "TRUNCATE", "ALTER", "CREATE", "INSERT", "UPDATE",
  "GRANT", "REVOKE", "EXEC", "EXECUTE",
]);

export function validateReadOnlyQuery(sql: string): void {
  const upper = sql.toUpperCase().trim();
  for (const keyword of FORBIDDEN_KEYWORDS) {
    // Check if the keyword appears as a standalone word at the start or after whitespace
    const regex = new RegExp(`(^|\\s)${keyword}(\\s|$)`);
    if (regex.test(upper)) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `Query contains forbidden keyword "${keyword}". Only SELECT queries are allowed in read-only mode.`,
        { httpStatus: 400 },
      );
    }
  }
}

// ─── Connection string parser ───

export function detectDatabaseType(connectionString: string): "sqlite" | "postgresql" | "mysql" {
  if (connectionString.startsWith("postgresql://") || connectionString.startsWith("postgres://")) {
    return "postgresql";
  }
  if (connectionString.startsWith("mysql://")) {
    return "mysql";
  }
  // Default to SQLite for file paths
  return "sqlite";
}

export function parseDatabaseConnections(
  connectionsJson: string,
): Record<string, FridayDatabaseConnection> {
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(connectionsJson);
  } catch {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Invalid FRIDAY_DB_CONNECTIONS JSON format. Expected: { \"name\": \"connection_string\" }",
      { httpStatus: 400 },
    );
  }

  const result: Record<string, FridayDatabaseConnection> = {};
  for (const [name, connectionString] of Object.entries(parsed)) {
    result[name] = {
      name,
      connectionString,
      type: detectDatabaseType(connectionString),
      readOnly: true,
    };
  }
  return result;
}

// ─── Factory ───

export function createFridayDatabaseConnector(
  options: FridayDatabaseConnectorOptions,
): FridayDatabaseConnector {
  const {
    connections,
    queryFn,
    schemaFn,
    listTablesFn,
    maxRows = 500,
  } = options;

  function getConnection(name: string): FridayDatabaseConnection {
    const conn = connections[name];
    if (!conn) {
      const available = Object.keys(connections).join(", ");
      throw new FridayDomainError(
        "RESOURCE_NOT_FOUND",
        `Database connection "${name}" not found. Available: ${available || "none"}`,
        { httpStatus: 404 },
      );
    }
    return conn;
  }

  return {
    listConnections(): string[] {
      return Object.keys(connections);
    },

    async query(
      connectionName: string,
      sql: string,
      params: unknown[],
      signal: AbortSignal,
    ): Promise<FridayDatabaseQueryResult> {
      const conn = getConnection(connectionName);
      if (conn.readOnly) {
        validateReadOnlyQuery(sql);
      }
      return queryFn(conn, sql, params, { maxRows, signal });
    },

    async schema(
      connectionName: string,
      signal: AbortSignal,
    ): Promise<FridayDatabaseSchemaResult> {
      const conn = getConnection(connectionName);
      return schemaFn(conn, signal);
    },

    async listTables(
      connectionName: string,
      signal: AbortSignal,
    ): Promise<string[]> {
      const conn = getConnection(connectionName);
      return listTablesFn(conn, signal);
    },
  };
}
