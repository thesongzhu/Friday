import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const pathAliases = {
  "#agent": resolve(__dirname, "src/agent/index.ts"),
  "#utilities": resolve(__dirname, "src/utilities/index.ts"),
  "#api": resolve(__dirname, "src/api/index.ts"),
  "#config": resolve(__dirname, "src/config/index.ts"),
  "#errors": resolve(__dirname, "src/errors/index.ts"),
  "#hub": resolve(__dirname, "src/hub/index.ts"),
  "#jobs": resolve(__dirname, "src/jobs/index.ts"),
  "#learning": resolve(__dirname, "src/learning/index.ts"),
  "#ledger": resolve(__dirname, "src/ledger/index.ts"),
  "#satellites": resolve(__dirname, "src/satellites/index.ts"),
  "#skills/converter": resolve(__dirname, "src/skills/converter/index.ts"),
  "#skills/generator": resolve(__dirname, "src/skills/generator/index.ts"),
  "#memory": resolve(__dirname, "src/memory/index.ts"),
  "#sessions": resolve(__dirname, "src/sessions/index.ts"),
  "#skills": resolve(__dirname, "src/skills/index.ts"),
  "#state": resolve(__dirname, "src/state/index.ts"),
  "#providers": resolve(__dirname, "src/providers/index.ts"),
  "#workflows": resolve(__dirname, "src/workflows/index.ts"),
  "#plugins": resolve(__dirname, "src/plugins/index.ts"),
  "#browser": resolve(__dirname, "src/browser/index.ts"),
  "#channels": resolve(__dirname, "src/channels/index.ts"),
  "#cli": resolve(__dirname, "src/cli/index.ts"),
  "#xhs": resolve(__dirname, "src/xhs/index.ts"),
  "#rules": resolve(__dirname, "src/rules/index.ts"),
  "#node-runner": resolve(__dirname, "src/node-runner/index.ts"),
  "#acceptance": resolve(__dirname, "src/acceptance/index.ts"),
  "#retry": resolve(__dirname, "src/retry/index.ts"),
  "#playbook": resolve(__dirname, "src/playbook/index.ts"),
  "#routing": resolve(__dirname, "src/routing/index.ts"),
  "#daemon": resolve(__dirname, "src/daemon/index.ts"),
  "#tui": resolve(__dirname, "src/tui/index.ts"),
  "#media-understanding": resolve(__dirname, "src/media-understanding/index.ts"),
  "#link-understanding": resolve(__dirname, "src/link-understanding/index.ts"),
  "#heartbeat": resolve(__dirname, "src/heartbeat/index.ts"),
};

export default defineConfig({
  resolve: {
    alias: {
      ...pathAliases,
      "@": resolve(__dirname, "ui/src"),
      "@friday-operator-client": resolve(
        __dirname,
        "packages/friday-operator-client/src/index.ts",
      ),
    },
  },
  test: {
    pool: "forks",
    testTimeout: 10_000,
    projects: [
      {
        extends: true,
        test: {
          name: "default",
          include: ["test/**/*.test.ts"],
          exclude: [
            "test/e2e/friday-llm-e2e.test.ts",
            "test/e2e/friday-real-scenarios-e2e.test.ts",
            "test/e2e/ui/**/*.test.ts",
          ],
          pool: "forks",
        },
      },
      {
        extends: true,
        test: {
          name: "typecheck",
          include: ["test/**/*.test-d.ts"],
          typecheck: {
            enabled: true,
            only: true,
          },
        },
      },
      {
        extends: true,
        test: {
          name: "llm-e2e",
          include: [
            "test/e2e/friday-llm-e2e.test.ts",
            "test/e2e/friday-real-scenarios-e2e.test.ts",
          ],
          pool: "threads",
          testTimeout: 120_000,
          maxWorkers: 1,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: "browser-e2e",
          include: ["test/e2e/ui/**/*.test.ts"],
          pool: "forks",
          testTimeout: 120_000,
          hookTimeout: 30_000,
          maxWorkers: 1,
        },
      },
    ],
  },
});
