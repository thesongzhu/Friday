// Phase M — skill convert / import / rollback (uses fixture skill).
import { api, startPhase, REPO_ROOT, WORKSPACE_FIXTURE_DIR } from "../lib/util.mjs";
import { chmodSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SKILL_DIR = `${WORKSPACE_FIXTURE_DIR}/skill-stab`;
const SKILL_PKG = `${WORKSPACE_FIXTURE_DIR}/stab-skill.friday.tgz`;

function makeFixtureSkill() {
  mkdirSync(SKILL_DIR, { recursive: true });
  writeFileSync(`${SKILL_DIR}/skill.manifest.json`, JSON.stringify({
    schemaVersion: "2.0", id: "stab-skill", name: "Stability Skill", version: "1.0.0",
    description: "smoke", kind: "conversation", category: "utility",
    author: { name: "Stab" },
    tags: ["stability"],
    runtime: { kind: "shell", entrypoint: "run.sh", minHubVersion: "1.0.0", apiVersion: "1", timeoutMsDefault: 30000 },
    triggers: { intents: [], phrases: [], channels: ["*"] },
    invocation: { userInvocable: true, modelInvocable: true, priority: 50, modes: ["intent"] },
    requirements: { bins: [], env: [], config: [], os: ["darwin", "linux", "win32"] },
    inputs: [{ key: "n", type: "number", required: true, label: "Number" }],
    outputs: [{ key: "doubled", type: "number", description: "Doubled number" }],
    permissions: { grants: [], promptOn: [] },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: { allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"], requiredCapabilities: [] },
    telemetry: { events: [] },
  }, null, 2));
  writeFileSync(`${SKILL_DIR}/skill.ui.json`, JSON.stringify({
    schemaVersion: "1.0",
    title: "Stability Skill",
    sections: [{ id: "main", label: "Main", fieldIds: ["field-n"] }],
    fields: [{ id: "field-n", inputKey: "n", kind: "number", label: "Number", required: true }],
    outputs: [{ id: "out-doubled", outputKey: "doubled", label: "Doubled" }],
    actions: [{ id: "run", label: "Run", style: "primary" }],
  }, null, 2));
  writeFileSync(`${SKILL_DIR}/run.sh`, "#!/bin/sh\nprintf '{\"doubled\":42}\\n'\n");
  chmodSync(`${SKILL_DIR}/run.sh`, 0o755);
  writeFileSync(`${SKILL_DIR}/SKILL.md`, "# Stability Skill\nSmoke test skill.\n");
}

export async function runPhaseM(ctx) {
  const p = startPhase("M");
  try {
    makeFixtureSkill();
    // Pack via CLI — give it a FRESH fridayHome so we don't hit migration-checksum mismatches
    // from prior runs. Using a unique tmp dir per pack invocation.
    const packStateDir = `/tmp/friday-overnight-test/state-pack-${Date.now()}`;
    const pack = spawnSync("node", [`${REPO_ROOT}/dist/cli/friday-cli.js`, "pack", SKILL_DIR, "--out", SKILL_PKG], {
      encoding: "utf8",
      env: { ...process.env, FRIDAY_STATE_DIR: packStateDir },
    });
    p.addEvidence("pack.txt", `stdout:\n${pack.stdout}\nstderr:\n${pack.stderr}\nstatus:${pack.status}`);
    const exists = existsSync(SKILL_PKG);
    p.note(`pack package exists=${exists}`);
    if (!exists) {
      p.finish("FAIL", "skill packaging produced no .friday.tgz", [{severity:"high", note: "pack failed"}]);
      return;
    }
    // Import
    const imp = await api("/v1/skills/import", {
      method: "POST", token: ctx.tokens.accessToken,
      body: JSON.stringify({
        source: { uri: SKILL_PKG },
        formatHint: "friday-package",
        target: "managed",
        replace: true,
        refreshRegistry: true,
      }),
    });
    p.addEvidence("import.json", { status: imp.status, body: imp.body });
    const skillId = imp.body?.data?.imports?.[0]?.skillId ?? "stab-skill";
    // Run
    const run = await api(`/v1/skills/${skillId}/run`, {
      method: "POST", token: ctx.tokens.accessToken,
      body: JSON.stringify({ input: { n: 21 } }),
    });
    p.addEvidence("run.json", { status: run.status, body: run.body });
    // Import content rollback is not exposed as /v1/skills/:id/rollback. The autonomy
    // rollback route is a separate upgrade-lifecycle surface and requires a target runtime.
    const rb = await api(`/v1/autonomy/skills/${skillId}/rollback`, {
      method: "POST", token: ctx.tokens.accessToken,
      body: JSON.stringify({ runtimeVersion: "0.0.0", providerModel: "overnight-probe" }),
    });
    p.addEvidence("rollback.json", { status: rb.status, body: rb.body });
    const anomalies = [];
    if (!imp.body?.ok) anomalies.push({severity:"high", note:"skill import returned non-ok"});
    if (!run.body?.ok || run.body?.data?.status !== "completed" || run.body?.data?.output?.doubled !== 42) {
      anomalies.push({severity:"medium", note:"imported skill run did not complete with doubled=42"});
    }
    p.finish("PASS", `skill import status=${imp.status} run=${run.status} autonomy rollback probe=${rb.status}`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"skill phase threw"}]);
  }
}
