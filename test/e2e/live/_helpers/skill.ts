/**
 * Skill helpers for real-scenario E2E tests.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { authHeaders } from "./real-env.js";
import { apiFetch } from "./api.js";

// ─── Types ───

export interface SkillGeneratorResult {
  sessionId: string;
  generationSucceeded: boolean;
  draft?: {
    manifest: { id: string; [key: string]: unknown };
    files: Array<{ path: string; content: string }>;
  };
}

// ─── Start Skill Generation and Approve ───

/**
 * Start a skill generation session, handle clarification, generate, and approve.
 * Returns the session ID and whether generation succeeded.
 */
export async function startSkillGenAndApprove(
  baseUrl: string,
  token: string,
  opts: {
    goal: string;
    model: string;
    clarificationAnswer?: string;
  },
): Promise<SkillGeneratorResult> {
  // 1. Start session
  const startRes = await apiFetch<{
    ok: boolean;
    data: {
      session: { sessionId: string };
      mode: string;
      questions?: string[];
    };
  }>(baseUrl, token, "POST", "/v1/skills/generator/sessions", {
    goal: opts.goal,
    userId: "admin-001",
    channel: "e2e-real",
    requestedModel: opts.model,
  });

  if (startRes.status !== 200 || !startRes.json.ok) {
    throw new Error(`Skill gen session start failed: ${JSON.stringify(startRes.json)}`);
  }

  const sessionId = startRes.json.data.session.sessionId;

  // 2. Handle clarification if needed
  if (startRes.json.data.mode === "clarification_required") {
    const answer =
      opts.clarificationAnswer ??
      "A simple shell skill. No inputs needed. Output JSON with a 'result' field.";
    await apiFetch(
      baseUrl,
      token,
      "POST",
      `/v1/skills/generator/sessions/${sessionId}/messages`,
      { message: answer, requestedModel: opts.model },
    );
  }

  // 3. Generate (with retry on 422)
  let generationSucceeded = false;
  let draft: SkillGeneratorResult["draft"] | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const genRes = await apiFetch<Record<string, unknown>>(
      baseUrl,
      token,
      "POST",
      `/v1/skills/generator/sessions/${sessionId}/generate`,
      { requestedModel: opts.model },
    );

    if (genRes.status === 200 && genRes.json.ok) {
      generationSucceeded = true;
      const data = genRes.json.data as {
        draft: {
          manifest: { id: string };
          files: Array<{ path: string; content: string }>;
        };
      };
      draft = data.draft;
      break;
    }

    if (genRes.status === 422 && attempt === 0) {
      // Retry once
      continue;
    }
    // Accept failure gracefully
    break;
  }

  // 4. Approve if generation succeeded
  if (generationSucceeded) {
    const approveRes = await apiFetch<Record<string, unknown>>(
      baseUrl,
      token,
      "POST",
      `/v1/skills/generator/sessions/${sessionId}/approve`,
    );
    // Accept 200 or 422 (validation failure on save)
    if (approveRes.status !== 200) {
      generationSucceeded = false;
    }
  }

  return { sessionId, generationSucceeded, draft };
}

/**
 * Create a temp directory with a SKILL.md file for import testing.
 * Returns the directory path (caller must clean up).
 */
export function createTempSkillMd(opts: {
  skillKey: string;
  name: string;
  script?: string;
}): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `friday-real-skill-${opts.skillKey}-`),
  );
  const content = `---
skillKey: ${opts.skillKey}
name: ${opts.name}
author: e2e-real-test
---

${opts.name} — E2E test skill.

\`\`\`bash
${opts.script ?? `echo '{"result": "hello from ${opts.skillKey}"}'`}
\`\`\`
`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
  return dir;
}
