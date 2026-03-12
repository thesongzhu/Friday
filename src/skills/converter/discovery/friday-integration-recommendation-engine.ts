/**
 * Integration Recommendation Engine.
 *
 * Maps discovered local programs to the best integration path (E1-E4):
 *   - code-repo: CLI tools, development tools → E1 code-repo converter
 *   - rest-api: Cloud services, database clients → E2 API analyzer
 *   - web-flow: Browsers, web-based productivity apps → E3 web flow converter
 *   - desktop-recording: GUI applications → E4 desktop recording converter
 *   - desktop-control: System/automation tools → direct desktop adapter control
 */

import type {
  FridayDiscoveredProgram,
  FridayDiscoveryFilterOptions,
  FridayIntegrationPath,
  FridayIntegrationRecommendation,
  FridayRecommendationResult,
} from "./friday-program-discovery.types.js";

// ─── Rule Definition ───

interface RecommendationRule {
  /** Pattern to match against program name, bundleId, or category. */
  match: (program: FridayDiscoveredProgram) => boolean;
  /** Integration path to recommend. */
  path: FridayIntegrationPath;
  /** Confidence for this rule. */
  confidence: number;
  /** Rationale template. */
  rationale: string;
  /** Optional converter hint. */
  converterHint?: string;
}

// ─── Rule Set ───

const RULES: RecommendationRule[] = [
  // Browsers → web-flow (E3)
  {
    match: (p) => p.category === "browser" && !p.isCli,
    path: "web-flow",
    confidence: 0.95,
    rationale: "Browser applications can be automated through web flow recording and replay",
    converterHint: "web-flow-converter",
  },

  // Development CLI tools → code-repo (E1)
  {
    match: (p) => p.category === "development" && p.isCli,
    path: "code-repo",
    confidence: 0.85,
    rationale: "CLI development tools typically have code repositories that can be analyzed for skill generation",
    converterHint: "code-repo-converter",
  },

  // Code editors → desktop-recording (E4)
  {
    match: (p) => p.category === "editor" && !p.isCli,
    path: "desktop-recording",
    confidence: 0.80,
    rationale: "GUI editors are best integrated via desktop recording to capture complex editing workflows",
    converterHint: "desktop-recording-converter",
  },

  // CLI editors (vim, emacs) → desktop-control
  {
    match: (p) => p.category === "editor" && p.isCli,
    path: "desktop-control",
    confidence: 0.75,
    rationale: "CLI editors can be automated through terminal desktop control",
  },

  // Communication apps → desktop-recording (E4)
  {
    match: (p) => p.category === "communication" && !p.isCli,
    path: "desktop-recording",
    confidence: 0.70,
    rationale: "Communication applications can be automated by recording common interaction patterns",
    converterHint: "desktop-recording-converter",
  },

  // Database clients → rest-api (E2) if GUI
  {
    match: (p) => p.category === "database" && !p.isCli,
    path: "rest-api",
    confidence: 0.75,
    rationale: "Database GUI clients typically connect to APIs that can be analyzed and integrated directly",
    converterHint: "undocumented-api-converter",
  },

  // Database CLI tools → code-repo (E1)
  {
    match: (p) => p.category === "database" && p.isCli,
    path: "code-repo",
    confidence: 0.70,
    rationale: "Database CLI tools have well-documented command interfaces suitable for code-level integration",
    converterHint: "code-repo-converter",
  },

  // Cloud CLI tools → rest-api (E2)
  {
    match: (p) => p.category === "cloud" && p.isCli,
    path: "rest-api",
    confidence: 0.90,
    rationale: "Cloud CLI tools wrap REST APIs that can be analyzed for direct API integration",
    converterHint: "undocumented-api-converter",
  },

  // Cloud GUI apps → web-flow (E3)
  {
    match: (p) => p.category === "cloud" && !p.isCli,
    path: "web-flow",
    confidence: 0.80,
    rationale: "Cloud management GUIs are typically web-based and best automated through web flow recording",
    converterHint: "web-flow-converter",
  },

  // Productivity apps → desktop-recording (E4)
  {
    match: (p) => p.category === "productivity" && !p.isCli,
    path: "desktop-recording",
    confidence: 0.85,
    rationale: "Productivity applications benefit from desktop recording to capture document workflows",
    converterHint: "desktop-recording-converter",
  },

  // Media tools → desktop-recording (E4)
  {
    match: (p) => p.category === "media" && !p.isCli,
    path: "desktop-recording",
    confidence: 0.75,
    rationale: "Media applications can be automated via desktop recording for batch processing workflows",
    converterHint: "desktop-recording-converter",
  },

  // Media CLI tools → code-repo (E1)
  {
    match: (p) => p.category === "media" && p.isCli,
    path: "code-repo",
    confidence: 0.80,
    rationale: "CLI media tools (ffmpeg, etc.) have well-known command patterns suitable for code integration",
    converterHint: "code-repo-converter",
  },

  // Automation tools → desktop-control
  {
    match: (p) => p.category === "automation",
    path: "desktop-control",
    confidence: 0.90,
    rationale: "Automation tools can be directly controlled through the desktop adapter for orchestration",
  },

  // Design tools → desktop-recording (E4)
  {
    match: (p) => p.category === "design" && !p.isCli,
    path: "desktop-recording",
    confidence: 0.80,
    rationale: "Design applications are best automated by recording common design workflows",
    converterHint: "desktop-recording-converter",
  },

  // Terminal emulators → desktop-control
  {
    match: (p) => p.category === "terminal",
    path: "desktop-control",
    confidence: 0.85,
    rationale: "Terminal emulators can be automated through direct desktop control for scripted interactions",
  },

  // Security CLI tools → code-repo (E1)
  {
    match: (p) => p.category === "security" && p.isCli,
    path: "code-repo",
    confidence: 0.70,
    rationale: "Security CLI tools can be integrated through code repository analysis",
    converterHint: "code-repo-converter",
  },

  // System utilities → desktop-control
  {
    match: (p) => p.category === "system",
    path: "desktop-control",
    confidence: 0.65,
    rationale: "System utilities can be controlled through the desktop adapter",
  },

  // Catch-all: GUI apps → desktop-recording
  {
    match: (p) => !p.isCli,
    path: "desktop-recording",
    confidence: 0.50,
    rationale: "GUI applications can generally be automated through desktop recording",
    converterHint: "desktop-recording-converter",
  },

  // Catch-all: CLI tools → code-repo
  {
    match: (p) => p.isCli,
    path: "code-repo",
    confidence: 0.45,
    rationale: "CLI tools can potentially be integrated through code repository analysis",
    converterHint: "code-repo-converter",
  },
];

// ─── Engine ───

export function generateRecommendations(
  programs: readonly FridayDiscoveredProgram[],
  filter?: FridayDiscoveryFilterOptions,
): FridayRecommendationResult {
  const recommendations: FridayIntegrationRecommendation[] = [];
  let unmatched = 0;

  for (const program of programs) {
    // Apply category filter
    if (filter?.category && program.category !== filter.category) continue;
    // Apply query filter
    if (filter?.query) {
      const q = filter.query.toLowerCase();
      if (!program.name.toLowerCase().includes(q) && !program.id.toLowerCase().includes(q)) {
        continue;
      }
    }

    const rec = findBestRecommendation(program);
    if (!rec) {
      unmatched++;
      continue;
    }

    // Apply confidence filter
    if (filter?.minConfidence && rec.confidence < filter.minConfidence) {
      continue;
    }

    // Apply integration path filter
    if (filter?.integrationPath && rec.integrationPath !== filter.integrationPath) {
      continue;
    }

    recommendations.push(rec);
  }

  // Sort by confidence descending
  recommendations.sort((a, b) => b.confidence - a.confidence);

  return {
    recommendations,
    unmatched,
    generatedAt: new Date().toISOString(),
  };
}

function findBestRecommendation(
  program: FridayDiscoveredProgram,
): FridayIntegrationRecommendation | null {
  for (const rule of RULES) {
    if (rule.match(program)) {
      return {
        programId: program.id,
        programName: program.name,
        integrationPath: rule.path,
        confidence: rule.confidence,
        rationale: rule.rationale,
        converterHint: rule.converterHint,
        context: {
          category: program.category,
          platform: program.platform,
          ...(program.bundleId ? { bundleId: program.bundleId } : {}),
        },
      };
    }
  }
  return null;
}
