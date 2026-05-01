#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DIST_CLI = path.join(REPO_ROOT, "dist", "cli", "friday-cli.js");
const HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEEPSEEK_MODEL = process.env.FRIDAY_EXTERNAL_CLOSURE_MODEL ?? "deepseek-v4-flash";
const SAMPLE_REPO = process.env.FRIDAY_EXTERNAL_CLOSURE_GITHUB_REPO ?? "https://github.com/modelcontextprotocol/servers.git";
const LOCAL_PASSPHRASE = process.env.FRIDAY_TEST_LOCAL_PASSPHRASE
  ?? process.env.FRIDAY_LOCAL_PASSPHRASE
  ?? "friday-external-closure-passphrase-123";

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function writeText(file, text, mode) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, "utf8");
  if (mode !== undefined) fs.chmodSync(file, mode);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(baseUrl, timeoutMs = 60_000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/v1/health`);
      if (response.ok) return response.json();
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`health timeout: ${lastError}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      child.removeListener("close", settle);
      child.removeListener("error", settle);
      resolve();
    };
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore cleanup failure
        }
      }
      settle();
    }, 8_000);
    child.once("close", settle);
    child.once("error", settle);
    try {
      child.kill("SIGTERM");
    } catch {
      settle();
    }
  });
}

async function api(baseUrl, token, method, routePath, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: response.status, ok: response.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

async function login(baseUrl) {
  const bootstrapResponse = await fetch(`${baseUrl}/v1/auth/bootstrap/status`);
  const bootstrapStatus = await bootstrapResponse.json();
  if (!bootstrapResponse.ok || !bootstrapStatus.ok) {
    throw new Error(`local auth bootstrap status failed: ${JSON.stringify(bootstrapStatus)}`);
  }
  if (bootstrapStatus.data?.bootstrapRequired === true) {
    const initializeResponse = await fetch(`${baseUrl}/v1/auth/bootstrap/local-passphrase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
    });
    const initializeBody = await initializeResponse.json();
    if (!initializeResponse.ok || !initializeBody.ok) {
      throw new Error(`local passphrase bootstrap failed: ${JSON.stringify(initializeBody)}`);
    }
  }

  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
  });
  const json = await response.json();
  if (!response.ok || !json.ok || !json.data?.accessToken) {
    throw new Error(`local passphrase login failed: ${JSON.stringify(json)}`);
  }
  return json.data.accessToken;
}

async function mustOk(label, promise) {
  const result = await promise;
  if (result.status < 200 || result.status >= 300 || !result.json?.ok) {
    throw new Error(`${label} failed: status=${result.status} body=${JSON.stringify(result.json).slice(0, 2000)}`);
  }
  return result;
}

async function pollRun(baseUrl, token, runId, timeoutMs = 60_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await api(baseUrl, token, "GET", `/v1/workflow-runs/${encodeURIComponent(runId)}`);
    const status = last.json?.data?.run?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      return last.json.data.run;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`workflow run ${runId} did not reach terminal state; last=${JSON.stringify(last?.json)}`);
}

function writeExternalSkillMd(rootDir, skillId) {
  const skillDir = path.join(rootDir, skillId);
  ensureDir(skillDir);
  writeText(path.join(skillDir, "SKILL.md"), `---
skillKey: ${skillId}
name: External Closure Echo
author: closure
---

Echoes a marker from an externally supplied SKILL.md package.

\`\`\`bash
printf '{"marker":"external-file-skill","name":"%s"}\\n' "\${FRIDAY_INPUT_NAME:-missing}"
\`\`\`
`);
  return skillDir;
}

function writeNativeSkill(rootDir, skillId, { failing = false } = {}) {
  const skillDir = path.join(rootDir, skillId);
  ensureDir(skillDir);
  writeJson(path.join(skillDir, "skill.manifest.json"), {
    schemaVersion: "2.0",
    id: skillId,
    name: failing ? "External Failing Skill" : "External Native Skill",
    description: "External native Friday skill used by closure.",
    version: "1.0.0",
    kind: "workflow",
    category: "utility",
    author: { name: "closure" },
    tags: ["closure", "external"],
    runtime: {
      kind: "shell",
      entrypoint: "run.sh",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 30_000,
    },
    triggers: { intents: [], phrases: [], channels: ["*"] },
    invocation: { userInvocable: true, modelInvocable: true, priority: 50, modes: ["intent", "workflow"] },
    requirements: { bins: [], env: [], config: [], os: ["darwin", "linux", "win32"] },
    inputs: [{ key: "value", type: "string", required: false, label: "Value" }],
    outputs: [{ key: "marker", type: "string", description: "Closure marker" }],
    permissions: { grants: [], promptOn: [] },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: { allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"], requiredCapabilities: [] },
    telemetry: { events: [] },
  });
  writeJson(path.join(skillDir, "skill.ui.json"), {
    schemaVersion: "1.0",
    title: failing ? "External Failing Skill" : "External Native Skill",
    sections: [{ id: "main", label: "Main", fieldIds: ["field-value"] }],
    fields: [{ id: "field-value", inputKey: "value", kind: "text", label: "Value", required: false }],
    outputs: [{ id: "out-marker", outputKey: "marker", label: "Marker", widget: "text" }],
    actions: [{ id: "run", label: "Run", style: "primary" }],
  });
  writeText(
    path.join(skillDir, "run.sh"),
    failing
      ? "#!/usr/bin/env bash\nset -euo pipefail\necho 'intentional external skill failure' >&2\nexit 42\n"
      : "#!/usr/bin/env bash\nset -euo pipefail\nprintf '{\"marker\":\"external-native-skill\",\"value\":\"%s\"}\\n' \"${FRIDAY_INPUT_VALUE:-unset}\"\n",
    0o755,
  );
  return skillDir;
}

function workflowGraphForSkill(skillId) {
  return {
    nodes: [
      { id: "trigger", type: "trigger", label: "Manual Trigger", config: { triggerType: "manual" } },
      { id: "callSkill", type: "skill_call", label: "Call Imported Skill", config: { skillId } },
      {
        id: "collect",
        type: "data",
        label: "Collect Skill Output",
        config: {
          mapping: {
            skillOutput: "$steps.callSkill.output",
          },
        },
      },
    ],
    edges: [
      { id: "edge-trigger-skill", sourceNodeId: "trigger", targetNodeId: "callSkill" },
      { id: "edge-skill-collect", sourceNodeId: "callSkill", targetNodeId: "collect" },
    ],
  };
}

async function startFriday(runRoot, skillsDir, managedDir) {
  const port = await findFreePort();
  const baseUrl = `http://${HOST}:${port}`;
  const logPath = path.join(runRoot, "friday-server.log");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn(process.execPath, [
    DIST_CLI,
    "start",
    "--host",
    HOST,
    "--port",
    String(port),
    "--skills-dir",
    managedDir,
    "--skills-dir",
    skillsDir,
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      FRIDAY_STATE_DIR: path.join(runRoot, "state"),
      FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS: "true",
      FRIDAY_CHANNELS_JSON: process.env.FRIDAY_CHANNELS_JSON ?? JSON.stringify({ enabled: true, instances: [] }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logStream.write(chunk));
  child.stderr.on("data", (chunk) => logStream.write(chunk));
  await waitForHealth(baseUrl);
  const token = await login(baseUrl);
  return { child, baseUrl, token, logPath, logStream };
}

async function closeFriday(runtime) {
  if (!runtime) return;
  await stopProcess(runtime.child);
  await new Promise((resolve) => runtime.logStream.end(resolve));
}

async function configureDeepSeek(baseUrl, token) {
  const keyPresent = typeof process.env.FRIDAY_DEEPSEEK_API_KEY === "string" // pragma: allowlist secret
    && process.env.FRIDAY_DEEPSEEK_API_KEY.trim().length > 0;
  if (!keyPresent) {
    return { skipped: true, reason: "FRIDAY_DEEPSEEK_API_KEY not set" };
  }
  const create = await mustOk("create DeepSeek provider", api(baseUrl, token, "POST", "/v1/providers", {
    kind: "deepseek",
    name: "External Closure DeepSeek",
    baseUrl: process.env.FRIDAY_CLOSURE_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    authMode: "api-key",
    api: "openai-completions",
    apiKey: "$FRIDAY_DEEPSEEK_API_KEY",
    supportedModels: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    defaultModel: DEEPSEEK_MODEL,
    enabled: true,
    validateOnSave: false,
  }));
  const providerId = create.json.data.provider.id;
  const validate = await mustOk("validate DeepSeek provider", api(baseUrl, token, "POST", `/v1/providers/${providerId}/validate`, undefined, 120_000));
  if (validate.json.data?.validation?.status !== "ok") {
    throw new Error(`DeepSeek validation was not ok: ${JSON.stringify(validate.json.data?.validation)}`);
  }
  await mustOk("set model routing", api(baseUrl, token, "PUT", "/v1/model-routing", {
    defaultProviderId: providerId,
    fallbackProviderIds: [],
  }));
  return { skipped: false, providerId, model: DEEPSEEK_MODEL };
}

async function runLarkWebhookProbe(runRoot) {
  const { createFridayChannelWebhookRoutes } = await import("../../dist/api/http/routes/friday-channel-webhook-routes.js");
  const { createLarkWebhookRelayService } = await import("../../dist/channels/lark/lark-webhook-relay.js");
  const verificationToken = "closure-lark-token";
  const encryptKey = "closure-lark-encrypt-key";
  const timestamp = "1700000000";
  const nonce = "closure-nonce";
  const dispatched = [];
  const relay = createLarkWebhookRelayService();
  relay.setVerificationToken(verificationToken);
  relay.setEncryptKey(encryptKey);
  await relay.start((payload) => dispatched.push(payload));
  const routes = createFridayChannelWebhookRoutes({ larkWebhookRelay: relay });
  const route = routes.find((item) => item.operationId === "channels.webhooks.lark");
  if (!route) throw new Error("Lark webhook route missing");

  async function invoke(rawBody, headers = {}) {
    return route.handler({
      requestId: `closure-${Date.now()}`,
      receivedAt: nowIso(),
      params: {},
      query: {},
      body: {},
      headers,
      principal: null,
      rawBody,
    });
  }

  const challenge = JSON.stringify({
    type: "url_verification",
    token: verificationToken,
    challenge: "challenge-ok",
  });
  const event = JSON.stringify({
    schema: "2.0",
    header: { event_type: "im.message.receive_v1", token: verificationToken },
    event: {
      message: {
        message_id: "om_external_closure",
        chat_id: "oc_external_closure",
        chat_type: "group",
        content: "{\"text\":\"生成一个 workflow，等等先换个话题：记住蓝血机械臂伪装。现在回到 workflow。\"}",
        create_time: "1708416000000",
      },
      sender: { sender_id: { open_id: "ou_external_closure" } },
    },
  });
  const signature = createHash("sha256").update(`${timestamp}${nonce}${encryptKey}${event}`, "utf8").digest("hex");
  const acceptedChallenge = await invoke(challenge);
  const rejectedToken = await invoke(JSON.stringify({ type: "url_verification", token: "wrong", challenge: "bad" })).catch((error) => ({
    thrown: true,
    code: error?.code,
    httpStatus: error?.httpStatus,
    message: error instanceof Error ? error.message : String(error),
  }));
  const acceptedEvent = await invoke(event, {
    "x-lark-signature": signature,
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
  });
  const summary = {
    acceptedChallenge,
    rejectedToken,
    acceptedEvent,
    dispatchedCount: dispatched.length,
    dispatchedMessageId: dispatched[0]?.event?.message?.message_id ?? null,
  };
  writeJson(path.join(runRoot, "lark-webhook-summary.json"), summary);
  if (acceptedChallenge?.challenge !== "challenge-ok") {
    throw new Error(`Lark challenge did not roundtrip: ${JSON.stringify(summary)}`);
  }
  if (dispatched.length !== 1 || dispatched[0]?.event?.message?.message_id !== "om_external_closure") {
    throw new Error(`Lark event was not dispatched exactly once: ${JSON.stringify(summary)}`);
  }
  await relay.stop();
  return summary;
}

async function main() {
  const runId = nowIso().replace(/[:.]/g, "-");
  const runRoot = path.join(REPO_ROOT, ".friday", "external-closure", runId);
  const sourceRoot = path.join(runRoot, "sources");
  const managedDir = path.join(runRoot, "managed-skills");
  const extraSkillsDir = path.join(runRoot, "extra-skills");
  ensureDir(sourceRoot);
  ensureDir(managedDir);
  ensureDir(extraSkillsDir);

  if (!fs.existsSync(DIST_CLI)) {
    const build = spawnSync("npm", ["run", "build:api"], { cwd: REPO_ROOT, encoding: "utf8" });
    writeText(path.join(runRoot, "build-api.log"), `stdout:\n${build.stdout}\nstderr:\n${build.stderr}\nstatus:${build.status}\n`);
    if (build.status !== 0) throw new Error("npm run build:api failed");
  }

  let runtime = await startFriday(runRoot, extraSkillsDir, managedDir);
  const report = {
    runId,
    startedAt: nowIso(),
    runRoot,
    steps: {},
  };

  try {
    report.steps.deepseek = await configureDeepSeek(runtime.baseUrl, runtime.token);

    const fileSkillDir = writeExternalSkillMd(sourceRoot, "external-file-echo");
    const fileImport = await mustOk("file SKILL.md import", api(runtime.baseUrl, runtime.token, "POST", "/v1/skills/import", {
      source: { uri: fileSkillDir },
      formatHint: "clawdbot-skill-md",
      target: "managed",
      replace: true,
      refreshRegistry: true,
    }));
    const fileSkillId = fileImport.json.data.imports[0].skillId;
    const fileRun = await mustOk("file SKILL.md skill run", api(runtime.baseUrl, runtime.token, "POST", `/v1/skills/${encodeURIComponent(fileSkillId)}/run`, {
      input: { name: "Friday" },
    }));
    if (fileRun.json.data.status !== "completed" || !JSON.stringify(fileRun.json.data).includes("external-file-skill")) {
      throw new Error(`file SKILL.md run did not complete with marker: ${JSON.stringify(fileRun.json.data)}`);
    }
    report.steps.externalFileSkill = { skillId: fileSkillId, status: fileRun.json.data.status };

    const nativeSkillDir = writeNativeSkill(sourceRoot, "external-native-echo");
    const packPath = path.join(runRoot, "external-native-echo.friday.tgz");
    const pack = await mustOk("native skill pack", api(runtime.baseUrl, runtime.token, "POST", "/v1/skills/pack", {
      skillDir: nativeSkillDir,
      outputFile: packPath,
    }));
    const nativeImport = await mustOk("native package import", api(runtime.baseUrl, runtime.token, "POST", "/v1/skills/import", {
      source: { uri: pack.json.data.packageFile },
      formatHint: "friday-package",
      target: "managed",
      replace: true,
      refreshRegistry: true,
    }));
    const nativeSkillId = nativeImport.json.data.imports[0].skillId;
    const nativeRun = await mustOk("native imported skill run", api(runtime.baseUrl, runtime.token, "POST", `/v1/skills/${encodeURIComponent(nativeSkillId)}/run`, {
      input: { value: "workflow-ready" },
    }));
    if (nativeRun.json.data.status !== "completed" || !JSON.stringify(nativeRun.json.data).includes("external-native-skill")) {
      throw new Error(`native skill run did not complete with marker: ${JSON.stringify(nativeRun.json.data)}`);
    }
    report.steps.externalNativeSkill = { skillId: nativeSkillId, status: nativeRun.json.data.status };

    const failingSkillDir = writeNativeSkill(sourceRoot, "external-failing-skill", { failing: true });
    const failingImport = await mustOk("failing skill import", api(runtime.baseUrl, runtime.token, "POST", "/v1/skills/import", {
      source: { uri: failingSkillDir },
      formatHint: "friday-package",
      target: "managed",
      replace: true,
      refreshRegistry: true,
    }));
    const failingSkillId = failingImport.json.data.imports[0].skillId;
    const failingRun = await mustOk("failing skill run dispatch", api(runtime.baseUrl, runtime.token, "POST", `/v1/skills/${encodeURIComponent(failingSkillId)}/run`, {
      input: { value: "must-fail" },
    }));
    if (failingRun.json.data.status !== "failed") {
      throw new Error(`failing skill was not marked failed: ${JSON.stringify(failingRun.json.data)}`);
    }
    report.steps.failingSkill = { skillId: failingSkillId, status: failingRun.json.data.status, stderr: failingRun.json.data.stderr };

    const githubConvert = await mustOk("GitHub code-repo convert", api(runtime.baseUrl, runtime.token, "POST", "/v1/skills/convert", {
      source: { uri: SAMPLE_REPO },
      formatHint: "code-repo",
      dryRun: true,
      options: { maxDrafts: 3 },
    }, 240_000));
    const githubDrafts = githubConvert.json.data.drafts ?? [];
    if (githubDrafts.length === 0) {
      throw new Error(`GitHub code-repo convert returned no drafts: ${JSON.stringify(githubConvert.json.data).slice(0, 2000)}`);
    }
    report.steps.githubCodeRepoConvert = {
      repo: SAMPLE_REPO,
      converterId: githubConvert.json.data.converterId,
      draftCount: githubDrafts.length,
      firstSkillId: githubDrafts[0]?.manifest?.id,
    };

    const wfSlug = `external-skill-workflow-${Date.now()}`;
    const createWf = await mustOk("create workflow using imported skill", api(runtime.baseUrl, runtime.token, "POST", "/v1/workflows", {
      slug: wfSlug,
      name: "External Skill Workflow Closure",
      tags: ["closure", "external-skill"],
      graph: workflowGraphForSkill(nativeSkillId),
    }));
    const workflowId = createWf.json.data.workflow.id;
    await mustOk("publish workflow using imported skill", api(runtime.baseUrl, runtime.token, "POST", `/v1/workflows/${encodeURIComponent(workflowId)}/publish`, {
      versionNumber: 1,
    }));
    const startRun = await mustOk("run workflow using imported skill", api(runtime.baseUrl, runtime.token, "POST", "/v1/workflow-runs", {
      workflowId,
      triggerType: "manual",
      triggerPayload: {},
    }));
    const workflowRun = await pollRun(runtime.baseUrl, runtime.token, startRun.json.data.run.id);
    if (workflowRun.status !== "completed") {
      const nodes = await api(runtime.baseUrl, runtime.token, "GET", `/v1/workflow-runs/${encodeURIComponent(workflowRun.id)}/nodes`);
      throw new Error(`workflow using imported skill did not complete: run=${JSON.stringify(workflowRun)} nodes=${JSON.stringify(nodes.json)}`);
    }
    report.steps.workflowUsesImportedSkill = { workflowId, runId: workflowRun.id, status: workflowRun.status };

    const memoryStore = await mustOk("store memory marker", api(runtime.baseUrl, runtime.token, "POST", "/v1/memory/items", {
      namespace: "tenant.default.channel.feishu.user.external.shared",
      source: "external-closure",
      key: "blue-blood-arm-camouflage",
      content: "用户偏好暗号：蓝血机械臂伪装。用于测试 topic drift 后少关键词 recall。",
      tags: ["closure", "topic-drift"],
    }));
    const memorySearch = await mustOk("search memory marker", api(runtime.baseUrl, runtime.token, "POST", "/v1/memory/search", {
      namespace: "tenant.default.channel.feishu.user.external.shared",
      query: "机械臂伪装",
      limit: 5,
    }));
    if (!JSON.stringify(memorySearch.json.data.items ?? []).includes("蓝血机械臂伪装")) {
      throw new Error(`memory search did not recall marker: ${JSON.stringify(memorySearch.json.data)}`);
    }
    report.steps.memoryRecall = { storedId: memoryStore.json.data.item.id, resultCount: memorySearch.json.data.items.length };

    report.steps.larkWebhook = await runLarkWebhookProbe(runRoot);

    await closeFriday(runtime);
    runtime = await startFriday(runRoot, extraSkillsDir, managedDir);
    const afterRestartSkill = await mustOk("restart native skill run", api(runtime.baseUrl, runtime.token, "POST", `/v1/skills/${encodeURIComponent(nativeSkillId)}/run`, {
      input: { value: "after-restart" },
    }));
    if (afterRestartSkill.json.data.status !== "completed" || !JSON.stringify(afterRestartSkill.json.data).includes("after-restart")) {
      throw new Error(`restart skill run failed: ${JSON.stringify(afterRestartSkill.json.data)}`);
    }
    const afterRestartWf = await mustOk("restart workflow get", api(runtime.baseUrl, runtime.token, "GET", `/v1/workflows/${encodeURIComponent(workflowId)}`));
    const afterRestartMemory = await mustOk("restart memory search", api(runtime.baseUrl, runtime.token, "POST", "/v1/memory/search", {
      namespace: "tenant.default.channel.feishu.user.external.shared",
      query: "机械臂伪装",
      limit: 5,
    }));
    if (!afterRestartWf.json.data.workflow?.id || !JSON.stringify(afterRestartMemory.json.data.items ?? []).includes("蓝血机械臂伪装")) {
      throw new Error(`restart persistence failed: workflow=${JSON.stringify(afterRestartWf.json.data)} memory=${JSON.stringify(afterRestartMemory.json.data)}`);
    }
    report.steps.restartPersistence = {
      skillStatus: afterRestartSkill.json.data.status,
      workflowId: afterRestartWf.json.data.workflow.id,
      memoryResultCount: afterRestartMemory.json.data.items.length,
    };

    report.status = "PASS";
  } catch (error) {
    report.status = "FAIL";
    report.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
    throw error;
  } finally {
    report.finishedAt = nowIso();
    writeJson(path.join(runRoot, "report.json"), report);
    await closeFriday(runtime);
  }

  console.log(JSON.stringify({
    status: report.status,
    runRoot,
    steps: report.steps,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
