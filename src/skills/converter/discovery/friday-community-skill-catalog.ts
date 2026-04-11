/**
 * Community Skill Catalog — curated list of community-contributed skills.
 *
 * Returns a hardcoded catalog of popular community skills that can be
 * browsed and imported into a Friday workspace.
 *
 * @module skills/converter/discovery
 */

// ─── Types ───

export interface CommunitySkillItem {
  id: string;
  name: string;
  description: string;
  author: string;
  sourceUrl: string;
  tags: string[];
  category: string;
}

// ─── Catalog ───

const COMMUNITY_CATALOG: CommunitySkillItem[] = [
  {
    id: "comm-code-review",
    name: "代码审查 Code Review",
    description: "Automated code review assistant that checks style, complexity, and common pitfalls across multiple languages.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/code-review",
    tags: ["code", "review", "quality"],
    category: "development",
  },
  {
    id: "comm-api-doc-gen",
    name: "API 文档生成器 API Doc Generator",
    description: "Generates OpenAPI / Swagger documentation from source code annotations and route definitions.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/api-doc-gen",
    tags: ["api", "documentation", "openapi"],
    category: "development",
  },
  {
    id: "comm-competitive-analysis",
    name: "竞品分析 Competitive Analysis",
    description: "Structures competitive landscape research with feature comparison matrices and positioning maps.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/competitive-analysis",
    tags: ["analysis", "competition", "strategy"],
    category: "business",
  },
  {
    id: "comm-weekly-report",
    name: "周报生成 Weekly Report Generator",
    description: "Compiles weekly status reports from git commits, issues, and calendar events.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/weekly-report",
    tags: ["report", "weekly", "status"],
    category: "productivity",
  },
  {
    id: "comm-data-cleaning",
    name: "数据清洗 Data Cleaning",
    description: "Detects and fixes common data quality issues: duplicates, missing values, format inconsistencies.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/data-cleaning",
    tags: ["data", "cleaning", "etl"],
    category: "data",
  },
  {
    id: "comm-seo-optimizer",
    name: "SEO 优化建议 SEO Optimizer",
    description: "Analyzes page content and metadata to provide actionable SEO improvement recommendations.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/seo-optimizer",
    tags: ["seo", "marketing", "optimization"],
    category: "marketing",
  },
  {
    id: "comm-social-calendar",
    name: "社媒内容日历 Social Media Calendar",
    description: "Plans and schedules social media content across platforms with optimal posting times.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/social-calendar",
    tags: ["social", "media", "calendar", "content"],
    category: "marketing",
  },
  {
    id: "comm-prd-gen",
    name: "产品需求文档 PRD Generator",
    description: "Creates structured product requirement documents from feature briefs and user stories.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/prd-gen",
    tags: ["product", "requirements", "prd"],
    category: "product",
  },
  {
    id: "comm-user-persona",
    name: "用户画像分析 User Persona Analysis",
    description: "Builds data-driven user personas from analytics, surveys, and behavioral data.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/user-persona",
    tags: ["user", "persona", "research", "ux"],
    category: "product",
  },
  {
    id: "comm-bug-triager",
    name: "Bug 分类器 Bug Triager",
    description: "Automatically categorizes, prioritizes, and assigns incoming bug reports based on severity and component.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/bug-triager",
    tags: ["bug", "triage", "issue"],
    category: "development",
  },
  {
    id: "comm-meeting-notes",
    name: "会议纪要 Meeting Notes",
    description: "Summarizes meeting transcripts into structured notes with action items and decisions.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/meeting-notes",
    tags: ["meeting", "notes", "summary"],
    category: "productivity",
  },
  {
    id: "comm-email-templates",
    name: "邮件模板 Email Templates",
    description: "Generates professional email drafts for common scenarios: outreach, follow-up, announcements.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/email-templates",
    tags: ["email", "template", "communication"],
    category: "productivity",
  },
  {
    id: "comm-kb-search",
    name: "知识库搜索 Knowledge Base Search",
    description: "Semantic search over internal documentation and knowledge base articles.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/kb-search",
    tags: ["knowledge", "search", "documentation"],
    category: "productivity",
  },
  {
    id: "comm-project-tracker",
    name: "项目进度追踪 Project Tracker",
    description: "Tracks project milestones, blockers, and team velocity with automated status dashboards.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/project-tracker",
    tags: ["project", "tracking", "management"],
    category: "productivity",
  },
  {
    id: "comm-test-gen",
    name: "自动化测试生成 Test Generator",
    description: "Generates unit and integration test cases from function signatures and API specifications.",
    author: "Friday Community",
    sourceUrl: "https://hub.friday.dev/skills/test-gen",
    tags: ["test", "automation", "testing"],
    category: "development",
  },
];

// ─── Public API ───

export function getCommunitySkillCatalog(query?: string): CommunitySkillItem[] {
  if (!query || query.trim().length === 0) return COMMUNITY_CATALOG;

  const q = query.toLowerCase();
  return COMMUNITY_CATALOG.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.tags.some((t) => t.toLowerCase().includes(q)),
  );
}
