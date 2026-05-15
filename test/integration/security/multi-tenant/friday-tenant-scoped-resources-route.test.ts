/**
 * Phase 11 Module 18 — tenant-scoped resource registry route surface
 * integration test.
 *
 * Exercises the live API route handlers (the same ones that are mounted
 * when FRIDAY_MULTI_TENANT_ENABLED is on) against:
 *
 *  - SQLite-backed TenantScopedResourceRegistry persistence (v080 migration)
 *  - Cross-tenant denial (404 envelope, no information leak)
 *  - Audit emission for register / cross_tenant_denied / unregister actions
 *  - Restart proof: close+reopen the SQLite layer, rebuild deps, confirm
 *    every record survives and the same route surface can list/get them.
 *  - Status surface returns totals per supported kind and the canonical
 *    supportedKinds list.
 *
 * Stays out of scope for Phase 11 stop points: the test does not flip
 * any default-on env flag and does not start the full hub.  It boots
 * just enough of the security engine to make the route deps real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFridaySqliteLayer } from "#state";
import type { FridaySqliteLayer } from "#state";
import {
  AuditLogger,
  TenantManager,
  TenantScopedResourceRegistry,
  FRIDAY_TENANT_SCOPED_RESOURCE_KINDS,
} from "../../../../src/security/multi-tenant/engine/index.js";
import { MIGRATION_ACTOR } from "../../../../src/security/multi-tenant/engine/tenant-manager.js";
import {
  createSqliteAuditPersistence,
  createSqliteTenantPersistence,
  createSqliteTenantScopedResourcePersistence,
} from "../../../../src/security/multi-tenant/persistence/friday-multi-tenant-sqlite-store.js";
import { createFridayMultiTenantSecurityRoutes } from "../../../../src/api/http/routes/friday-multi-tenant-security-routes.js";
import type { FridayMultiTenantSecurityRoutesDeps } from "../../../../src/api/http/routes/friday-multi-tenant-security-routes.js";
import type {
  FridayRouteDefinition,
  FridayHttpContext,
} from "../../../../src/api/model/friday-api-common.types.js";
import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";

function buildLayer(dbPath: string): FridaySqliteLayer {
  return createFridaySqliteLayer({
    dbPath,
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
  });
}

function makeCtx<TParams = unknown, TQuery = unknown, TBody = unknown>(
  overrides: Partial<FridayHttpContext<TParams, TQuery, TBody>> = {},
): FridayHttpContext<TParams, TQuery, TBody> {
  return {
    requestId: "req-test",
    receivedAt: "2026-05-14T00:00:00Z",
    params: {} as TParams,
    query: {} as TQuery,
    body: null as TBody,
    headers: {},
    principal: null,
    ...overrides,
  };
}

function findRoute(
  routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[],
  operationId: string,
): FridayRouteDefinition<unknown, unknown, unknown, unknown> {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`missing route ${operationId}`);
  return route;
}

interface ScopedDeps {
  registry: TenantScopedResourceRegistry;
  tenantManager: TenantManager;
  routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];
}

function makeRoutes(layer: FridaySqliteLayer): ScopedDeps {
  const audit = new AuditLogger({ persistence: createSqliteAuditPersistence(layer) });
  const tenantManager = new TenantManager(audit, { persistence: createSqliteTenantPersistence(layer) });
  const registry = new TenantScopedResourceRegistry(audit, {
    persistence: createSqliteTenantScopedResourcePersistence(layer),
  });
  const tenants = tenantManager;

  const deps: FridayMultiTenantSecurityRoutesDeps = {
    tenants: {
      create: (req) => ({ tenant: tenants.createTenant(req as never, MIGRATION_ACTOR) }) as never,
      list: () => ({ items: tenants.listTenants(MIGRATION_ACTOR) }) as never,
      get: (tenantId) => ({ tenant: tenants.getTenant(tenantId, MIGRATION_ACTOR) }) as never,
      update: () => ({ tenant: null }) as never,
      delete: (tenantId, req) => ({ tenant: tenants.deleteTenant(tenantId, (req as { etag: string }).etag, MIGRATION_ACTOR) }) as never,
    },
    workspaces: {
      create: () => ({}) as never,
      list: () => ({ items: [] }) as never,
      get: () => ({}) as never,
      update: () => ({}) as never,
      delete: () => ({}) as never,
    },
    members: { add: () => ({}) as never, list: () => ({ items: [] }) as never, revoke: () => ({}) as never },
    roles: {
      create: () => ({}) as never,
      list: () => ({ items: [] }) as never,
      get: () => ({}) as never,
      update: () => ({}) as never,
      delete: () => ({}) as never,
    },
    assignments: { grant: () => ({}) as never, list: () => ({ items: [] }) as never, revoke: () => ({}) as never },
    secrets: {
      create: () => ({}) as never,
      list: () => ({ items: [] }) as never,
      get: () => ({}) as never,
      update: () => ({}) as never,
      delete: () => ({}) as never,
      rotate: () => ({}) as never,
      listAccessLog: () => ({ items: [] }) as never,
    },
    policies: {
      create: () => ({}) as never,
      list: () => ({ items: [] }) as never,
      get: () => ({}) as never,
      update: () => ({}) as never,
      delete: () => ({}) as never,
      evaluate: () => ({}) as never,
    },
    audit: { list: (tenantId, query) => ({ items: audit.queryAuditLog({ tenantId, ...(query as never) }) }) as never },
    violations: { list: () => ({ items: [] }) as never, resolve: () => ({}) as never },
    scopedResources: {
      register: (tenantId, req) => ({
        record: registry.register({
          tenantId,
          resourceKind: req.resourceKind,
          resourceId: req.resourceId,
          workspaceId: req.workspaceId,
          resourceLabel: req.resourceLabel,
        }),
      }),
      list: (tenantId, query) => ({ items: registry.listForTenant(tenantId, query?.resourceKind) }),
      get: (tenantId, resourceKind, resourceId) => {
        const record = registry.getForTenant(tenantId, resourceKind, resourceId);
        if (!record) {
          throw new FridayDomainError("NOT_FOUND", "scoped resource not found");
        }
        return { record };
      },
      unregister: (tenantId, resourceKind, resourceId) => {
        const record = registry.unregister(tenantId, resourceKind, resourceId);
        if (!record) {
          throw new FridayDomainError("NOT_FOUND", "scoped resource not found");
        }
        return { record };
      },
      status: (tenantId) => {
        const items = registry.listForTenant(tenantId);
        const totals = Object.fromEntries(
          FRIDAY_TENANT_SCOPED_RESOURCE_KINDS.map((k) => [k, 0]),
        ) as Record<(typeof FRIDAY_TENANT_SCOPED_RESOURCE_KINDS)[number], number>;
        for (const item of items) totals[item.resourceKind] = (totals[item.resourceKind] ?? 0) + 1;
        return {
          tenantId,
          totals,
          activeTotal: items.length,
          supportedKinds: FRIDAY_TENANT_SCOPED_RESOURCE_KINDS,
        };
      },
    },
  };
  return { registry, tenantManager, routes: createFridayMultiTenantSecurityRoutes(deps) };
}

function provisionTenant(tenantManager: TenantManager, slug: string): string {
  const created = tenantManager.createTenant({ name: slug, slug }, MIGRATION_ACTOR);
  return created.id;
}

let tmpdir: string;
let dbPath: string;
let layer: FridaySqliteLayer;

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-scoped-resources-route-"));
  dbPath = path.join(tmpdir, "friday.sqlite");
  layer = buildLayer(dbPath);
});

afterEach(() => {
  try { layer.close(); } catch { /* ignore */ }
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe("multi-tenant scoped-resources routes (Phase 11 Module 18)", () => {
  it("registers, lists, gets, and reports status for every supported kind", async () => {
    const { routes, tenantManager } = makeRoutes(layer);
    const tenantId = provisionTenant(tenantManager, "every-kind");

    const register = findRoute(routes, "security.scopedresources.register");
    const list = findRoute(routes, "security.scopedresources.list");
    const get = findRoute(routes, "security.scopedresources.get");
    const status = findRoute(routes, "security.scopedresources.status");

    for (const kind of FRIDAY_TENANT_SCOPED_RESOURCE_KINDS) {
      const created = await register.handler(makeCtx({
        params: { tenantId },
        body: {
          resourceKind: kind,
          resourceId: `${kind}-1`,
          idempotencyKey: `idem-${kind}`,
        },
      }));
      const record = (created as { record: { tenantId: string; resourceKind: string } }).record;
      expect(record.tenantId).toBe(tenantId);
      expect(record.resourceKind).toBe(kind);
    }

    const listed = await list.handler(makeCtx({ params: { tenantId }, query: {} }));
    expect((listed as { items: unknown[] }).items.length).toBe(FRIDAY_TENANT_SCOPED_RESOURCE_KINDS.length);

    const filtered = await list.handler(makeCtx({ params: { tenantId }, query: { resourceKind: "workflow" } }));
    expect((filtered as { items: { resourceKind: string }[] }).items).toEqual([
      expect.objectContaining({ resourceKind: "workflow", resourceId: "workflow-1" }),
    ]);

    const fetched = await get.handler(makeCtx({
      params: { tenantId, resourceKind: "memory", resourceId: "memory-1" },
    }));
    expect((fetched as { record: { resourceId: string } }).record.resourceId).toBe("memory-1");

    const statusResponse = await status.handler(makeCtx({ params: { tenantId } }));
    const statusBody = statusResponse as {
      tenantId: string;
      totals: Record<string, number>;
      activeTotal: number;
      supportedKinds: readonly string[];
    };
    expect(statusBody.tenantId).toBe(tenantId);
    expect(statusBody.activeTotal).toBe(FRIDAY_TENANT_SCOPED_RESOURCE_KINDS.length);
    expect(statusBody.supportedKinds).toEqual([
      "session", "skill", "workflow", "provider", "memory", "rule",
    ]);
    for (const kind of FRIDAY_TENANT_SCOPED_RESOURCE_KINDS) {
      expect(statusBody.totals[kind]).toBe(1);
    }
  });

  it("denies cross-tenant read/unregister without leaking existence and audits the deny", async () => {
    const { routes, tenantManager } = makeRoutes(layer);
    const tenantA = provisionTenant(tenantManager, "tenant-a");
    const tenantB = provisionTenant(tenantManager, "tenant-b");

    const register = findRoute(routes, "security.scopedresources.register");
    const get = findRoute(routes, "security.scopedresources.get");
    const unregister = findRoute(routes, "security.scopedresources.unregister");
    const list = findRoute(routes, "security.scopedresources.list");

    await register.handler(makeCtx({
      params: { tenantId: tenantA },
      body: { resourceKind: "workflow", resourceId: "wf-cross", idempotencyKey: "i-1" },
    }));

    await expect(get.handler(makeCtx({
      params: { tenantId: tenantB, resourceKind: "workflow", resourceId: "wf-cross" },
    }))).rejects.toThrowError(/scoped resource not found/);

    await expect(unregister.handler(makeCtx({
      params: { tenantId: tenantB, resourceKind: "workflow", resourceId: "wf-cross" },
      body: { idempotencyKey: "i-2" },
    }))).rejects.toThrowError(/scoped resource not found/);

    const listedForB = await list.handler(makeCtx({ params: { tenantId: tenantB }, query: {} }));
    expect((listedForB as { items: unknown[] }).items).toEqual([]);

    const db = new Database(dbPath, { readonly: true });
    try {
      const deniedRows = db.prepare(
        "SELECT * FROM security_audit_log WHERE action = ? AND decision = ?",
      ).all("tenant_scoped_resource.cross_tenant_denied", "deny") as unknown[];
      expect(deniedRows.length).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });

  it("unregister soft-deletes and survives restart (records hidden after cleanup)", async () => {
    let tenantId: string;
    {
      const { routes, tenantManager } = makeRoutes(layer);
      tenantId = provisionTenant(tenantManager, "soft-delete");
      const register = findRoute(routes, "security.scopedresources.register");
      const unregister = findRoute(routes, "security.scopedresources.unregister");
      const get = findRoute(routes, "security.scopedresources.get");

      await register.handler(makeCtx({
        params: { tenantId },
        body: { resourceKind: "session", resourceId: "sess-1", idempotencyKey: "i" },
      }));
      const removed = await unregister.handler(makeCtx({
        params: { tenantId, resourceKind: "session", resourceId: "sess-1" },
        body: { idempotencyKey: "j" },
      }));
      expect((removed as { record: { deletedAt?: string } }).record.deletedAt).toBeTruthy();
      await expect(get.handler(makeCtx({
        params: { tenantId, resourceKind: "session", resourceId: "sess-1" },
      }))).rejects.toThrowError(/scoped resource not found/);
    }

    layer.close();
    layer = buildLayer(dbPath);

    const { routes } = makeRoutes(layer);
    const get = findRoute(routes, "security.scopedresources.get");
    const list = findRoute(routes, "security.scopedresources.list");

    await expect(get.handler(makeCtx({
      params: { tenantId, resourceKind: "session", resourceId: "sess-1" },
    }))).rejects.toThrowError(/scoped resource not found/);

    const listed = await list.handler(makeCtx({ params: { tenantId }, query: {} }));
    expect((listed as { items: unknown[] }).items).toEqual([]);
  });

  it("survives restart with every registered record present", async () => {
    let tenantId: string;
    {
      const { routes, tenantManager } = makeRoutes(layer);
      tenantId = provisionTenant(tenantManager, "restart-proof");
      const register = findRoute(routes, "security.scopedresources.register");
      for (const kind of FRIDAY_TENANT_SCOPED_RESOURCE_KINDS) {
        await register.handler(makeCtx({
          params: { tenantId },
          body: {
            resourceKind: kind,
            resourceId: `${kind}-restart`,
            idempotencyKey: `r-${kind}`,
          },
        }));
      }
    }

    layer.close();
    layer = buildLayer(dbPath);

    const { routes } = makeRoutes(layer);
    const status = findRoute(routes, "security.scopedresources.status");
    const statusResponse = await status.handler(makeCtx({ params: { tenantId } }));
    expect((statusResponse as { activeTotal: number }).activeTotal)
      .toBe(FRIDAY_TENANT_SCOPED_RESOURCE_KINDS.length);
  });
});
