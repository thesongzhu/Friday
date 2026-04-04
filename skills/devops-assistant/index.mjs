import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const DOMAIN_DETECTORS = [
  {
    domain: "ci-cd",
    label: "CI/CD Pipeline",
    patterns: [/\bCI\b/, /\bCD\b/, /\bpipeline\b/i, /\bGitHub Actions\b/i, /\bJenkins\b/i, /\bCircleCI\b/i, /\bGitLab CI\b/i, /\bbuild\s+pipeline/i],
    bestPractices: [
      "Keep pipeline stages atomic and fast-failing.",
      "Cache dependencies between runs.",
      "Use matrix builds for multi-platform testing.",
      "Pin action/image versions for reproducibility.",
    ],
    tools: ["GitHub Actions", "GitLab CI", "Jenkins", "CircleCI", "ArgoCD"],
  },
  {
    domain: "deployment",
    label: "Deployment",
    patterns: [/\bdeploy/i, /\brelease/i, /\brollback/i, /\bblue[- ]green/i, /\bcanary/i, /\brolling update/i, /\bship/i],
    bestPractices: [
      "Use blue-green or canary deployments to reduce risk.",
      "Automate rollback triggers on health-check failures.",
      "Tag every deployment with a version and commit SHA.",
      "Run smoke tests immediately after deployment.",
    ],
    tools: ["Kubernetes", "Docker", "Helm", "Terraform", "AWS ECS", "ArgoCD"],
  },
  {
    domain: "containerization",
    label: "Containerization",
    patterns: [/\bDocker\b/i, /\bcontainer/i, /\bKubernetes\b/i, /\bk8s\b/i, /\bpod\b/i, /\bhelm\b/i, /\bimage\b/i],
    bestPractices: [
      "Use multi-stage builds to minimize image size.",
      "Never run containers as root in production.",
      "Scan images for vulnerabilities before pushing.",
      "Use health checks and resource limits.",
    ],
    tools: ["Docker", "Kubernetes", "Helm", "Podman", "containerd"],
  },
  {
    domain: "version-control",
    label: "Version Control",
    patterns: [/\bgit\b/i, /\bbranch/i, /\bmerge\b/i, /\brebase\b/i, /\bcommit\b/i, /\bPR\b/, /\bpull request/i, /\bversion control/i],
    bestPractices: [
      "Use conventional commits for clear history.",
      "Protect main/master with required reviews.",
      "Rebase feature branches before merging.",
      "Squash trivial commits to keep history clean.",
    ],
    tools: ["Git", "GitHub", "GitLab", "Bitbucket"],
  },
  {
    domain: "infrastructure",
    label: "Infrastructure as Code",
    patterns: [/\bterraform\b/i, /\binfrastructure/i, /\bIaC\b/, /\bprovision/i, /\bcloud\s*formation/i, /\bansible\b/i, /\bpulumi\b/i],
    bestPractices: [
      "Store all infrastructure as code in version control.",
      "Use remote state with locking for Terraform.",
      "Plan before apply; review diffs carefully.",
      "Modularize infrastructure for reuse.",
    ],
    tools: ["Terraform", "Pulumi", "CloudFormation", "Ansible", "CDK"],
  },
  {
    domain: "monitoring",
    label: "Monitoring & Observability",
    patterns: [/\bmonitor/i, /\blog/i, /\bmetric/i, /\balert/i, /\bobservab/i, /\bPrometheus\b/i, /\bGrafana\b/i, /\bdatadog/i, /\bAPM\b/],
    bestPractices: [
      "Instrument key services with structured logging.",
      "Set up alerts for SLO breaches, not just errors.",
      "Use distributed tracing for microservices.",
      "Dashboard the four golden signals: latency, traffic, errors, saturation.",
    ],
    tools: ["Prometheus", "Grafana", "Datadog", "PagerDuty", "ELK Stack", "OpenTelemetry"],
  },
  {
    domain: "security",
    label: "Security & Compliance",
    patterns: [/\bsecur/i, /\bsecret/i, /\bvault\b/i, /\bcomplianc/i, /\bSSL\b/i, /\bTLS\b/i, /\bauth/i, /\bscan/i],
    bestPractices: [
      "Store secrets in a vault, never in code.",
      "Rotate credentials and tokens regularly.",
      "Run SAST/DAST scans in the CI pipeline.",
      "Enforce least-privilege access controls.",
    ],
    tools: ["HashiCorp Vault", "AWS Secrets Manager", "Snyk", "Trivy", "SonarQube"],
  },
];

function detectDomains(task) {
  const matched = [];
  for (const d of DOMAIN_DETECTORS) {
    const score = d.patterns.filter((p) => p.test(task)).length;
    if (score > 0) matched.push({ ...d, score });
  }
  matched.sort((a, b) => b.score - a.score);
  return matched.length > 0 ? matched : [{ ...DOMAIN_DETECTORS[0], score: 0 }];
}

function detectRisk(task) {
  const risks = [];
  if (/\bprod(uction)?\b/i.test(task)) risks.push({ level: "high", note: "Production environment involved." });
  if (/\bdelete\b|rm\s+-rf|destroy/i.test(task)) risks.push({ level: "high", note: "Destructive operation detected." });
  if (/\brollback\b/i.test(task)) risks.push({ level: "medium", note: "Rollback scenario; ensure backup exists." });
  if (/\broot\b|sudo\b/i.test(task)) risks.push({ level: "medium", note: "Elevated privileges required." });
  if (/\bfirst time|new to|beginner/i.test(task)) risks.push({ level: "low", note: "Operator may be unfamiliar; provide extra detail." });
  return risks;
}

function buildActionPlan(task, domains) {
  const steps = [];
  let stepNum = 1;

  steps.push({
    step: stepNum++,
    action: "Assess current state",
    description: "Review the current environment, configs, and recent changes.",
    commands: [],
  });

  const primary = domains[0];
  if (primary.domain === "ci-cd") {
    steps.push({ step: stepNum++, action: "Review pipeline configuration", description: "Inspect CI/CD config files for issues.", commands: ["cat .github/workflows/*.yml", "cat .gitlab-ci.yml"] });
  } else if (primary.domain === "deployment") {
    steps.push({ step: stepNum++, action: "Check deployment status", description: "Verify current deployment state and health.", commands: ["kubectl get pods", "docker ps", "git log --oneline -5"] });
  } else if (primary.domain === "containerization") {
    steps.push({ step: stepNum++, action: "Inspect container setup", description: "Review Dockerfiles and running containers.", commands: ["docker images", "docker ps -a", "cat Dockerfile"] });
  } else if (primary.domain === "version-control") {
    steps.push({ step: stepNum++, action: "Review repository state", description: "Check branch status and recent history.", commands: ["git status", "git log --oneline -10", "git branch -a"] });
  } else if (primary.domain === "infrastructure") {
    steps.push({ step: stepNum++, action: "Review infrastructure state", description: "Check current IaC configuration.", commands: ["terraform plan", "terraform state list"] });
  } else if (primary.domain === "monitoring") {
    steps.push({ step: stepNum++, action: "Check monitoring setup", description: "Review alert rules and dashboard configurations.", commands: ["curl -s localhost:9090/api/v1/alerts"] });
  } else {
    steps.push({ step: stepNum++, action: "Investigate the task", description: "Gather more details about the specific requirement.", commands: [] });
  }

  steps.push({
    step: stepNum++,
    action: "Execute the task",
    description: `Apply the changes for: ${compact(task, 80)}.`,
    commands: [],
  });

  steps.push({
    step: stepNum++,
    action: "Verify and validate",
    description: "Confirm the changes work as expected; run tests or health checks.",
    commands: [],
  });

  return steps;
}

export async function execute(input = {}) {
  const task = asString(input.task ?? input.content ?? input.text);
  if (!task) {
    throw new Error("devops-assistant requires a task input.");
  }

  const domains = detectDomains(task);
  const risks = detectRisk(task);
  const actionPlan = buildActionPlan(task, domains);
  const primary = domains[0];

  const highRisk = risks.some((r) => r.level === "high");

  return {
    summary: `DevOps analysis: primary domain "${primary.label}" with ${actionPlan.length} step(s) and ${risks.length} risk flag(s).`,
    nextStep: highRisk
      ? `Caution: ${risks.find((r) => r.level === "high").note} Review the action plan carefully before proceeding.`
      : `Start with step 1: "${actionPlan[0].action}".`,
    details: {
      task: compact(task, 200),
      primaryDomain: primary.label,
      domains: domains.map((d) => ({ domain: d.label, relevanceScore: d.score })),
      risks,
      actionPlan,
      bestPractices: primary.bestPractices,
      suggestedTools: primary.tools,
    },
  };
}
