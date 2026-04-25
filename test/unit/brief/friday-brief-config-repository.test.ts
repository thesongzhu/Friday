import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

import { createFridayBriefConfigRepository } from "../../../src/brief/friday-brief-config-repository.js";
import {
  buildDefaultFridayBriefConfig,
  type FridayBriefConfig,
} from "../../../src/brief/friday-brief-config.types.js";
import { V074_DAILY_BRIEF_CONFIG_SQL } from "../../../src/state/sqlite/migrations/v074-daily-brief-config.js";

describe("createFridayBriefConfigRepository", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(V074_DAILY_BRIEF_CONFIG_SQL);
  });

  afterEach(() => {
    db.close();
  });

  it("returns the default config when no row exists", () => {
    const repo = createFridayBriefConfigRepository();
    const config = repo.get(db);

    const expected = buildDefaultFridayBriefConfig();
    expect(config.enabled).toBe(expected.enabled);
    expect(config.cronExpression).toBe(expected.cronExpression);
    expect(config.timezone).toBe(expected.timezone);
    expect(config.length).toBe("normal");
    expect(config.fallbackOrder).toEqual(["wecom", "telegram", "email"]);
  });

  it("persists and reloads a custom config", () => {
    const repo = createFridayBriefConfigRepository();
    const input: FridayBriefConfig = {
      ...buildDefaultFridayBriefConfig(),
      enabled: true,
      cronExpression: "0 8 * * *",
      timezone: "America/Los_Angeles",
      length: "long",
      includeTranscript: true,
      languageOverride: "en-US",
      fallbackOrder: ["telegram", "email", "wecom"],
    };

    repo.upsert(db, input, "2026-04-24T08:00:00.000Z");
    const reloaded = repo.get(db);

    expect(reloaded.enabled).toBe(true);
    expect(reloaded.cronExpression).toBe("0 8 * * *");
    expect(reloaded.timezone).toBe("America/Los_Angeles");
    expect(reloaded.length).toBe("long");
    expect(reloaded.includeTranscript).toBe(true);
    expect(reloaded.languageOverride).toBe("en-US");
    expect(reloaded.fallbackOrder).toEqual(["telegram", "email", "wecom"]);
    expect(reloaded.updatedAt).toBe("2026-04-24T08:00:00.000Z");
  });

  it("overwrites the singleton row on repeated upsert", () => {
    const repo = createFridayBriefConfigRepository();

    repo.upsert(
      db,
      { ...buildDefaultFridayBriefConfig(), enabled: true, length: "short" },
      "2026-04-24T08:00:00.000Z",
    );
    repo.upsert(
      db,
      { ...buildDefaultFridayBriefConfig(), enabled: false, length: "long" },
      "2026-04-24T09:00:00.000Z",
    );

    const count = db
      .prepare("SELECT COUNT(*) AS c FROM friday_brief_config")
      .get() as { c: number };
    expect(count.c).toBe(1);

    const reloaded = repo.get(db);
    expect(reloaded.enabled).toBe(false);
    expect(reloaded.length).toBe("long");
    expect(reloaded.updatedAt).toBe("2026-04-24T09:00:00.000Z");
  });

  it("normalizes a fallbackOrder with duplicates and missing channels on upsert", () => {
    const repo = createFridayBriefConfigRepository();
    const input: FridayBriefConfig = {
      ...buildDefaultFridayBriefConfig(),
      fallbackOrder: ["wecom", "wecom"] as unknown as FridayBriefConfig["fallbackOrder"],
    };

    const stored = repo.upsert(db, input, "2026-04-24T08:00:00.000Z");
    expect(stored.fallbackOrder).toEqual(["wecom", "telegram", "email"]);

    const reloaded = repo.get(db);
    expect(reloaded.fallbackOrder).toEqual(["wecom", "telegram", "email"]);
  });

  it("normalizes a fallbackOrder containing bogus channel kinds on read", () => {
    const repo = createFridayBriefConfigRepository();
    repo.upsert(db, buildDefaultFridayBriefConfig(), "2026-04-24T08:00:00.000Z");

    db.prepare(
      "UPDATE friday_brief_config SET fallback_order_json = ? WHERE id = 'singleton'",
    ).run(JSON.stringify(["unknown-kind", "telegram"]));

    const reloaded = repo.get(db);
    expect(reloaded.fallbackOrder).toEqual(["telegram", "wecom", "email"]);
  });

  it("round-trips nested sources/channels/tts JSON", () => {
    const repo = createFridayBriefConfigRepository();
    const base = buildDefaultFridayBriefConfig();
    const input: FridayBriefConfig = {
      ...base,
      sources: {
        ...base.sources,
        git_repos: {
          enabled: true,
          repos: [{ label: "main", path: "/tmp/repo", authors: [], branches: [] }],
        },
        slack: {
          ...base.sources.slack,
          enabled: true,
          userId: "U123",
          channels: ["C1"],
        },
      },
      channels: {
        ...base.channels,
        telegram: {
          ...base.channels.telegram,
          enabled: true,
          chatId: "54321",
        },
      },
      tts: {
        ...base.tts,
        provider: "google",
      },
    };

    repo.upsert(db, input, "2026-04-24T08:00:00.000Z");
    const reloaded = repo.get(db);

    expect(reloaded.sources.git_repos.enabled).toBe(true);
    expect(reloaded.sources.git_repos.repos[0]?.label).toBe("main");
    expect(reloaded.sources.slack.enabled).toBe(true);
    expect(reloaded.sources.slack.userId).toBe("U123");
    expect(reloaded.channels.telegram.enabled).toBe(true);
    expect(reloaded.channels.telegram.chatId).toBe("54321");
    expect(reloaded.tts.provider).toBe("google");
  });
});
