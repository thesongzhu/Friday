import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readStringParam,
} from "./friday-agent-tool-helpers.js";
import type { FridayDatabaseConnector } from "../../database/friday-database-connector.js";

// ─── Types ───

export interface CreateFridayAgentDatabaseToolOptions {
  databaseConnector: FridayDatabaseConnector;
}

// ─── Factory ───

export function createFridayAgentDatabaseTool(
  options: CreateFridayAgentDatabaseToolOptions,
): FridayAgentToolDefinition {
  const { databaseConnector } = options;

  return {
    name: "database_query",
    description:
      "Query databases (SQLite, PostgreSQL, MySQL). " +
      "Operations: 'query' runs a read-only SQL query, 'schema' shows table structure, " +
      "'list_tables' lists all tables, 'list_connections' shows available databases. " +
      "Only SELECT queries are allowed by default for safety.",
    parameters: {
      properties: {
        operation: {
          type: "string",
          enum: ["query", "schema", "list_tables", "list_connections"],
          description: "The database operation to perform.",
        },
        connection: {
          type: "string",
          description: "Name of the database connection to use.",
        },
        sql: {
          type: "string",
          description: "SQL query to execute (only for 'query' operation). Must be a SELECT statement.",
        },
      },
      required: ["operation"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const operation = readStringParam(args, "operation", { required: true });
      const connection = readStringParam(args, "connection");
      const sql = readStringParam(args, "sql");

      try {
        switch (operation) {
          case "list_connections": {
            const connections = databaseConnector.listConnections();
            return jsonResult({ connections });
          }

          case "list_tables": {
            if (!connection) {
              return errorResult("'connection' parameter is required for list_tables.");
            }
            const tables = await databaseConnector.listTables(connection, signal);
            return jsonResult({ connection, tables });
          }

          case "schema": {
            if (!connection) {
              return errorResult("'connection' parameter is required for schema.");
            }
            const schema = await databaseConnector.schema(connection, signal);
            return jsonResult({ connection, schema });
          }

          case "query": {
            if (!connection) {
              return errorResult("'connection' parameter is required for query.");
            }
            if (!sql) {
              return errorResult("'sql' parameter is required for query operation.");
            }
            const result = await databaseConnector.query(connection, sql, [], signal);
            return jsonResult({
              connection,
              columns: result.columns,
              rows: result.rows,
              rowCount: result.rowCount,
              truncated: result.truncated,
            });
          }

          default:
            return errorResult(
              `Unknown operation "${operation}". Valid: query, schema, list_tables, list_connections.`,
            );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Database operation aborted.");
        }
        return errorResult(`Database error: ${message}`);
      }
    },
  };
}
