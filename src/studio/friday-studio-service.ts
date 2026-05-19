import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { FridayDomainError } from "#errors";
import { extractReadableContent, stripHtmlToText } from "../link-understanding/friday-link-summarize.js";
import type {
  FridayStudioArtifact,
  FridayStudioArtifactCandidateResponse,
  FridayStudioArtifactResponse,
  FridayStudioExportResponse,
  FridayStudioImportedPack,
  FridayStudioImportRequest,
  FridayStudioImportResponse,
  FridayStudioInputField,
  FridayStudioLocalizedText,
  FridayStudioProductId,
  FridayStudioProductSummary,
  FridayStudioRun,
  FridayStudioRunRequest,
} from "../api/model/friday-api-studio.types.js";
import { buildStudioArtifactCapabilityCandidate, validateStudioArtifactAsCandidate } from "./friday-studio-artifact-candidate-bridge.js";

type StudioDocument = {
  querySelector(selector: string): ElementLike | null;
  querySelectorAll(selector: string): ElementLike[];
  title?: string;
  body?: { textContent?: string | null };
};

type ElementLike = {
  textContent?: string | null;
  getAttribute(name: string): string | null;
};

export interface FridayStudioService {
  listProducts(): FridayStudioProductSummary[];
  runProduct(request: FridayStudioRunRequest): Promise<FridayStudioRun>;
  getRun(runId: string): FridayStudioRun;
  getArtifact(runId: string, artifactId: string): FridayStudioArtifactResponse;
  exportRun(runId: string): FridayStudioExportResponse;
  importLocalPack(request: FridayStudioImportRequest): FridayStudioImportResponse;
  validateArtifactCandidate(runId: string): FridayStudioArtifactCandidateResponse;
}

export interface CreateFridayStudioServiceDeps {
  workspaceRoot?: string;
  nowIso?: () => string;
  fetchFn?: typeof fetch;
}

const STUDIO_PRODUCTS: FridayStudioProductSummary[] = [
  {
    id: "seo_audit",
    title: text("SEO 审计", "SEO Audit"),
    description: text("审计公开网页或 Friday 生成页面，输出技术 SEO、内容、结构化数据和跨境平台建议。", "Audit public or Friday-generated pages for technical SEO, content, structured data, and cross-border platform readiness."),
    category: "audit",
    delivery: text("HTML 报告、JSON 证据、修复清单、可导出 zip。", "HTML report, JSON evidence, fix checklist, exportable zip."),
    inputs: [
      field("url", "url", text("公开 URL", "Public URL"), true, text("只审计公开网页；不要输入需要登录的后台、订单页或私有页面。", "Only audit public pages; do not enter logged-in dashboards, order pages, or private URLs.")),
      field("focus", "textarea", text("业务背景", "Business context"), false, text("例如 Shopify 独立站、Amazon listing、TikTok 落地页、跨境品类。", "For example Shopify store, Amazon listing, TikTok landing page, cross-border category.")),
    ],
    outputKinds: ["html", "json", "zip"],
    firstParty: true,
    localOnly: true,
    mutatesUserComputer: false,
  },
  {
    id: "research_report",
    title: text("研究报告", "Research Report"),
    description: text("把主题、来源和笔记整理成带引用、证据表、置信度和开放问题的交付报告。", "Turn a topic, sources, and notes into a cited report with evidence mapping, confidence, and open questions."),
    category: "research",
    delivery: text("HTML 报告、Markdown 摘要、sources/evidence JSON。", "HTML report, Markdown summary, sources/evidence JSON."),
    inputs: [
      field("topic", "text", text("研究主题", "Research topic"), true),
      field("sourceUrls", "multiline", text("来源 URL", "Source URLs"), false, text("每行一个公开来源。Standard 模式建议 20-40 个来源；少量来源也会生成证据缺口。", "One public source per line. Standard mode expects 20-40 sources; fewer sources still produce evidence gaps.")),
      field("notes", "textarea", text("已有笔记", "Existing notes"), false),
    ],
    outputKinds: ["html", "markdown", "json", "zip"],
    firstParty: true,
    localOnly: true,
    mutatesUserComputer: false,
  },
  {
    id: "html_slide_deck",
    title: text("PPT / HTML Slide Deck", "PPT / HTML Slide Deck"),
    description: text("生成可预览、可导出的 HTML 幻灯片，第一版覆盖 pitch、产品、调研、跨境选品、数据汇报。", "Generate previewable HTML slides covering pitch, product, research, cross-border selection, and data briefings."),
    category: "presentation",
    delivery: text("单文件 HTML deck、speaker notes、导出 zip。", "Single-file HTML deck, speaker notes, exportable zip."),
    inputs: [
      field("topic", "text", text("主题", "Topic"), true),
      selectField("template", text("模板", "Template"), [
        ["pitch", text("Pitch Deck", "Pitch Deck")],
        ["product", text("产品介绍", "Product Intro")],
        ["research", text("调研报告", "Research Brief")],
        ["cross_border", text("跨境选品报告", "Cross-border Selection")],
        ["data", text("数据分析汇报", "Data Briefing")],
      ], "pitch"),
      field("notes", "textarea", text("素材/要点", "Material / bullets"), false),
    ],
    outputKinds: ["html", "json", "zip"],
    firstParty: true,
    localOnly: true,
    mutatesUserComputer: false,
  },
  {
    id: "wechat_miniprogram",
    title: text("微信小程序源码包", "WeChat Mini Program Source"),
    description: text("生成可运行前端源码包，默认 touristappid，不处理登录、支付、上传、审核发布。", "Generate runnable frontend source with touristappid placeholder; no login, payment, upload, or review publishing."),
    category: "app",
    delivery: text("小程序目录、README、project.config.json、导出 zip。", "Mini Program directory, README, project.config.json, exportable zip."),
    inputs: [
      field("name", "text", text("小程序名称", "Mini Program name"), true),
      selectField("template", text("类型", "Type"), [
        ["landing", text("营销官网", "Marketing Landing")],
        ["catalog", text("商品展示", "Product Catalog")],
        ["content", text("内容/资料库", "Content Library")],
        ["tool", text("轻工具", "Lightweight Tool")],
      ], "landing"),
      field("notes", "textarea", text("页面和内容要求", "Pages and content requirements"), false),
    ],
    outputKinds: ["source", "readme", "json", "zip"],
    firstParty: true,
    localOnly: true,
    mutatesUserComputer: false,
  },
  {
    id: "guided_browser_automation",
    title: text("引导式浏览器自动化", "Guided Browser Automation"),
    description: text("生成用户可跟随的步骤包、验证点和 SOP；Friday 不替用户点击、输入或控制电脑。", "Generate guided steps, verification points, and SOPs; Friday never clicks, types, or controls the computer."),
    category: "automation",
    delivery: text("步骤包、SOP、验证清单、可保存为本地 pack。", "Step pack, SOP, verification checklist, saveable local pack."),
    inputs: [
      field("goal", "textarea", text("要引导完成的流程", "Workflow to guide"), true),
      field("site", "url", text("网站 URL（可选）", "Website URL (optional)"), false),
      field("constraints", "textarea", text("边界/注意事项", "Boundaries / constraints"), false),
    ],
    outputKinds: ["html", "json", "markdown", "zip"],
    firstParty: true,
    localOnly: true,
    mutatesUserComputer: false,
  },
  {
    id: "integration_builder",
    title: text("Integration Builder", "Integration Builder"),
    description: text("从 OpenAPI URL 或 curl 命令生成本地集成 pack、权限说明和测试请求。", "Generate a local integration pack, permission notes, and test request from an OpenAPI URL or curl command."),
    category: "integration",
    delivery: text("pack.json、README、测试请求、导出 zip。", "pack.json, README, test request, exportable zip."),
    inputs: [
      selectField("sourceType", text("来源类型", "Source type"), [
        ["openapi", text("OpenAPI URL", "OpenAPI URL")],
        ["curl", text("curl command", "curl command")],
      ], "openapi"),
      field("source", "textarea", text("OpenAPI URL 或 curl 命令", "OpenAPI URL or curl command"), true),
      field("name", "text", text("集成名称", "Integration name"), false),
    ],
    outputKinds: ["json", "markdown", "zip"],
    firstParty: true,
    localOnly: true,
    mutatesUserComputer: false,
  },
];

export function createFridayStudioService(
  deps: CreateFridayStudioServiceDeps = {},
): FridayStudioService {
  const workspaceRoot = deps.workspaceRoot ?? process.cwd();
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const fetchFn = deps.fetchFn ?? fetch;
  const studioRoot = path.join(workspaceRoot, ".friday", "studio");

  function runDir(runId: string): string {
    assertSafeId(runId);
    return path.join(studioRoot, "runs", runId);
  }

  function readRun(runId: string): FridayStudioRun {
    const filePath = path.join(runDir(runId), "run.json");
    if (!fs.existsSync(filePath)) {
      throw new FridayDomainError("NOT_FOUND", "Studio run not found", { httpStatus: 404 });
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as FridayStudioRun;
  }

  return {
    listProducts() {
      return STUDIO_PRODUCTS;
    },

    async runProduct(request) {
      const product = STUDIO_PRODUCTS.find((item) => item.id === request.productId);
      if (!product) {
        throw new FridayDomainError("VALIDATION_ERROR", "Unknown Studio product", { httpStatus: 400 });
      }

      const runId = crypto.randomUUID();
      const dir = runDir(runId);
      fs.mkdirSync(dir, { recursive: true });
      const createdAt = nowIso();
      let run: FridayStudioRun;

      try {
        const context: GeneratorContext = {
          product,
          inputs: request.inputs ?? {},
          runId,
          dir,
          createdAt,
          nowIso,
          fetchFn,
        };
        run = await generateProduct(context);
      } catch (error) {
        const errorMessage = redactStudioErrorMessage(product.id, error);
        run = {
          id: runId,
          productId: product.id,
          status: "failed",
          title: localTitle(product.title, request.locale),
          createdAt,
          completedAt: nowIso(),
          artifactRoot: dir,
          summary: text("生成失败。请检查输入后重试。", "Generation failed. Check the inputs and try again."),
          inputs: sanitizeStudioRunInputs(product.id, request.inputs ?? {}),
          artifacts: [],
          checks: [{
            id: "studio_run_failed",
            label: text("运行失败", "Run failed"),
            status: "failed",
            detail: text(errorMessage, errorMessage),
          }],
          nextActions: [text("修正输入并重新运行。", "Fix the inputs and run again.")],
          error: errorMessage,
        };
      }

      writeRun(dir, run);
      return run;
    },

    getRun(runId) {
      return readRun(runId);
    },

    getArtifact(runId, artifactId) {
      const run = readRun(runId);
      const artifact = run.artifacts.find((item) => item.id === artifactId);
      if (!artifact) {
        throw new FridayDomainError("NOT_FOUND", "Studio artifact not found", { httpStatus: 404 });
      }
      const fullPath = resolveArtifactPath(runDir(runId), artifact.relativePath);
      const bytes = fs.readFileSync(fullPath);
      const binary = !artifact.mimeType.startsWith("text/")
        && !artifact.mimeType.includes("json")
        && !artifact.mimeType.includes("markdown");
      return {
        artifact,
        content: binary ? bytes.toString("base64") : bytes.toString("utf8"),
        encoding: binary ? "base64" : "utf-8",
      };
    },

    exportRun(runId) {
      const run = readRun(runId);
      const dir = runDir(runId);
      const zipBytes = createZipFromDirectory(dir);
      return {
        fileName: `${slugify(run.title || run.productId)}-${run.id.slice(0, 8)}.zip`,
        mimeType: "application/zip",
        base64: zipBytes.toString("base64"),
        sizeBytes: zipBytes.byteLength,
      };
    },

    importLocalPack(request) {
      return importLocalStudioPack({
        request,
        importRoot: path.join(studioRoot, "imports"),
        nowIso,
      });
    },

    validateArtifactCandidate(runId) {
      const run = readRun(runId);
      const validation = validateStudioArtifactAsCandidate({ run });
      const rawCandidates = buildStudioArtifactCapabilityCandidate(validation, run.id);
      const candidates = rawCandidates.map((c) => ({
        id: c.id,
        capability: c.capability,
        sourceType: "studio_artifact" as const,
        trustTier: "generated" as const,
        label: c.label,
        description: c.description,
        risks: c.risks as string[],
        requiresApproval: true as const,
        requiresHuman: c.requiresHuman,
        rank: c.rank,
      }));
      return { validation, run, candidates };
    },
  };
}

interface GeneratorContext {
  product: FridayStudioProductSummary;
  inputs: Record<string, unknown>;
  runId: string;
  dir: string;
  createdAt: string;
  nowIso: () => string;
  fetchFn: typeof fetch;
}

async function generateProduct(ctx: GeneratorContext): Promise<FridayStudioRun> {
  switch (ctx.product.id) {
    case "seo_audit":
      return generateSeoAudit(ctx);
    case "research_report":
      return generateResearchReport(ctx);
    case "html_slide_deck":
      return generateSlideDeck(ctx);
    case "wechat_miniprogram":
      return generateWechatMiniProgram(ctx);
    case "guided_browser_automation":
      return generateGuidedBrowserAutomation(ctx);
    case "integration_builder":
      return generateIntegrationBuilder(ctx);
  }
}

async function generateSeoAudit(ctx: GeneratorContext): Promise<FridayStudioRun> {
  const url = readRequiredString(ctx.inputs, "url");
  const focus = readString(ctx.inputs, "focus");
  const parsedUrl = parsePublicHttpUrl(url);
  const response = await ctx.fetchFn(parsedUrl.toString(), { signal: AbortSignal.timeout(12_000) });
  const html = await response.text();
  const { document } = await parseHtml(html);
  const bodyText = normalizeWhitespace(document.body?.textContent ?? stripHtmlToText(html));
  const origin = parsedUrl.origin;
  const robots = await fetchOptionalText(ctx.fetchFn, `${origin}/robots.txt`);
  const sitemap = await fetchOptionalText(ctx.fetchFn, `${origin}/sitemap.xml`);
  const data = buildSeoAuditData(parsedUrl, response.status, document, html, bodyText, robots, sitemap, focus);
  const reportHtml = renderSeoAuditHtml(data);
  const evidence = JSON.stringify(data, null, 2) + "\n";
  const artifacts = [
    writeArtifact(ctx.dir, "report.html", reportHtml, "html_report", "html", "text/html", text("SEO 报告", "SEO report")),
    writeArtifact(ctx.dir, "evidence.json", evidence, "evidence_json", "json", "application/json", text("SEO 证据", "SEO evidence")),
  ];
  return baseRun(ctx, {
    title: `SEO Audit - ${parsedUrl.hostname}`,
    summary: text(`SEO 审计已完成，评分 ${data.score}/100。`, `SEO audit completed with score ${data.score}/100.`),
    artifacts,
    checks: data.checks.map((check) => ({
      id: check.id,
      label: text(check.labelZh, check.labelEn),
      status: check.status,
      detail: text(check.detailZh, check.detailEn),
    })),
    nextActions: data.recommendations.map((item) => text(item.zh, item.en)),
  });
}

async function generateResearchReport(ctx: GeneratorContext): Promise<FridayStudioRun> {
  const topic = readRequiredString(ctx.inputs, "topic");
  const sourceUrls = readLines(ctx.inputs, "sourceUrls").slice(0, 40);
  const notes = readString(ctx.inputs, "notes");
  const sources = [];
  for (const rawUrl of sourceUrls) {
    try {
      const url = parsePublicHttpUrl(rawUrl);
      const response = await ctx.fetchFn(url.toString(), { signal: AbortSignal.timeout(12_000) });
      const html = await response.text();
      const readable = await extractReadableContent(html, url.toString());
      sources.push({
        url: url.toString(),
        status: response.status,
        title: readable?.title ?? url.hostname,
        text: readable?.text ?? stripHtmlToText(html),
      });
    } catch (error) {
      sources.push({
        url: rawUrl,
        status: 0,
        title: rawUrl,
        text: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const data = buildResearchData(topic, sources, notes);
  const reportHtml = renderResearchHtml(data);
  const markdown = renderResearchMarkdown(data);
  const artifacts = [
    writeArtifact(ctx.dir, "report.html", reportHtml, "research_html", "html", "text/html", text("研究报告", "Research report")),
    writeArtifact(ctx.dir, "summary.md", markdown, "research_markdown", "markdown", "text/markdown", text("Markdown 摘要", "Markdown summary")),
    writeArtifact(ctx.dir, "evidence.json", JSON.stringify(data, null, 2) + "\n", "research_evidence", "json", "application/json", text("引用与证据表", "Sources and evidence map")),
  ];
  return baseRun(ctx, {
    title: `Research - ${topic}`,
    summary: text(`研究报告已生成，使用 ${data.sources.length} 个来源，证据声明 ${data.claims.length} 条。`, `Research report generated with ${data.sources.length} sources and ${data.claims.length} evidence-backed claims.`),
    artifacts,
    checks: [
      check("sources", sourceUrls.length >= 3 ? "passed" : "warning", "来源数量", "Source count", sourceUrls.length >= 3 ? "已提供可引用来源。" : "来源偏少，报告会标出证据缺口。", sourceUrls.length >= 3 ? "Citable sources were provided." : "Source count is low; the report marks evidence gaps."),
      check("citations", data.claims.length > 0 ? "passed" : "warning", "引用映射", "Citation map", "报告包含 claim/evidence map。", "Report includes a claim/evidence map."),
    ],
    nextActions: [
      text("补充更多公开来源可提高 standard 模式的置信度。", "Add more public sources to improve confidence in standard mode."),
      text("导出 zip 后可作为客户/团队交付件。", "Export the zip as a client or team deliverable."),
    ],
  });
}

function generateSlideDeck(ctx: GeneratorContext): FridayStudioRun {
  const topic = readRequiredString(ctx.inputs, "topic");
  const template = readString(ctx.inputs, "template") || "pitch";
  const notes = readString(ctx.inputs, "notes");
  const deck = buildSlideDeck(topic, template, notes);
  const artifacts = [
    writeArtifact(ctx.dir, "slides.html", renderSlidesHtml(deck), "slides_html", "html", "text/html", text("HTML 幻灯片", "HTML slide deck")),
    writeArtifact(ctx.dir, "deck.json", JSON.stringify(deck, null, 2) + "\n", "deck_json", "json", "application/json", text("幻灯片结构", "Deck structure")),
  ];
  return baseRun(ctx, {
    title: `Slides - ${topic}`,
    summary: text(`已生成 ${deck.slides.length} 页 HTML 幻灯片。`, `Generated ${deck.slides.length} HTML slides.`),
    artifacts,
    checks: [
      check("template", "passed", "模板", "Template", "已应用所选演示模板。", "Selected deck template applied."),
      check("offline", "passed", "离线预览", "Offline preview", "幻灯片为自包含 HTML/CSS/JS。", "Deck is self-contained HTML/CSS/JS."),
    ],
    nextActions: [text("打开 slides.html 预览并按方向键翻页。", "Open slides.html and use arrow keys to navigate.")],
  });
}

function generateWechatMiniProgram(ctx: GeneratorContext): FridayStudioRun {
  const name = readRequiredString(ctx.inputs, "name");
  const template = readString(ctx.inputs, "template") || "landing";
  const notes = readString(ctx.inputs, "notes");
  const files = buildMiniProgramFiles(name, template, notes);
  const sourceRoot = path.join(ctx.dir, "miniapp");
  for (const file of files) {
    writeFileEnsured(path.join(sourceRoot, file.relativePath), file.content);
  }
  const manifest = {
    appid: "touristappid",
    template,
    entry: "miniapp/project.config.json",
    generatedAt: ctx.createdAt,
    files: files.map((file) => file.relativePath),
  };
  const artifacts = [
    writeArtifact(ctx.dir, "miniapp-manifest.json", JSON.stringify(manifest, null, 2) + "\n", "miniapp_manifest", "json", "application/json", text("小程序清单", "Mini Program manifest")),
    artifactFromFile(ctx.dir, "miniapp/README.md", "miniapp_readme", "readme", "text/markdown", text("打开说明", "Open instructions")),
    artifactFromFile(ctx.dir, "miniapp/project.config.json", "miniapp_project_config", "source", "application/json", text("project.config.json", "project.config.json")),
    artifactFromFile(ctx.dir, "miniapp/app.json", "miniapp_app_config", "source", "application/json", text("app.json", "app.json")),
  ];
  return baseRun(ctx, {
    title: `Mini Program - ${name}`,
    summary: text("微信小程序前端源码包已生成，默认 touristappid。", "WeChat Mini Program frontend source generated with touristappid placeholder."),
    artifacts,
    checks: [
      check("source", "passed", "源码结构", "Source structure", "包含 app.js、app.json、app.wxss、pages 和 project.config.json。", "Includes app.js, app.json, app.wxss, pages, and project.config.json."),
      check("no_sensitive_ops", "passed", "发布边界", "Publishing boundary", "不处理登录、支付、上传、审核发布。", "No login, payment, upload, or review publishing is performed."),
    ],
    nextActions: [
      text("用微信开发者工具打开 miniapp 目录，并把 touristappid 替换为真实 AppID。", "Open the miniapp directory in WeChat DevTools and replace touristappid with the real AppID."),
    ],
  });
}

function generateGuidedBrowserAutomation(ctx: GeneratorContext): FridayStudioRun {
  const goal = readRequiredString(ctx.inputs, "goal");
  const site = readString(ctx.inputs, "site");
  const constraints = readString(ctx.inputs, "constraints");
  const plan = buildGuidedPlan(goal, site, constraints);
  const artifacts = [
    writeArtifact(ctx.dir, "guide.html", renderGuidedPlanHtml(plan), "guide_html", "html", "text/html", text("引导流程", "Guided workflow")),
    writeArtifact(ctx.dir, "sop.md", renderGuidedPlanMarkdown(plan), "guide_sop", "markdown", "text/markdown", text("SOP", "SOP")),
    writeArtifact(ctx.dir, "pack.json", JSON.stringify(plan, null, 2) + "\n", "guide_pack", "json", "application/json", text("步骤包", "Step pack")),
  ];
  return baseRun(ctx, {
    title: `Guide - ${goal.slice(0, 60)}`,
    summary: text("引导式浏览器步骤包已生成。Friday 不会替用户点击或输入。", "Guided browser step pack generated. Friday will not click or type for the user."),
    artifacts,
    checks: [
      check("read_only", "passed", "只读边界", "Read-only boundary", "步骤包只包含说明、验证点和用户动作。", "The step pack only includes instructions, verification points, and user-owned actions."),
      check("handoff", "passed", "人工接管", "Human-owned action", "登录、验证码、付款和敏感提交必须由用户完成。", "Login, CAPTCHA, payment, and sensitive submission must be completed by the user."),
    ],
    nextActions: [text("把步骤包保存为本地 pack，供下次复用。", "Save the step pack as a local pack for reuse.")],
  });
}

async function generateIntegrationBuilder(ctx: GeneratorContext): Promise<FridayStudioRun> {
  const sourceType = readString(ctx.inputs, "sourceType") || "openapi";
  const source = readRequiredString(ctx.inputs, "source");
  const name = readString(ctx.inputs, "name") || "Local Integration";
  const pack = sourceType === "curl"
    ? buildCurlIntegrationPack(name, source)
    : await buildOpenApiIntegrationPack(name, source, ctx.fetchFn);
  const artifacts = [
    writeArtifact(ctx.dir, "pack.json", JSON.stringify(pack, null, 2) + "\n", "integration_pack", "json", "application/json", text("集成 pack", "Integration pack")),
    writeArtifact(ctx.dir, "README.md", renderIntegrationReadme(pack), "integration_readme", "markdown", "text/markdown", text("集成说明", "Integration README")),
    writeArtifact(ctx.dir, "test-request.http", renderIntegrationHttpRequest(pack), "integration_test_request", "markdown", "text/plain", text("测试请求", "Test request")),
  ];
  return baseRun(ctx, {
    title: `Integration - ${pack.name}`,
    summary: text(`集成 pack 已生成，包含 ${pack.operations.length} 个候选操作。`, `Integration pack generated with ${pack.operations.length} candidate operations.`),
    artifacts,
    checks: [
      check("source", "passed", "来源解析", "Source parsing", "OpenAPI URL 或 curl 命令已解析为本地 pack。", "OpenAPI URL or curl command parsed into a local pack."),
      check("permissions", "warning", "权限", "Permissions", "真实密钥和认证方式需由用户配置。", "Real credentials and authentication must be configured by the user."),
    ],
    nextActions: [text("检查 pack.json 的权限说明，再配置真实 API key。", "Review pack.json permissions before configuring real API keys.")],
  });
}

function baseRun(ctx: GeneratorContext, input: Omit<FridayStudioRun, "id" | "productId" | "status" | "createdAt" | "completedAt" | "artifactRoot" | "inputs">): FridayStudioRun {
  return {
    id: ctx.runId,
    productId: ctx.product.id,
    status: "completed",
    createdAt: ctx.createdAt,
    completedAt: ctx.nowIso(),
    artifactRoot: ctx.dir,
    inputs: sanitizeStudioRunInputs(ctx.product.id, ctx.inputs),
    ...input,
  };
}

function buildSeoAuditData(
  url: URL,
  status: number,
  document: StudioDocument,
  html: string,
  bodyText: string,
  robots: string | undefined,
  sitemap: string | undefined,
  focus: string,
) {
  const title = normalizeWhitespace(document.querySelector("title")?.textContent ?? document.title ?? "");
  const metaDescription = attr(document, "meta[name='description']", "content");
  const h1s = document.querySelectorAll("h1").map((item) => normalizeWhitespace(item.textContent ?? "")).filter(Boolean);
  const canonical = attr(document, "link[rel='canonical']", "href");
  const viewport = attr(document, "meta[name='viewport']", "content");
  const robotsMeta = attr(document, "meta[name='robots']", "content");
  const jsonLdCount = document.querySelectorAll("script[type='application/ld+json']").length;
  const images = document.querySelectorAll("img");
  const imagesMissingAlt = images.filter((img) => !img.getAttribute("alt")?.trim()).length;
  const links = document.querySelectorAll("a[href]");
  const internalLinks = links.filter((link) => {
    const href = link.getAttribute("href") ?? "";
    try {
      const parsed = new URL(href, url);
      return parsed.hostname === url.hostname;
    } catch {
      return false;
    }
  }).length;
  const lower = html.toLowerCase();
  const platformSignals = {
    shopify: lower.includes("cdn.shopify.com") || lower.includes("shopify.theme") || lower.includes("myshopify.com"),
    amazon: url.hostname.includes("amazon.") || lower.includes("dp/") || lower.includes("buybox"),
    tiktok: lower.includes("tiktok") || lower.includes("ttq.load") || lower.includes("analytics.tiktok.com"),
  };
  const checks = [
    seoCheck("status", status >= 200 && status < 400, "HTTP 状态", "HTTP status", `状态码 ${status}`, `Status ${status}`),
    seoCheck("title", title.length >= 20 && title.length <= 65, "标题长度", "Title length", title ? `${title.length} 字符` : "缺少 title", title ? `${title.length} characters` : "Missing title"),
    seoCheck("description", metaDescription.length >= 70 && metaDescription.length <= 170, "Meta 描述", "Meta description", metaDescription ? `${metaDescription.length} 字符` : "缺少 meta description", metaDescription ? `${metaDescription.length} characters` : "Missing meta description"),
    seoCheck("h1", h1s.length === 1, "H1", "H1", `检测到 ${h1s.length} 个 H1`, `${h1s.length} H1 tags found`),
    seoCheck("canonical", Boolean(canonical), "Canonical", "Canonical", canonical || "缺少 canonical", canonical || "Missing canonical"),
    seoCheck("viewport", Boolean(viewport), "移动端视口", "Mobile viewport", viewport || "缺少 viewport", viewport || "Missing viewport"),
    seoCheck("robots", robots !== undefined, "robots.txt", "robots.txt", robots === undefined ? "未找到 robots.txt" : "已找到 robots.txt", robots === undefined ? "robots.txt not found" : "robots.txt found"),
    seoCheck("sitemap", sitemap !== undefined, "sitemap.xml", "sitemap.xml", sitemap === undefined ? "未找到 sitemap.xml" : "已找到 sitemap.xml", sitemap === undefined ? "sitemap.xml not found" : "sitemap.xml found"),
    seoCheck("structured_data", jsonLdCount > 0, "结构化数据", "Structured data", `JSON-LD 数量 ${jsonLdCount}`, `${jsonLdCount} JSON-LD blocks`),
    seoCheck("image_alt", imagesMissingAlt === 0, "图片 alt", "Image alt text", `${imagesMissingAlt}/${images.length} 图片缺 alt`, `${imagesMissingAlt}/${images.length} images missing alt`),
    seoCheck("internal_links", internalLinks >= 3, "内部链接", "Internal links", `内部链接 ${internalLinks} 个`, `${internalLinks} internal links`),
    seoCheck("content_depth", bodyText.length >= 600, "内容深度", "Content depth", `正文约 ${bodyText.length} 字符`, `Body text about ${bodyText.length} chars`),
    seoCheck("shopify", focus.toLowerCase().includes("shopify") ? platformSignals.shopify : true, "Shopify 信号", "Shopify signal", platformSignals.shopify ? "检测到 Shopify 信号" : "未检测到 Shopify 信号", platformSignals.shopify ? "Shopify signal found" : "No Shopify signal found"),
    seoCheck("amazon", focus.toLowerCase().includes("amazon") ? platformSignals.amazon : true, "Amazon 信号", "Amazon signal", platformSignals.amazon ? "检测到 Amazon/listing 信号" : "未检测到 Amazon/listing 信号", platformSignals.amazon ? "Amazon/listing signal found" : "No Amazon/listing signal found"),
    seoCheck("tiktok", focus.toLowerCase().includes("tiktok") ? platformSignals.tiktok : true, "TikTok 信号", "TikTok signal", platformSignals.tiktok ? "检测到 TikTok 信号" : "未检测到 TikTok 信号", platformSignals.tiktok ? "TikTok signal found" : "No TikTok signal found"),
  ];
  const passed = checks.filter((check) => check.status === "passed").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  const score = Math.max(0, Math.min(100, Math.round((passed / checks.length) * 100 - warnings * 1.5)));
  const recommendations = checks
    .filter((check) => check.status !== "passed")
    .slice(0, 8)
    .map((check) => ({
      zh: `修复：${check.labelZh} - ${check.detailZh}`,
      en: `Fix: ${check.labelEn} - ${check.detailEn}`,
    }));
  return {
    url: url.toString(),
    status,
    title,
    metaDescription,
    h1s,
    canonical,
    viewport,
    robotsMeta,
    jsonLdCount,
    images: images.length,
    imagesMissingAlt,
    internalLinks,
    bodyTextLength: bodyText.length,
    platformSignals,
    score,
    checks,
    recommendations,
  };
}

function buildResearchData(topic: string, sources: Array<{ url: string; status: number; title: string; text: string; error?: string }>, notes: string) {
  const usableSources = sources.filter((source) => source.text.trim().length > 0);
  const claims = usableSources.slice(0, 12).map((source, index) => {
    const sentence = firstUsefulSentence(source.text) || `Source ${index + 1} discusses ${topic}.`;
    return {
      id: `claim_${index + 1}`,
      claim: sentence,
      evidence: [{
        sourceUrl: source.url,
        sourceTitle: source.title,
        quote: sentence.slice(0, 240),
      }],
      confidence: source.status >= 200 && source.status < 400 ? "medium" : "low",
    };
  });
  if (notes.trim()) {
    claims.unshift({
      id: "claim_notes_1",
      claim: firstUsefulSentence(notes) || notes.slice(0, 220),
      evidence: [{ sourceUrl: "user-notes", sourceTitle: "User notes", quote: notes.slice(0, 240) }],
      confidence: "medium",
    });
  }
  return {
    topic,
    mode: "standard",
    generatedAt: new Date().toISOString(),
    sources: sources.map((source) => ({
      url: source.url,
      status: source.status,
      title: source.title,
      ok: source.text.trim().length > 0,
      error: source.error,
    })),
    claims,
    synthesis: claims.length
      ? `This standard report for "${topic}" is grounded in ${usableSources.length} fetched source(s) plus provided notes.`
      : `This report for "${topic}" needs more public sources before strong conclusions can be made.`,
    openQuestions: [
      "Which sources are authoritative enough to cite externally?",
      "Which claims need primary-source confirmation?",
      "What decision will this report support?",
    ],
  };
}

function buildSlideDeck(topic: string, template: string, notes: string) {
  const templateTitles: Record<string, string[]> = {
    pitch: ["Problem", "Audience", "Solution", "Why Now", "Business Model", "Next Step"],
    product: ["Overview", "User Need", "Product Flow", "Key Features", "Proof", "Roadmap"],
    research: ["Question", "Method", "Findings", "Evidence", "Implications", "Open Questions"],
    cross_border: ["Market", "Customer", "Product Angle", "Channel", "Risks", "Launch Plan"],
    data: ["Goal", "Dataset", "Trend", "Segment", "Action", "Decision"],
  };
  const lines = notes ? readLines({ notes }, "notes") : [];
  const titles = templateTitles[template] ?? templateTitles.pitch!;
  return {
    topic,
    template,
    slides: titles.map((title, index) => ({
      title,
      bullets: [
        lines[index] ?? `${title} for ${topic}`,
        index === 0 ? "Frame the audience and decision." : "Keep the message specific and evidence-backed.",
        "Replace this draft with verified details before external delivery.",
      ],
      speakerNote: `Explain ${title.toLowerCase()} in plain language.`,
    })),
  };
}

function buildMiniProgramFiles(name: string, template: string, notes: string): Array<{ relativePath: string; content: string }> {
  const pageTitle = template === "catalog" ? "商品展示" : template === "content" ? "资料库" : template === "tool" ? "轻工具" : "首页";
  const feature = notes || "用真实文案、图片和业务信息替换这里的占位内容。";
  return [
    ["README.md", `# ${name}\n\n这是 Friday 生成的微信小程序前端源码包。\n\n## 打开方式\n\n1. 安装并打开微信开发者工具。\n2. 选择导入项目，项目目录选择本文件夹。\n3. 默认 AppID 是 \`touristappid\`，请替换为你自己的真实 AppID。\n4. 本包不包含登录、支付、上传、审核发布流程。\n\n## 文件结构\n\n- \`app.js\` 小程序逻辑\n- \`app.json\` 全局配置\n- \`app.wxss\` 全局样式\n- \`pages/index/index.*\` 首页\n- \`sitemap.json\` 微信搜索索引配置\n`],
    ["project.config.json", JSON.stringify({
      appid: "touristappid",
      projectname: slugify(name),
      miniprogramRoot: "./",
      compileType: "miniprogram",
      setting: {
        es6: true,
        minified: true,
        postcss: true,
      },
    }, null, 2) + "\n"],
    ["app.js", "App({\n  globalData: {}\n});\n"],
    ["app.json", JSON.stringify({
      pages: ["pages/index/index"],
      window: {
        navigationBarTitleText: name,
        navigationBarBackgroundColor: "#111827",
        navigationBarTextStyle: "white",
        backgroundColor: "#f8fafc",
      },
      sitemapLocation: "sitemap.json",
    }, null, 2) + "\n"],
    ["app.wxss", "page { background: #f8fafc; color: #111827; font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; }\n.container { padding: 40rpx 32rpx; }\n.hero { border-radius: 20rpx; background: #ffffff; padding: 36rpx; box-shadow: 0 12rpx 36rpx rgba(15, 23, 42, 0.08); }\n.title { font-size: 44rpx; font-weight: 700; }\n.body { margin-top: 20rpx; color: #475569; line-height: 1.7; }\n"],
    ["sitemap.json", JSON.stringify({
      rules: [{ action: "allow", page: "*" }],
    }, null, 2) + "\n"],
    ["pages/index/index.json", JSON.stringify({ navigationBarTitleText: pageTitle }, null, 2) + "\n"],
    ["pages/index/index.js", `Page({\n  data: {\n    title: ${JSON.stringify(name)},\n    subtitle: ${JSON.stringify(pageTitle)},\n    body: ${JSON.stringify(feature)}\n  }\n});\n`],
    ["pages/index/index.wxml", "<view class=\"container\">\n  <view class=\"hero\">\n    <view class=\"eyebrow\">{{subtitle}}</view>\n    <view class=\"title\">{{title}}</view>\n    <view class=\"body\">{{body}}</view>\n  </view>\n</view>\n"],
    ["pages/index/index.wxss", ".eyebrow { color: #2563eb; font-size: 24rpx; font-weight: 600; margin-bottom: 14rpx; }\n"],
  ].map(([relativePath, content]) => ({ relativePath, content }));
}

function buildGuidedPlan(goal: string, site: string, constraints: string) {
  return {
    schemaVersion: "friday.studio.guided_browser.v1",
    goal,
    site,
    constraints,
    mutatesUserComputer: false,
    policy: {
      fridayMay: ["read instructions", "show overlays", "ask the user to confirm", "verify visible progress"],
      fridayMustNot: ["click", "type", "submit forms", "use logged-in pages", "solve CAPTCHA", "make payments"],
    },
    steps: [
      { index: 1, title: "Open the target", userAction: site ? `Open ${site}` : "Open the target website manually.", verification: "The expected page is visible." },
      { index: 2, title: "Identify the next control", userAction: "Read Friday's highlighted instruction and choose the matching visible control.", verification: "The control label and page context match the goal." },
      { index: 3, title: "Human-owned action", userAction: "You click or type. Friday only waits and verifies.", verification: "No sensitive action happened without user confirmation." },
      { index: 4, title: "Record reusable SOP", userAction: "Save the verified path as a local pack if it worked.", verification: "The pack contains steps, boundaries, and acceptance checks." },
    ],
  };
}

async function buildOpenApiIntegrationPack(name: string, source: string, fetchFn: typeof fetch) {
  const url = parsePublicHttpUrl(source);
  const response = await fetchFn(url.toString(), { signal: AbortSignal.timeout(12_000) });
  const spec = await response.json() as Record<string, unknown>;
  const paths = spec.paths && typeof spec.paths === "object" ? spec.paths as Record<string, unknown> : {};
  const operations = [];
  for (const [apiPath, methods] of Object.entries(paths).slice(0, 30)) {
    if (!methods || typeof methods !== "object") continue;
    for (const method of Object.keys(methods as Record<string, unknown>)) {
      operations.push({ method: method.toUpperCase(), path: apiPath, source: "openapi" });
    }
  }
  return {
    schemaVersion: "friday.studio.integration_pack.v1",
    name,
    sourceType: "openapi",
    source: redactIntegrationSourceText(source),
    title: typeof spec.info === "object" && spec.info && "title" in spec.info ? String((spec.info as { title?: unknown }).title ?? name) : name,
    permissions: ["network.request", "secret.read:api_key"],
    operations,
  };
}

function buildCurlIntegrationPack(name: string, source: string) {
  const parsed = parseSimpleCurl(source);
  const redactedUrl = redactIntegrationUrl(parsed.url);
  const needsApiKey = parsed.headers.some((header) => /authorization|api-key|token/i.test(header.name))
    || integrationUrlHasCredentialRisk(parsed.url);
  return {
    schemaVersion: "friday.studio.integration_pack.v1",
    name,
    sourceType: "curl",
    source: redactIntegrationSourceText(source),
    title: name,
    permissions: ["network.request", ...(needsApiKey ? ["secret.read:api_key"] : [])],
    operations: [{
      method: parsed.method,
      url: redactedUrl,
      headers: parsed.headers.map((header) => header.name),
      body: parsed.body ? "present" : "none",
      source: "curl",
    }],
  };
}

function parseSimpleCurl(source: string): { method: string; url: string; headers: Array<{ name: string; value: string }>; body?: string } {
  const tokens = source.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? [];
  if (tokens[0] !== "curl") {
    throw new FridayDomainError("VALIDATION_ERROR", "curl command must start with curl", { httpStatus: 400 });
  }
  let method = "GET";
  let url = "";
  const headers: Array<{ name: string; value: string }> = [];
  let body: string | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if ((token === "-X" || token === "--request") && tokens[i + 1]) {
      method = tokens[++i]!.toUpperCase();
    } else if ((token === "-H" || token === "--header") && tokens[i + 1]) {
      const raw = tokens[++i]!;
      const split = raw.indexOf(":");
      if (split > 0) headers.push({ name: raw.slice(0, split).trim(), value: raw.slice(split + 1).trim() });
    } else if ((token === "-d" || token === "--data" || token === "--data-raw") && tokens[i + 1]) {
      body = tokens[++i]!;
      if (method === "GET") method = "POST";
    } else if (!token.startsWith("-") && /^https?:\/\//i.test(token)) {
      url = token;
    }
  }
  if (!url) {
    throw new FridayDomainError("VALIDATION_ERROR", "curl command must include an http(s) URL", { httpStatus: 400 });
  }
  parsePublicHttpUrl(url);
  return { method, url, headers, body };
}

function sanitizeStudioRunInputs(productId: FridayStudioProductId, inputs: Record<string, unknown>): Record<string, unknown> {
  if (productId !== "integration_builder") {
    return inputs;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    sanitized[key] = sanitizeStudioInputValue(value);
  }
  return sanitized;
}

function sanitizeStudioInputValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactIntegrationSourceText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStudioInputValue(item));
  }
  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = sanitizeStudioInputValue(item);
    }
    return sanitized;
  }
  return value;
}

function redactStudioErrorMessage(productId: FridayStudioProductId, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return productId === "integration_builder" ? redactIntegrationSourceText(message) : message;
}

function redactIntegrationUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = url.username ? "redacted" : "";
    url.password = url.password ? "redacted" : "";
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveIntegrationKey(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function redactIntegrationSourceText(value: string): string {
  return redactIntegrationUrlsInText(value)
    .replace(/\b(Authorization\s*:\s*)[^\r\n'"]+/gi, "$1[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{4,}/gi, "$1[redacted]")
    .replace(/\b((?:X-)?API-Key\s*:\s*)[^\s'"]+/gi, "$1[redacted]")
    .replace(/\b((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\s*[=:]\s*)[^\s'\"&]+/gi, "$1[redacted]")
    .replace(/([?&](?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|credential)=)[^&\s'"]+/gi, "$1[redacted]");
}

function isSensitiveIntegrationKey(key: string): boolean {
  return /^(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|bearer|credential|key|password|refresh[_-]?token|secret|session|token)$/i.test(key);
}

function integrationUrlHasCredentialRisk(raw: string): boolean {
  try {
    const url = new URL(raw);
    return Boolean(url.username || url.password || [...url.searchParams.keys()].some((key) => isSensitiveIntegrationKey(key)));
  } catch {
    return false;
  }
}

function redactIntegrationUrlsInText(value: string): string {
  return value.replace(/https?:\/\/[^\s'")<>]+/gi, (url) => redactIntegrationUrl(url));
}

function renderSeoAuditHtml(data: ReturnType<typeof buildSeoAuditData>): string {
  return renderHtmlDocument(`SEO Audit - ${escapeHtml(data.url)}`, `
    <section class="hero"><p class="eyebrow">Friday Studio</p><h1>SEO Audit</h1><p>${escapeHtml(data.url)}</p><strong class="score">${data.score}/100</strong></section>
    <section><h2>Checks</h2>${renderCheckList(data.checks)}</section>
    <section><h2>Signals</h2><pre>${escapeHtml(JSON.stringify(data.platformSignals, null, 2))}</pre></section>
    <section><h2>Recommendations</h2><ul>${data.recommendations.map((item) => `<li>${escapeHtml(item.en)}<br><span>${escapeHtml(item.zh)}</span></li>`).join("")}</ul></section>
  `);
}

function renderResearchHtml(data: ReturnType<typeof buildResearchData>): string {
  return renderHtmlDocument(`Research - ${escapeHtml(data.topic)}`, `
    <section class="hero"><p class="eyebrow">Friday Studio</p><h1>${escapeHtml(data.topic)}</h1><p>${escapeHtml(data.synthesis)}</p></section>
    <section><h2>Claims & Evidence</h2>${data.claims.map((claim) => `<article class="card"><h3>${escapeHtml(claim.claim)}</h3><p>Confidence: ${escapeHtml(claim.confidence)}</p><ul>${claim.evidence.map((evidence) => `<li><a href="${escapeHtml(evidence.sourceUrl)}">${escapeHtml(evidence.sourceTitle)}</a>: ${escapeHtml(evidence.quote)}</li>`).join("")}</ul></article>`).join("")}</section>
    <section><h2>Open Questions</h2><ul>${data.openQuestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>
  `);
}

function renderResearchMarkdown(data: ReturnType<typeof buildResearchData>): string {
  return `# ${data.topic}\n\n${data.synthesis}\n\n## Claims and Evidence\n\n${data.claims.map((claim) => `- ${claim.claim}\n  - Confidence: ${claim.confidence}\n  - Evidence: ${claim.evidence.map((evidence) => `${evidence.sourceTitle} (${evidence.sourceUrl})`).join(", ")}`).join("\n")}\n\n## Open Questions\n\n${data.openQuestions.map((item) => `- ${item}`).join("\n")}\n`;
}

function renderSlidesHtml(deck: ReturnType<typeof buildSlideDeck>): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(deck.topic)}</title>
<style>
body{margin:0;background:#0f172a;color:#f8fafc;font-family:Inter,system-ui,sans-serif}.slide{display:none;min-height:100vh;box-sizing:border-box;padding:8vh 10vw}.slide.active{display:flex;flex-direction:column;justify-content:center}h1{font-size:56px;margin:0 0 24px}li{font-size:26px;line-height:1.5;margin:12px 0}.meta{position:fixed;bottom:24px;right:32px;color:#94a3b8}.note{color:#cbd5e1;margin-top:28px}
</style></head>
<body>
${deck.slides.map((slide, index) => `<section class="slide${index === 0 ? " active" : ""}"><p>${index + 1}/${deck.slides.length}</p><h1>${escapeHtml(slide.title)}</h1><ul>${slide.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul><p class="note">${escapeHtml(slide.speakerNote)}</p></section>`).join("\n")}
<div class="meta">← →</div>
<script>const s=[...document.querySelectorAll('.slide')];let i=0;function show(n){s[i].classList.remove('active');i=(n+s.length)%s.length;s[i].classList.add('active')}addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' ')show(i+1);if(e.key==='ArrowLeft')show(i-1)});</script>
</body></html>`;
}

function renderGuidedPlanHtml(plan: ReturnType<typeof buildGuidedPlan>): string {
  return renderHtmlDocument(`Guide - ${escapeHtml(plan.goal)}`, `
    <section class="hero"><p class="eyebrow">Guided Browser Automation</p><h1>${escapeHtml(plan.goal)}</h1><p>Friday only guides. You own every real click, keystroke, and submission.</p></section>
    <section><h2>Steps</h2>${plan.steps.map((step) => `<article class="card"><h3>${step.index}. ${escapeHtml(step.title)}</h3><p><strong>User action:</strong> ${escapeHtml(step.userAction)}</p><p><strong>Verify:</strong> ${escapeHtml(step.verification)}</p></article>`).join("")}</section>
    <section><h2>Boundaries</h2><ul>${plan.policy.fridayMustNot.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>
  `);
}

function renderGuidedPlanMarkdown(plan: ReturnType<typeof buildGuidedPlan>): string {
  return `# ${plan.goal}\n\nFriday only guides. The user owns all real input.\n\n${plan.steps.map((step) => `## ${step.index}. ${step.title}\n\nUser action: ${step.userAction}\n\nVerify: ${step.verification}\n`).join("\n")}\n`;
}

function renderIntegrationReadme(pack: Awaited<ReturnType<typeof buildOpenApiIntegrationPack>> | ReturnType<typeof buildCurlIntegrationPack>): string {
  return `# ${pack.name}\n\nGenerated by Friday Studio Integration Builder.\n\n## Source\n\n- Type: ${pack.sourceType}\n- Source: ${pack.source}\n\n## Permissions\n\n${pack.permissions.map((permission) => `- ${permission}`).join("\n")}\n\n## Operations\n\n${pack.operations.map((operation) => `- ${JSON.stringify(operation)}`).join("\n")}\n`;
}

function renderIntegrationHttpRequest(pack: Awaited<ReturnType<typeof buildOpenApiIntegrationPack>> | ReturnType<typeof buildCurlIntegrationPack>): string {
  const first = pack.operations[0] as { method?: string; url?: string; path?: string } | undefined;
  if (!first) return "# No operation found\n";
  return `${first.method ?? "GET"} ${first.url ?? first.path ?? "/"}\nAuthorization: Bearer {{API_KEY}}\n`;
}

function renderHtmlDocument(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
body{margin:0;background:#f8fafc;color:#111827;font-family:Inter,system-ui,sans-serif}.hero{background:#111827;color:white;padding:56px 64px}.eyebrow{color:#93c5fd;text-transform:uppercase;letter-spacing:.08em}section{padding:36px 64px}.card{background:white;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin:16px 0}.score{font-size:56px}li{margin:10px 0;line-height:1.5}pre{background:#0f172a;color:#e2e8f0;padding:16px;border-radius:8px;overflow:auto}.passed{color:#047857}.warning{color:#b45309}.failed{color:#b91c1c}
</style></head><body>${body}</body></html>`;
}

function renderCheckList(checks: Array<{ labelEn: string; detailEn: string; status: string }>): string {
  return `<ul>${checks.map((check) => `<li class="${check.status}"><strong>${escapeHtml(check.labelEn)}</strong>: ${escapeHtml(check.detailEn)} (${check.status})</li>`).join("")}</ul>`;
}

function text(zh: string, en: string): FridayStudioLocalizedText {
  return { zh, en };
}

function field(key: string, type: FridayStudioInputField["type"], label: FridayStudioLocalizedText, required = false, help?: FridayStudioLocalizedText): FridayStudioInputField {
  return { key, type, label, required, help };
}

function selectField(key: string, label: FridayStudioLocalizedText, options: Array<[string, FridayStudioLocalizedText]>, defaultValue: string): FridayStudioInputField {
  return {
    key,
    type: "select",
    label,
    required: true,
    defaultValue,
    options: options.map(([value, optionLabel]) => ({ value, label: optionLabel })),
  };
}

function check(id: string, status: "passed" | "warning" | "failed", labelZh: string, labelEn: string, detailZh: string, detailEn: string): FridayStudioRun["checks"][number] {
  return { id, status, label: text(labelZh, labelEn), detail: text(detailZh, detailEn) };
}

function seoCheck(id: string, passed: boolean, labelZh: string, labelEn: string, detailZh: string, detailEn: string) {
  return { id, labelZh, labelEn, detailZh, detailEn, status: passed ? "passed" as const : "warning" as const };
}

function localTitle(title: FridayStudioLocalizedText, locale?: string): string {
  return locale === "zh" ? title.zh : title.en;
}

function readRequiredString(inputs: Record<string, unknown>, key: string): string {
  const value = readString(inputs, key);
  if (!value) {
    throw new FridayDomainError("VALIDATION_ERROR", `${key} is required`, { httpStatus: 400 });
  }
  return value;
}

function readString(inputs: Record<string, unknown>, key: string): string {
  const value = inputs[key];
  return typeof value === "string" ? value.trim() : "";
}

function readLines(inputs: Record<string, unknown>, key: string): string[] {
  return readString(inputs, key).split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

function parsePublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FridayDomainError("VALIDATION_ERROR", "URL must be valid", { httpStatus: 400 });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FridayDomainError("VALIDATION_ERROR", "Only http(s) URLs are supported", { httpStatus: 400 });
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "127.0.0.1" || host === "0.0.0.0" || host.startsWith("10.") || host.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new FridayDomainError("VALIDATION_ERROR", "Studio only audits public URLs in this product lane", { httpStatus: 400 });
  }
  return url;
}

async function parseHtml(html: string): Promise<{ document: StudioDocument }> {
  const linkedom = await import("linkedom");
  return linkedom.parseHTML(html) as unknown as { document: StudioDocument };
}

async function fetchOptionalText(fetchFn: typeof fetch, url: string): Promise<string | undefined> {
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    return await response.text();
  } catch {
    return undefined;
  }
}

function attr(document: StudioDocument, selector: string, name: string): string {
  return document.querySelector(selector)?.getAttribute(name)?.trim() ?? "";
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstUsefulSentence(textValue: string): string {
  const sentences = normalizeWhitespace(textValue).split(/(?<=[.!?。！？])\s+/);
  return sentences.find((sentence) => sentence.length >= 40 && sentence.length <= 260) ?? sentences[0] ?? "";
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "friday-studio";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function writeArtifact(
  dir: string,
  relativePath: string,
  content: string,
  id: string,
  kind: FridayStudioArtifact["kind"],
  mimeType: string,
  label: FridayStudioLocalizedText,
): FridayStudioArtifact {
  const fullPath = path.join(dir, relativePath);
  writeFileEnsured(fullPath, content);
  return artifactFromFile(dir, relativePath, id, kind, mimeType, label);
}

function artifactFromFile(
  dir: string,
  relativePath: string,
  id: string,
  kind: FridayStudioArtifact["kind"],
  mimeType: string,
  label: FridayStudioLocalizedText,
): FridayStudioArtifact {
  const fullPath = resolveArtifactPath(dir, relativePath);
  const stat = fs.statSync(fullPath);
  return {
    id,
    kind,
    label,
    relativePath,
    mimeType,
    sizeBytes: stat.size,
    previewable: mimeType.startsWith("text/") || mimeType.includes("json"),
  };
}

function writeFileEnsured(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeRun(dir: string, run: FridayStudioRun): void {
  writeFileEnsured(path.join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n");
}

function resolveArtifactPath(root: string, relativePath: string): string {
  const fullPath = path.resolve(root, relativePath);
  const resolvedRoot = path.resolve(root);
  if (!fullPath.startsWith(resolvedRoot + path.sep) && fullPath !== resolvedRoot) {
    throw new FridayDomainError("VALIDATION_ERROR", "Invalid artifact path", { httpStatus: 400 });
  }
  return fullPath;
}

function assertSafeId(value: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(value)) {
    throw new FridayDomainError("VALIDATION_ERROR", "Invalid Studio run id", { httpStatus: 400 });
  }
}

interface ImportLocalStudioPackInput {
  request: FridayStudioImportRequest;
  importRoot: string;
  nowIso: () => string;
}

interface ImportedLocalFile {
  relativePath: string;
  content: Buffer;
}

const MAX_IMPORT_FILES = 200;
const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_TOTAL_BYTES = 25 * 1024 * 1024;

function importLocalStudioPack(input: ImportLocalStudioPackInput): FridayStudioImportResponse {
  const importedAt = input.nowIso();
  const id = crypto.randomUUID();
  const files = input.request.kind === "directory"
    ? readDirectoryImportFiles(input.request)
    : readZipImportFiles(input.request);
  const normalized = normalizeImportedFiles(files);
  const rootPath = path.join(input.importRoot, id);

  for (const file of normalized) {
    writeBytesEnsured(resolveArtifactPath(rootPath, file.relativePath), file.content);
  }

  const packJsonFile = findPackJson(normalized);
  const packJson = packJsonFile ? parsePackJson(packJsonFile) : {};
  const inferredProductIds = inferProductIds(packJson);
  const pack: FridayStudioImportedPack = {
    id,
    name: readPackString(packJson, ["name", "title"], input.request.name || input.request.fileName || "Local Studio Pack"),
    description: readPackString(packJson, ["description", "summary", "goal"], "Imported local pack. Review the files before running it."),
    sourceKind: input.request.kind,
    importedAt,
    fileCount: normalized.length,
    rootPath,
    packJsonPath: packJsonFile?.relativePath,
    entryPrompts: readPackStringList(packJson, ["entryPrompts", "prompts"], packJson.goal ? [String(packJson.goal)] : []),
    productIds: inferredProductIds,
  };
  writeFileEnsured(path.join(rootPath, "friday-studio-import.json"), JSON.stringify(pack, null, 2) + "\n");

  return {
    pack,
    checks: [
      check("import_files", "passed", "文件导入", "File import", `已导入 ${normalized.length} 个文件。`, `${normalized.length} files imported.`),
      check(
        "pack_json",
        packJsonFile ? "passed" : "warning",
        "pack.json",
        "pack.json",
        packJsonFile ? `找到 ${packJsonFile.relativePath}` : "未找到 pack.json，已作为源码包导入。",
        packJsonFile ? `Found ${packJsonFile.relativePath}` : "No pack.json found; imported as a source bundle.",
      ),
      check("first_party_local", "passed", "本地优先", "Local-first", "导入结果只写入本机 .friday/studio/imports。", "Import only writes to local .friday/studio/imports."),
    ],
  };
}

function readDirectoryImportFiles(request: FridayStudioImportRequest): ImportedLocalFile[] {
  if (!Array.isArray(request.files) || request.files.length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", "files are required for directory import", { httpStatus: 400 });
  }
  return request.files.map((file) => ({
    relativePath: file.relativePath,
    content: file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8"),
  }));
}

function readZipImportFiles(request: FridayStudioImportRequest): ImportedLocalFile[] {
  if (!request.zipBase64?.trim()) {
    throw new FridayDomainError("VALIDATION_ERROR", "zipBase64 is required for zip import", { httpStatus: 400 });
  }
  return extractZipEntries(Buffer.from(request.zipBase64, "base64"));
}

function normalizeImportedFiles(files: ImportedLocalFile[]): ImportedLocalFile[] {
  if (files.length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", "Import must include at least one file", { httpStatus: 400 });
  }
  if (files.length > MAX_IMPORT_FILES) {
    throw new FridayDomainError("VALIDATION_ERROR", `Import is limited to ${MAX_IMPORT_FILES} files`, { httpStatus: 400 });
  }
  let totalBytes = 0;
  const seen = new Set<string>();
  return files
    .map((file) => {
      const relativePath = normalizeImportPath(file.relativePath);
      if (seen.has(relativePath)) {
        throw new FridayDomainError("VALIDATION_ERROR", `Duplicate import path: ${relativePath}`, { httpStatus: 400 });
      }
      seen.add(relativePath);
      if (file.content.byteLength > MAX_IMPORT_FILE_BYTES) {
        throw new FridayDomainError("VALIDATION_ERROR", `Import file too large: ${relativePath}`, { httpStatus: 400 });
      }
      totalBytes += file.content.byteLength;
      if (totalBytes > MAX_IMPORT_TOTAL_BYTES) {
        throw new FridayDomainError("VALIDATION_ERROR", "Import is too large", { httpStatus: 400 });
      }
      return { relativePath, content: file.content };
    })
    .filter((file) => !file.relativePath.endsWith("/"));
}

function normalizeImportPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").some((part) => part === "..")) {
    throw new FridayDomainError("VALIDATION_ERROR", "Invalid import file path", { httpStatus: 400 });
  }
  return normalized;
}

function findPackJson(files: ImportedLocalFile[]): ImportedLocalFile | undefined {
  return files
    .filter((file) => /(^|\/)(friday-pack|pack)\.json$/i.test(file.relativePath))
    .sort((a, b) => a.relativePath.split("/").length - b.relativePath.split("/").length)[0];
}

function parsePackJson(file: ImportedLocalFile): Record<string, unknown> {
  try {
    const parsed = JSON.parse(file.content.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("pack.json must contain an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Could not parse ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      { httpStatus: 400 },
    );
  }
}

function readPackString(pack: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = pack[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

function readPackStringList(pack: Record<string, unknown>, keys: string[], fallback: string[]): string[] {
  for (const key of keys) {
    const value = pack[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  }
  return fallback;
}

function inferProductIds(pack: Record<string, unknown>): FridayStudioProductId[] {
  const explicit = readPackStringList(pack, ["productIds", "products"], [])
    .filter((item): item is FridayStudioProductId => STUDIO_PRODUCTS.some((product) => product.id === item));
  if (explicit.length > 0) {
    return explicit;
  }
  const schemaVersion = typeof pack.schemaVersion === "string" ? pack.schemaVersion : "";
  if (schemaVersion.includes("guided_browser")) {
    return ["guided_browser_automation"];
  }
  if (schemaVersion.includes("integration_pack")) {
    return ["integration_builder"];
  }
  return [];
}

function extractZipEntries(zip: Buffer): ImportedLocalFile[] {
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = zip.readUInt32LE(eocdOffset + 16);
  const entries: ImportedLocalFile[] = [];
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) {
      throw new FridayDomainError("VALIDATION_ERROR", "Invalid zip central directory", { httpStatus: 400 });
    }
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const fileNameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localHeaderOffset = zip.readUInt32LE(cursor + 42);
    const fileName = zip.subarray(cursor + 46, cursor + 46 + fileNameLength).toString("utf8");
    cursor += 46 + fileNameLength + extraLength + commentLength;
    if (fileName.endsWith("/")) {
      continue;
    }
    if (uncompressedSize > MAX_IMPORT_FILE_BYTES) {
      throw new FridayDomainError("VALIDATION_ERROR", `Zip file too large: ${fileName}`, { httpStatus: 400 });
    }
    entries.push({
      relativePath: fileName,
      content: readZipEntryContent(zip, localHeaderOffset, compressedSize, method, fileName),
    });
  }
  return entries;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  for (let index = zip.length - 22; index >= Math.max(0, zip.length - 65_558); index--) {
    if (zip.readUInt32LE(index) === 0x06054b50) {
      return index;
    }
  }
  throw new FridayDomainError("VALIDATION_ERROR", "Invalid zip file", { httpStatus: 400 });
}

function readZipEntryContent(zip: Buffer, localHeaderOffset: number, compressedSize: number, method: number, fileName: string): Buffer {
  if (zip.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid zip local header: ${fileName}`, { httpStatus: 400 });
  }
  const fileNameLength = zip.readUInt16LE(localHeaderOffset + 26);
  const extraLength = zip.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressed = zip.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) {
    return Buffer.from(compressed);
  }
  if (method === 8) {
    return zlib.inflateRawSync(compressed);
  }
  throw new FridayDomainError("VALIDATION_ERROR", `Unsupported zip compression method ${method}: ${fileName}`, {
    httpStatus: 400,
  });
}

function writeBytesEnsured(filePath: string, content: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createZipFromDirectory(dir: string): Buffer {
  const files = listFilesRecursive(dir).filter((file) => !file.endsWith(".zip"));
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const filePath of files) {
    const relative = path.relative(dir, filePath).replaceAll(path.sep, "/");
    const name = Buffer.from(relative);
    const content = fs.readFileSync(filePath);
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localEntry = Buffer.concat([local, name, content]);
    localParts.push(localEntry);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, name]));
    offset += localEntry.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDir, end]);
}

function listFilesRecursive(dir: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      result.push(fullPath);
    }
  }
  return result;
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let c = index;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return c >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
