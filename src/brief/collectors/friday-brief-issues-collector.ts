import {
  buildSkippedCollectionResult,
  type FridayBriefCollector,
  type FridayBriefCollectorContext,
  runCollectorSafely,
} from "./friday-brief-collector.types.js";
import type { FridayBriefEvent } from "../friday-brief.types.js";

// ─── Linear ───

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  updatedAt: string;
  state?: { name?: string };
  url?: string;
}

interface LinearQueryResponse {
  data?: {
    user?: { assignedIssues?: { nodes?: LinearIssue[] } };
    issues?: { nodes?: LinearIssue[] };
  };
  errors?: Array<{ message?: string }>;
}

async function collectLinear(
  fetchImpl: typeof fetch,
  apiKey: string,
  ctx: FridayBriefCollectorContext,
): Promise<FridayBriefEvent[]> {
  const query = `query ($since: DateTime!) {
    issues(filter: { updatedAt: { gte: $since } }, first: 50) {
      nodes { id identifier title updatedAt url state { name } }
    }
  }`;
  const response = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { since: ctx.fromIso } }),
    signal: ctx.signal,
  });
  if (!response.ok) throw new Error(`linear_http_${String(response.status)}`);
  const parsed = (await response.json()) as LinearQueryResponse;
  if (parsed.errors?.length) {
    throw new Error(`linear_errors:${parsed.errors.map((e) => e.message ?? "err").join(",")}`);
  }
  const nodes = parsed.data?.issues?.nodes ?? [];
  return nodes.map<FridayBriefEvent>((issue) => ({
    source: "issues",
    occurredAt: issue.updatedAt,
    externalId: `linear:${issue.id}`,
    summary: `${issue.identifier} ${issue.title}`,
    detail: issue.state?.name ? `State: ${issue.state.name}` : undefined,
    url: issue.url,
    tags: ["linear"],
  }));
}

// ─── Jira ───

interface JiraIssue {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    updated?: string;
    status?: { name?: string };
  };
}

async function collectJira(
  fetchImpl: typeof fetch,
  baseUrl: string,
  basicAuth: string,
  accountId: string | undefined,
  ctx: FridayBriefCollectorContext,
): Promise<FridayBriefEvent[]> {
  const fromDate = ctx.fromIso.slice(0, 19).replace("T", " ");
  const assigneeFilter = accountId ? ` AND (assignee = "${accountId}" OR reporter = "${accountId}")` : "";
  const jql = `updated >= "${fromDate}"${assigneeFilter}`;
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/rest/api/3/search`);
  url.searchParams.set("jql", jql);
  url.searchParams.set("fields", "summary,updated,status");
  url.searchParams.set("maxResults", "50");
  const response = await fetchImpl(url.toString(), {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      Accept: "application/json",
    },
    signal: ctx.signal,
  });
  if (!response.ok) throw new Error(`jira_http_${String(response.status)}`);
  const parsed = (await response.json()) as { issues?: JiraIssue[] };
  return (parsed.issues ?? []).map<FridayBriefEvent>((issue) => ({
    source: "issues",
    occurredAt: issue.fields?.updated ?? ctx.toIso,
    externalId: `jira:${issue.id}`,
    summary: `${issue.key} ${issue.fields?.summary ?? ""}`.trim(),
    detail: issue.fields?.status?.name ? `Status: ${issue.fields.status.name}` : undefined,
    url: `${baseUrl.replace(/\/$/, "")}/browse/${issue.key}`,
    tags: ["jira"],
  }));
}

// ─── GitHub ───

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
  repository?: { full_name?: string };
  repository_url?: string;
}

async function collectGithub(
  fetchImpl: typeof fetch,
  token: string,
  username: string | undefined,
  repos: readonly string[],
  ctx: FridayBriefCollectorContext,
): Promise<FridayBriefEvent[]> {
  const events: FridayBriefEvent[] = [];
  const sinceDate = ctx.fromIso.slice(0, 10);
  if (repos.length > 0) {
    for (const repo of repos) {
      const url = new URL(`https://api.github.com/repos/${repo}/issues`);
      url.searchParams.set("since", ctx.fromIso);
      url.searchParams.set("per_page", "50");
      url.searchParams.set("state", "all");
      const response = await fetchImpl(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "friday-brief",
          Accept: "application/vnd.github+json",
        },
        signal: ctx.signal,
      });
      if (!response.ok) continue;
      const list = (await response.json()) as GitHubIssue[];
      for (const issue of list) {
        events.push({
          source: "issues",
          occurredAt: issue.updated_at,
          externalId: `gh:${issue.id}`,
          summary: `${repo}#${issue.number}: ${issue.title}`,
          detail: `State: ${issue.state}${issue.pull_request ? " (PR)" : ""}`,
          url: issue.html_url,
          tags: ["github", repo],
        });
      }
    }
  } else {
    const parts = [
      `involves:${username ?? ""}`,
      `updated:>=${sinceDate}`,
    ].filter((p) => !p.endsWith(":"));
    const url = new URL("https://api.github.com/search/issues");
    url.searchParams.set("q", parts.join(" "));
    url.searchParams.set("per_page", "50");
    const response = await fetchImpl(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "friday-brief",
        Accept: "application/vnd.github+json",
      },
      signal: ctx.signal,
    });
    if (response.ok) {
      const parsed = (await response.json()) as { items?: GitHubIssue[] };
      for (const issue of parsed.items ?? []) {
        const repoName = issue.repository?.full_name
          ?? (issue.repository_url
            ? issue.repository_url.replace("https://api.github.com/repos/", "")
            : "?");
        events.push({
          source: "issues",
          occurredAt: issue.updated_at,
          externalId: `gh:${issue.id}`,
          summary: `${repoName}#${issue.number}: ${issue.title}`,
          detail: `State: ${issue.state}${issue.pull_request ? " (PR)" : ""}`,
          url: issue.html_url,
          tags: ["github", repoName],
        });
      }
    }
  }
  return events;
}

// ─── Composite ───

export interface FridayBriefIssuesCollectorDeps {
  resolveSecret: (refKey: string | undefined) => string | undefined;
  fetchImpl?: typeof fetch;
}

export function createFridayBriefIssuesCollector(
  deps: FridayBriefIssuesCollectorDeps,
): FridayBriefCollector {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    source: "issues",
    isEnabled(config) {
      const cfg = config.sources.issues;
      return cfg.enabled && (cfg.linear.enabled || cfg.jira.enabled || cfg.github.enabled);
    },
    async collect(ctx: FridayBriefCollectorContext) {
      const cfg = ctx.config.sources.issues;
      if (!cfg.enabled) return buildSkippedCollectionResult("issues", "source_disabled");
      if (!cfg.linear.enabled && !cfg.jira.enabled && !cfg.github.enabled) {
        return buildSkippedCollectionResult("issues", "no_sub_source_enabled");
      }

      return runCollectorSafely("issues", async () => {
        const all: FridayBriefEvent[] = [];
        if (cfg.linear.enabled) {
          const key = deps.resolveSecret(cfg.linear.apiKeyRefKey);
          if (key) {
            try {
              const events = await collectLinear(fetchImpl, key, ctx);
              all.push(...events);
            } catch (err) {
              all.push({
                source: "issues",
                occurredAt: ctx.toIso,
                externalId: "error:linear",
                summary: `Linear fetch failed: ${(err as Error).message}`,
                tags: ["linear", "error"],
              });
            }
          }
        }
        if (cfg.jira.enabled && cfg.jira.baseUrl) {
          const credential = deps.resolveSecret(cfg.jira.credentialRefKey);
          if (credential) {
            try {
              const events = await collectJira(
                fetchImpl,
                cfg.jira.baseUrl,
                Buffer.from(credential, "utf8").toString("base64"),
                cfg.jira.accountId,
                ctx,
              );
              all.push(...events);
            } catch (err) {
              all.push({
                source: "issues",
                occurredAt: ctx.toIso,
                externalId: "error:jira",
                summary: `Jira fetch failed: ${(err as Error).message}`,
                tags: ["jira", "error"],
              });
            }
          }
        }
        if (cfg.github.enabled) {
          const token = deps.resolveSecret(cfg.github.tokenRefKey);
          if (token) {
            try {
              const events = await collectGithub(fetchImpl, token, cfg.github.username, cfg.github.repos, ctx);
              all.push(...events);
            } catch (err) {
              all.push({
                source: "issues",
                occurredAt: ctx.toIso,
                externalId: "error:github",
                summary: `GitHub fetch failed: ${(err as Error).message}`,
                tags: ["github", "error"],
              });
            }
          }
        }
        return { events: all };
      });
    },
  };
}
