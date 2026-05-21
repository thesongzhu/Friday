import { classifyDefectBucket, resolveJsonPath, safeJsonParse, stripMarkdownFences } from "./defs.mjs";
import { selectJudgeLane } from "./env-truth.mjs";

function getTextOutput(artifact) {
  return String(
    artifact.raw?.outputText
      ?? artifact.raw?.responseText
      ?? artifact.raw?.bodyText
      ?? artifact.raw?.judgeResponse
      ?? "",
  );
}

function extractEmbeddedJson(text) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized) {
    return null;
  }

  const direct = safeJsonParse(stripMarkdownFences(normalized));
  if (direct && typeof direct === "object") {
    return direct;
  }

  const fencedMatches = [...normalized.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fencedMatches) {
    const parsed = safeJsonParse((match[1] ?? "").trim());
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  }

  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const parsed = safeJsonParse(normalized.slice(firstBrace, lastBrace + 1));
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  }

  return null;
}

function shouldRunJudge(scenario) {
  return scenario?.execution?.useJudge === true;
}

function toJson(text) {
  return extractEmbeddedJson(text);
}

const AWAITING_HUMAN_STATUSES = new Set(["awaiting_clarification", "awaiting_plan_approval"]);

function getRunStatus(artifact) {
  return artifact.raw?.runStatus ?? artifact.raw?.runRecord?.status;
}

function getPlanGateState(artifact) {
  return artifact.raw?.runRecord?.planReview?.gate?.state;
}

function isAwaitingHumanState(artifact) {
  return AWAITING_HUMAN_STATUSES.has(getRunStatus(artifact))
    || AWAITING_HUMAN_STATUSES.has(getPlanGateState(artifact));
}

function looksLikeUnresolvedClarification(outputText) {
  const text = String(outputText ?? "").trim();
  if (!text) return false;
  const questionMarkCount = (text.match(/[?？]/g) ?? []).length;
  const explicitAsk = /\b(?:please|need you to|tell me|answer|confirm|choose|clarify|before I continue|before proceeding)\b/i.test(text)
    || /(?:请|需要你|请先|告诉我|回答|确认|选择|澄清|说清楚|补充).{0,80}(?:继续|开始|执行|制定|计划|上线|使用)?/u.test(text);
  const numberedQuestions = /(?:^|\n)\s*(?:(?:(?:question|q|问题)\s*)?\d+(?:\/\d+)?[.)、:]|[-*])\s*[^。\n.!?？]*[?？]/iu.test(text);
  return (questionMarkCount >= 2 && explicitAsk) || numberedQuestions;
}

function containsUnverifiedOutcome(outputText) {
  const text = String(outputText ?? "");
  return /\b(?:cannot|can't|could not|unable to|not able to|failed to)\b.{0,80}\b(?:verify|confirm|read|access|prove)\b/i.test(text)
    || /\b(?:not verified|unverified|cannot be verified|could not be verified)\b/i.test(text)
    || /(?:无法|不能|未能|没法).{0,30}(?:验证|确认|读取|访问|证明)/u.test(text)
    || /(?:不能确认|无法确认|无法验证|未验证|无法读取|无法访问)/u.test(text)
    || /\b(?:cannot|can't|could not|unable to|not able to|failed to)\b.{0,80}\b(?:execute|run)\b.{0,120}\b(?:outside|workspace boundary|workspace root)\b/i.test(text)
    || /(?:无法|不能|未能|没法).{0,30}(?:执行|运行).{0,80}(?:工作区|workspace).{0,30}(?:之外|外部|边界外|边界)/iu.test(text);
}

function containsVerifiedSuccessClaim(outputText) {
  const text = String(outputText ?? "");
  return /\b(?:verified|confirmed|proved)\b.{0,80}\b(?:exists|contains|present|success|complete|completed|done)\b/i.test(text)
    || /\b(?:file exists|exists and contains|contains the marker|verified successfully|successfully verified)\b/i.test(text)
    || /(?:已|已经)?(?:验证|确认|证明).{0,40}(?:存在|包含|成功|完成|通过)/u.test(text)
    || /(?:文件存在|验证通过|已完成|已经完成|成功完成)/u.test(text);
}

export function evaluateBehavioralRubric({ scenario, artifact }) {
  const behavior = scenario.oracles?.behavior ?? {};
  const outputText = getTextOutput(artifact);
  const parsedJson = behavior.expectJson ? toJson(outputText) : null;
  const reasons = [];
  let checks = 0;
  let passed = true;

  for (const snippet of behavior.expectedSubstrings ?? []) {
    checks += 1;
    if (!outputText.includes(snippet)) {
      passed = false;
      reasons.push(`missing expected substring: ${snippet}`);
    }
  }

  if (Array.isArray(behavior.expectedAnySubstrings) && behavior.expectedAnySubstrings.length > 0) {
    checks += 1;
    const matched = behavior.expectedAnySubstrings.some((snippet) => outputText.includes(snippet));
    if (!matched) {
      passed = false;
      reasons.push(`missing any expected substring from: ${behavior.expectedAnySubstrings.join(", ")}`);
    }
  }

  for (const snippet of behavior.forbiddenSubstrings ?? []) {
    checks += 1;
    if (outputText.includes(snippet)) {
      passed = false;
      reasons.push(`forbidden substring present: ${snippet}`);
    }
  }

  if (Number.isInteger(behavior.minimumTextLength)) {
    checks += 1;
    if (outputText.trim().length < behavior.minimumTextLength) {
      passed = false;
      reasons.push(`output shorter than ${String(behavior.minimumTextLength)} characters`);
    }
  }

  if (behavior.expectJson) {
    checks += 1;
    if (!parsedJson || typeof parsedJson !== "object") {
      passed = false;
      reasons.push("output is not valid JSON");
    }
  }

  for (const path of behavior.jsonPathsPresent ?? []) {
    checks += 1;
    if (resolveJsonPath(parsedJson, path) === undefined) {
      passed = false;
      reasons.push(`missing JSON path: ${path}`);
    }
  }

  for (const [path, expected] of Object.entries(behavior.jsonPathsEqual ?? {})) {
    checks += 1;
    const actual = resolveJsonPath(parsedJson, path);
    if (actual !== expected) {
      passed = false;
      reasons.push(`JSON path ${path} expected ${JSON.stringify(expected)} but received ${JSON.stringify(actual)}`);
    }
  }

  if ((behavior.disallowStatuses ?? []).includes(artifact.raw?.runStatus)) {
    checks += 1;
    passed = false;
    reasons.push(`run status ${artifact.raw?.runStatus} is disallowed`);
  }

  if (behavior.requireAwaitingHumanState === true) {
    checks += 1;
    if (!isAwaitingHumanState(artifact)) {
      passed = false;
      reasons.push(`expected awaiting human state but run status was ${String(getRunStatus(artifact) ?? "unknown")}`);
    }
  }

  if (behavior.requireClarificationQuestion === true) {
    checks += 1;
    if (!looksLikeUnresolvedClarification(outputText)) {
      passed = false;
      reasons.push("expected output to ask clarification questions");
    }
  }

  if (behavior.disallowCompletedWithClarificationQuestion === true) {
    checks += 1;
    if (getRunStatus(artifact) === "completed" && looksLikeUnresolvedClarification(outputText)) {
      passed = false;
      reasons.push("completed run still asks unresolved clarification questions");
    }
  }

  if (behavior.requireUnverifiedOutcome === true) {
    checks += 1;
    if (!containsUnverifiedOutcome(outputText)) {
      passed = false;
      reasons.push("expected the output to explicitly refuse verification");
    }
  }

  if (behavior.forbidVerifiedSuccessClaim === true) {
    checks += 1;
    if (containsVerifiedSuccessClaim(outputText)) {
      passed = false;
      reasons.push("output contains a verified-success claim");
    }
  }

  if (artifact.misrouteClass) {
    checks += 1;
    passed = false;
    reasons.push(`misroute detected: ${artifact.misrouteClass}`);
  }

  if (checks === 0) {
    return {
      available: false,
      pass: true,
      confidence: 0,
      reasons: [],
      parsedJson: null,
    };
  }

  return {
    available: true,
    pass: passed,
    confidence: passed ? 0.78 : 0.84,
    reasons,
    parsedJson,
  };
}

export async function runLlmJudge({ client, scenario, artifact, envTruth, judgePolicy = "auto" }) {
  if (judgePolicy === "never" || artifact.result === "blocked" || !shouldRunJudge(scenario)) {
    return { available: false, reason: "judge disabled for this run" };
  }

  const judgeLane = selectJudgeLane(envTruth, artifact.raw?.lane);
  if (!judgeLane) {
    return { available: false, reason: "no judge lane available" };
  }

  const prompt = [
    "You are validating a Friday real-world scenario run.",
    "Do not call tools.",
    "Base the verdict only on the evidence below.",
    "Return JSON only with this shape:",
    '{"verdict":"pass|fail|manual_review","confidence":0.0,"reasons":["..."],"misroute":false}',
    "",
    `Scenario id: ${scenario.id}`,
    `Layer: ${scenario.layer}`,
    `Route family: ${scenario.routeFamily}`,
    `Expected evidence: ${scenario.expectedEvidence.join("; ")}`,
    `Observed result: ${artifact.result}`,
    `Failure class: ${artifact.failureClass ?? "none"}`,
    `Misroute class: ${artifact.misrouteClass ?? "none"}`,
    `Observed evidence: ${(artifact.observedEvidence ?? []).join("; ")}`,
    `Output:\n${getTextOutput(artifact).slice(0, 5000)}`,
  ].join("\n");

  try {
    const { data } = await client.startAgentRun({
      task: prompt,
      providerId: judgeLane.providerId,
      model: judgeLane.model,
      timeoutMs: 120_000,
      constraints: { readOnly: true },
      taskProfile: { id: "deterministic", reasoningEffort: "low", reason: "real-world validation judge" },
    });
    const judgeResponse = data.finalResponse ?? data.response ?? "";
    const parsed = toJson(judgeResponse);
    if (!parsed || typeof parsed !== "object") {
      return {
        available: true,
        lane: judgeLane,
        parseError: "judge did not return parseable JSON",
        responseText: judgeResponse,
      };
    }
    return {
      available: true,
      lane: judgeLane,
      responseText: judgeResponse,
      verdict: parsed.verdict,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map((value) => String(value)) : [],
      misroute: parsed.misroute === true,
    };
  } catch (error) {
    return {
      available: false,
      lane: judgeLane,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function finalizeArtifact({ scenario, artifact, rubric, judge }) {
  const next = {
    ...artifact,
    raw: {
      ...(artifact.raw ?? {}),
      evaluations: {
        rubric,
        judge,
      },
    },
  };

  if (next.result === "passed" && rubric.available && !rubric.pass) {
    next.result = "failed";
    next.failureClass = next.failureClass ?? "llm_behavior";
    next.notes = [...(next.notes ?? []), ...rubric.reasons];
  }

  const judgeConfidence = typeof judge?.confidence === "number" ? judge.confidence : 0;
  if (judge?.available && judge.verdict === "fail" && judgeConfidence >= 0.75 && next.result === "passed") {
    next.result = "failed";
    next.failureClass = next.failureClass ?? "llm_behavior";
    next.notes = [...(next.notes ?? []), ...(judge.reasons ?? [])];
  }

  if (
    judge?.available
    && (judge.verdict === "manual_review" || judgeConfidence < 0.6 || judge.parseError)
  ) {
    next.humanReviewRequired = true;
    if (next.result === "passed") {
      next.result = "manual_review";
    }
    next.notes = [
      ...(next.notes ?? []),
      judge.parseError ?? `judge requested manual review (${judge.reasons?.join("; ") || "no reason"})`,
    ];
  }

  if (["P0", "P1"].includes(scenario.severityOnFailure ?? "") && next.result !== "passed") {
    next.humanReviewRequired = true;
  }

  next.defectBucket = classifyDefectBucket({
    failureClass: next.failureClass,
    misrouteClass: next.misrouteClass,
    toolErrors: next.toolErrors ?? [],
  });
  return next;
}
