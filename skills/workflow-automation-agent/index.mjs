import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const TOOL_MAP = [
  { domain: "data", patterns: [/\bdata\b/i, /\bdatabase\b/i, /\bquery\b/i, /\bSQL\b/i, /\bCSV\b/i, /\bspreadsheet/i, /\bexcel/i], tools: ["database-query", "csv-parser", "data-transformer"] },
  { domain: "api", patterns: [/\bAPI\b/, /\bREST\b/i, /\bwebhook/i, /\bendpoint/i, /\bHTTP\b/, /\bfetch\b/i], tools: ["http-client", "api-gateway", "webhook-listener"] },
  { domain: "file", patterns: [/\bfile/i, /\bupload/i, /\bdownload/i, /\bfolder/i, /\bdirectory/i, /\bstorage/i], tools: ["file-manager", "cloud-storage", "file-watcher"] },
  { domain: "email", patterns: [/\bemail/i, /\bmail/i, /\bnotif/i, /\balert/i, /\bsend\b/i, /\bmessage/i], tools: ["email-sender", "notification-service", "slack-webhook"] },
  { domain: "code", patterns: [/\bcode\b/i, /\bscript/i, /\bbuild/i, /\bcompile/i, /\btest/i, /\bdeploy/i], tools: ["code-runner", "build-pipeline", "test-runner"] },
  { domain: "schedule", patterns: [/\bschedul/i, /\bcron/i, /\btimer/i, /\bdaily\b/i, /\bweekly\b/i, /\bperiodic/i], tools: ["cron-scheduler", "task-queue", "timer-trigger"] },
  { domain: "transform", patterns: [/\btransform/i, /\bconvert/i, /\bformat/i, /\bparse/i, /\bextract/i, /\bclean/i], tools: ["data-transformer", "text-parser", "format-converter"] },
  { domain: "monitor", patterns: [/\bmonitor/i, /\bwatch/i, /\blog/i, /\btrack/i, /\bmetric/i, /\bhealth/i], tools: ["log-monitor", "health-checker", "metrics-collector"] },
];

const PHASE_TEMPLATES = [
  { phase: "input", label: "Gather Input", description: "Collect and validate the required input data." },
  { phase: "process", label: "Process", description: "Execute the core transformation or action." },
  { phase: "validate", label: "Validate", description: "Verify outputs meet expected criteria." },
  { phase: "output", label: "Deliver Output", description: "Send or store the final result." },
];

function detectDomains(goal) {
  const matched = [];
  for (const entry of TOOL_MAP) {
    if (entry.patterns.some((p) => p.test(goal))) {
      matched.push(entry);
    }
  }
  return matched.length > 0 ? matched : [TOOL_MAP[0]];
}

function extractActions(goal) {
  const verbs = [];
  const verbPatterns = [
    { action: "fetch", pattern: /\b(fetch|get|retrieve|pull|download)\b/i },
    { action: "send", pattern: /\b(send|push|post|deliver|email|notify)\b/i },
    { action: "transform", pattern: /\b(transform|convert|parse|format|clean|map)\b/i },
    { action: "store", pattern: /\b(store|save|write|upload|persist)\b/i },
    { action: "validate", pattern: /\b(validate|check|verify|test|assert)\b/i },
    { action: "monitor", pattern: /\b(monitor|watch|track|log|alert)\b/i },
    { action: "schedule", pattern: /\b(schedule|cron|timer|repeat|daily|weekly)\b/i },
    { action: "deploy", pattern: /\b(deploy|release|ship|publish|launch)\b/i },
    { action: "build", pattern: /\b(build|compile|package|bundle)\b/i },
    { action: "analyze", pattern: /\b(analyze|review|audit|inspect|report)\b/i },
  ];
  for (const vp of verbPatterns) {
    if (vp.pattern.test(goal)) verbs.push(vp.action);
  }
  return verbs.length > 0 ? verbs : ["process"];
}

function buildSteps(goal, domains, actions) {
  const steps = [];
  let stepNum = 1;

  steps.push({
    step: stepNum++,
    phase: "input",
    action: "Gather and validate input",
    description: `Parse the incoming request: "${compact(goal, 80)}". Validate required fields.`,
    tools: ["input-validator"],
    dependsOn: [],
  });

  for (const action of actions) {
    const relevantDomain = domains.find((d) =>
      d.domain === action || d.tools.some((t) => t.includes(action))
    ) || domains[0];

    steps.push({
      step: stepNum++,
      phase: "process",
      action: `${action.charAt(0).toUpperCase() + action.slice(1)} data`,
      description: `Execute ${action} operation using ${relevantDomain.domain} tools.`,
      tools: relevantDomain.tools.slice(0, 2),
      dependsOn: [stepNum - 2],
    });
  }

  steps.push({
    step: stepNum++,
    phase: "validate",
    action: "Validate results",
    description: "Verify the output meets expected criteria and handle edge cases.",
    tools: ["output-validator"],
    dependsOn: [stepNum - 2],
  });

  steps.push({
    step: stepNum++,
    phase: "output",
    action: "Deliver output",
    description: "Send the final result to the destination or store it.",
    tools: domains.length > 0 ? [domains[0].tools[0]] : ["output-handler"],
    dependsOn: [stepNum - 2],
  });

  return steps;
}

function detectComplexity(steps, actions) {
  if (steps.length > 6 || actions.length > 4) return "high";
  if (steps.length > 4 || actions.length > 2) return "medium";
  return "low";
}

export async function execute(input = {}) {
  const goal = asString(input.goal ?? input.content ?? input.text);
  if (!goal) {
    throw new Error("workflow-automation-agent requires a goal input.");
  }

  const domains = detectDomains(goal);
  const actions = extractActions(goal);
  const steps = buildSteps(goal, domains, actions);
  const complexity = detectComplexity(steps, actions);
  const allTools = [...new Set(steps.flatMap((s) => s.tools))];

  return {
    summary: `Workflow plan: ${steps.length} step(s) across ${domains.length} domain(s), complexity: ${complexity}.`,
    nextStep: `Start with step 1: "${steps[0].action}" and proceed sequentially.`,
    details: {
      goal: compact(goal, 200),
      complexity,
      domains: domains.map((d) => d.domain),
      actions,
      steps,
      toolsRequired: allTools,
      phases: PHASE_TEMPLATES,
      estimatedSteps: steps.length,
    },
  };
}
