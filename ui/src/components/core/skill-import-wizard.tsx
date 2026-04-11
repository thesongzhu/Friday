import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Code2,
  Globe,
  Package,
  Video,
  X,
} from "lucide-react";
import { ActionButton, StatusPill } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import { skillsApi } from "@/lib/api/skills";
import type { ConverterInfo, ConvertResponse, ImportResponse } from "@/lib/api/types";

// ─── Props ───

export interface SkillImportWizardProps {
  open: boolean;
  onClose: () => void;
}

// ─── Converter display metadata ───

const CONVERTER_META: Record<string, { zhLabel: string; enLabel: string; icon: "package" | "code" | "globe" | "video" | "default" }> = {
  "friday-native-skill-package": { zhLabel: "Friday 原生包", enLabel: "Friday Native Package", icon: "package" },
  "friday-clawdbot-skill-md": { zhLabel: "ClawdBot Markdown", enLabel: "ClawdBot Markdown", icon: "default" },
  "friday-adk-skill": { zhLabel: "ADK 技能", enLabel: "ADK Skill", icon: "default" },
  "friday-n8n-node": { zhLabel: "n8n 工作流", enLabel: "n8n Workflow", icon: "default" },
  "friday-openai-gpt-action": { zhLabel: "OpenAI GPT Action", enLabel: "OpenAI GPT Action", icon: "default" },
  "friday-code-repo": { zhLabel: "代码仓库", enLabel: "Code Repository", icon: "code" },
  "friday-undocumented-api": { zhLabel: "API 发现", enLabel: "API Discovery", icon: "globe" },
  "friday-recording": { zhLabel: "桌面录制", enLabel: "Desktop Recording", icon: "video" },
};

function converterIcon(id: string) {
  const meta = CONVERTER_META[id];
  const cls = "h-5 w-5 shrink-0";
  switch (meta?.icon) {
    case "package": return <Package className={cls} />;
    case "code": return <Code2 className={cls} />;
    case "globe": return <Globe className={cls} />;
    case "video": return <Video className={cls} />;
    default: return <Package className={cls} />;
  }
}

function converterLabel(id: string, locale: "zh" | "en"): string {
  const meta = CONVERTER_META[id];
  if (!meta) return id;
  return locale === "zh" ? meta.zhLabel : meta.enLabel;
}

// ─── Quality score badge ───

function qualityTone(score: number): "success" | "warning" | "danger" {
  if (score >= 85) return "success";
  if (score >= 60) return "warning";
  return "danger";
}

// ─── Component ───

export function SkillImportWizard({ open, onClose }: SkillImportWizardProps) {
  const { locale } = useAppLocale();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [selectedConverterId, setSelectedConverterId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [convertResult, setConvertResult] = useState<ConvertResponse | null>(null);
  const [importResult, setImportResult] = useState<ImportResponse | null>(null);

  // ─── Queries / Mutations ───

  const convertersQuery = useQuery({
    queryKey: ["skills", "converters"],
    queryFn: () => skillsApi.listConverters(),
    enabled: open,
  });

  const convertMutation = useMutation({
    mutationFn: () =>
      skillsApi.convert({
        source: { uri: inputValue },
        formatHint: (selectedConverterId ?? "auto") as "auto",
      }),
    onSuccess: (data) => {
      setConvertResult(data);
    },
  });

  const importMutation = useMutation({
    mutationFn: () =>
      skillsApi.import({
        source: { uri: inputValue },
        formatHint: (selectedConverterId ?? "auto") as "auto",
        refreshRegistry: true,
      }),
    onSuccess: (data) => {
      setImportResult(data);
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });

  // ─── Navigation helpers ───

  function reset() {
    setStep(0);
    setSelectedConverterId(null);
    setInputValue("");
    setConvertResult(null);
    setImportResult(null);
    convertMutation.reset();
    importMutation.reset();
  }

  function handleClose() {
    reset();
    onClose();
  }

  function canGoNext(): boolean {
    if (step === 0) return selectedConverterId !== null;
    if (step === 1) return inputValue.trim().length > 0;
    if (step === 2) return convertResult !== null && !convertMutation.isPending;
    return false;
  }

  function handleNext() {
    if (step === 0 && selectedConverterId) {
      setStep(1);
    } else if (step === 1 && inputValue.trim()) {
      setStep(2);
      convertMutation.mutate();
    } else if (step === 2 && convertResult) {
      setStep(3);
    }
  }

  function handleBack() {
    if (step === 1) {
      setStep(0);
    } else if (step === 2) {
      setStep(1);
      setConvertResult(null);
      convertMutation.reset();
    } else if (step === 3) {
      setStep(2);
      setImportResult(null);
      importMutation.reset();
    }
  }

  if (!open) return null;

  // ─── Step renderers ───

  function renderStepIndicator() {
    return (
      <div className="flex items-center justify-center gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`h-2 rounded-full transition-all ${
              i === step
                ? "w-6 bg-[color:var(--color-accent)]"
                : i < step
                  ? "w-2 bg-[color:var(--color-accent)] opacity-50"
                  : "w-2 bg-[color:var(--color-border-soft)]"
            }`}
          />
        ))}
      </div>
    );
  }

  function renderStep0() {
    const converters = convertersQuery.data ?? [];
    return (
      <div className="space-y-4">
        <h3 className="text-base font-semibold text-[color:var(--color-text-primary)]">
          {localize(locale, "选择来源类型", "Choose Source Type")}
        </h3>
        {convertersQuery.isLoading && (
          <p className="text-sm text-[color:var(--color-text-tertiary)]">
            {localize(locale, "加载转换器...", "Loading converters...")}
          </p>
        )}
        {convertersQuery.isError && (
          <p className="text-sm text-[color:var(--color-text-danger)]">
            {localize(locale, "加载失败", "Failed to load converters")}
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {converters.map((c: ConverterInfo) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelectedConverterId(c.id)}
              className={`flex items-start gap-3 rounded-2xl border p-4 text-left transition ${
                selectedConverterId === c.id
                  ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-muted)]"
                  : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] hover:border-[color:var(--color-border-strong)]"
              }`}
            >
              <span className="mt-0.5 text-[color:var(--color-text-secondary)]">
                {converterIcon(c.id)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                  {converterLabel(c.id, locale)}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {c.sourceFormats.map((fmt) => (
                    <StatusPill key={fmt} tone="neutral">
                      {fmt}
                    </StatusPill>
                  ))}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  function renderStep1() {
    const isRecording = selectedConverterId === "friday-recording";

    return (
      <div className="space-y-4">
        <h3 className="text-base font-semibold text-[color:var(--color-text-primary)]">
          {localize(locale, "提供来源", "Provide Source")}
        </h3>
        {isRecording ? (
          <p className="text-sm text-[color:var(--color-text-secondary)]">
            {localize(
              locale,
              "桌面录制需要配套的桌面应用程序。请先安装并启动 Friday Recorder，然后在此导入录制文件。",
              "Desktop recording requires the companion desktop app. Please install and launch Friday Recorder first, then import the recording file here.",
            )}
          </p>
        ) : (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "来源地址", "Source URI")}
            </label>
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={
                selectedConverterId === "friday-native-skill-package"
                  ? localize(locale, "粘贴 URL 或文件路径", "Paste URL or file path")
                  : "https://github.com/..."
              }
              className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] px-3 py-2.5 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-tertiary)] focus:border-[color:var(--color-accent)] focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && canGoNext()) handleNext();
              }}
            />
          </div>
        )}
      </div>
    );
  }

  function renderStep2() {
    if (convertMutation.isPending) {
      return (
        <div className="space-y-4">
          <h3 className="text-base font-semibold text-[color:var(--color-text-primary)]">
            {localize(locale, "预览", "Preview")}
          </h3>
          <p className="text-sm text-[color:var(--color-text-tertiary)]">
            {localize(locale, "正在转换...", "Converting...")}
          </p>
        </div>
      );
    }

    if (convertMutation.isError) {
      return (
        <div className="space-y-4">
          <h3 className="text-base font-semibold text-[color:var(--color-text-primary)]">
            {localize(locale, "预览", "Preview")}
          </h3>
          <p className="text-sm text-[color:var(--color-text-danger)]">
            {localize(locale, "转换失败: ", "Conversion failed: ")}
            {convertMutation.error instanceof Error
              ? convertMutation.error.message
              : localize(locale, "未知错误", "Unknown error")}
          </p>
        </div>
      );
    }

    if (!convertResult) return null;

    const allIssues = convertResult.validation.flatMap((v) => v.issues);
    const errors = allIssues.filter((i) => i.severity === "error");
    const warnings = allIssues.filter((i) => i.severity === "warning");

    return (
      <div className="space-y-4">
        <h3 className="text-base font-semibold text-[color:var(--color-text-primary)]">
          {localize(locale, "预览", "Preview")}
        </h3>

        <div className="flex items-center gap-2">
          <StatusPill tone="neutral">
            {localize(locale, "格式: ", "Format: ")}{convertResult.detectedFormat}
          </StatusPill>
          <StatusPill tone="neutral">
            {localize(locale, "转换器: ", "Converter: ")}{convertResult.converterId}
          </StatusPill>
        </div>

        {convertResult.drafts.map((draft, idx) => {
          const draftWarnings = draft.warnings;
          return (
            <div
              key={draft.manifest.id ?? idx}
              className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                    {draft.manifest.name}
                  </p>
                  <p className="mt-0.5 text-xs text-[color:var(--color-text-secondary)]">
                    {draft.manifest.description}
                  </p>
                </div>
                <StatusPill tone="neutral">v{draft.manifest.version}</StatusPill>
              </div>
              {draftWarnings.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {draftWarnings.map((w, i) => (
                    <li key={i} className="text-xs text-[color:var(--color-text-warning)]">
                      {w}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}

        {(errors.length > 0 || warnings.length > 0) && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "验证问题", "Validation Issues")}
            </p>
            {errors.map((issue, i) => (
              <div key={`err-${i}`} className="rounded-lg border border-[color:var(--color-border-danger)] bg-[color:var(--color-bg-danger-subtle)] px-3 py-2 text-xs text-[color:var(--color-text-danger)]">
                <span className="font-semibold">[{issue.code}]</span> {issue.message}
                {issue.path && <span className="ml-1 opacity-70">({issue.path})</span>}
              </div>
            ))}
            {warnings.map((issue, i) => (
              <div key={`warn-${i}`} className="rounded-lg border border-[color:var(--color-border-warning)] bg-[color:var(--color-bg-warning-subtle)] px-3 py-2 text-xs text-[color:var(--color-text-warning)]">
                <span className="font-semibold">[{issue.code}]</span> {issue.message}
                {issue.path && <span className="ml-1 opacity-70">({issue.path})</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderStep3() {
    if (importMutation.isPending) {
      return (
        <div className="space-y-4">
          <h3 className="text-base font-semibold text-[color:var(--color-text-primary)]">
            {localize(locale, "安装中", "Installing")}
          </h3>
          <p className="text-sm text-[color:var(--color-text-tertiary)]">
            {localize(locale, "正在安装技能...", "Installing skills...")}
          </p>
        </div>
      );
    }

    if (importMutation.isError) {
      return (
        <div className="space-y-4">
          <h3 className="text-base font-semibold text-[color:var(--color-text-primary)]">
            {localize(locale, "安装失败", "Installation Failed")}
          </h3>
          <p className="text-sm text-[color:var(--color-text-danger)]">
            {importMutation.error instanceof Error
              ? importMutation.error.message
              : localize(locale, "未知错误", "Unknown error")}
          </p>
        </div>
      );
    }

    if (importResult) {
      const installed = importResult.imports.filter((i) => i.installed);
      return (
        <div className="space-y-4">
          <h3 className="text-base font-semibold text-[color:var(--color-text-primary)]">
            {localize(locale, "安装完成", "Installation Complete")}
          </h3>
          <div className="space-y-2">
            {installed.map((imp) => (
              <div
                key={imp.skillId}
                className="flex items-center gap-2 rounded-xl border border-[color:var(--color-border-success)] bg-[color:var(--color-bg-success-subtle)] px-3 py-2"
              >
                <StatusPill tone="success">
                  {localize(locale, "已安装", "installed")}
                </StatusPill>
                <span className="text-sm text-[color:var(--color-text-primary)]">{imp.skillId}</span>
              </div>
            ))}
            {installed.length === 0 && (
              <p className="text-sm text-[color:var(--color-text-warning)]">
                {localize(locale, "没有技能被安装", "No skills were installed")}
              </p>
            )}
          </div>
          <p className="text-xs text-[color:var(--color-text-tertiary)]">
            {localize(locale, "点击关闭或等待自动关闭", "Click close or wait for auto-close")}
          </p>
        </div>
      );
    }

    // Not yet submitted - show install button
    return (
      <div className="space-y-4">
        <h3 className="text-base font-semibold text-[color:var(--color-text-primary)]">
          {localize(locale, "确认并安装", "Confirm & Install")}
        </h3>
        <p className="text-sm text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            `将从 "${inputValue}" 导入 ${convertResult?.drafts.length ?? 0} 个技能。`,
            `Import ${convertResult?.drafts.length ?? 0} skill(s) from "${inputValue}".`,
          )}
        </p>
        <ActionButton
          tone="primary"
          onClick={() => importMutation.mutate()}
          disabled={importMutation.isPending}
        >
          {localize(locale, "安装", "Install")}
        </ActionButton>
      </div>
    );
  }

  // ─── Main render ───

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="relative mx-4 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[color:var(--color-border-soft)] px-6 py-4">
          <h2 className="text-lg font-semibold text-[color:var(--color-text-primary)]">
            {localize(locale, "导入技能", "Import Skill")}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg p-1 text-[color:var(--color-text-tertiary)] hover:bg-[color:var(--color-bg-hover)] hover:text-[color:var(--color-text-primary)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="px-6 pt-4">
          {renderStepIndicator()}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {step === 0 && renderStep0()}
          {step === 1 && renderStep1()}
          {step === 2 && renderStep2()}
          {step === 3 && renderStep3()}
        </div>

        {/* Footer navigation */}
        <div className="flex items-center justify-between border-t border-[color:var(--color-border-soft)] px-6 py-4">
          <button
            type="button"
            onClick={handleClose}
            className="text-sm text-[color:var(--color-text-tertiary)] hover:text-[color:var(--color-text-primary)]"
          >
            {localize(locale, "取消", "Cancel")}
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && step < 3 && (
              <ActionButton tone="secondary" onClick={handleBack}>
                {localize(locale, "上一步", "Back")}
              </ActionButton>
            )}
            {step < 3 && (
              <ActionButton
                tone="primary"
                onClick={handleNext}
                disabled={!canGoNext()}
              >
                {localize(locale, "下一步", "Next")}
              </ActionButton>
            )}
            {step === 3 && importResult && (
              <ActionButton tone="primary" onClick={handleClose}>
                {localize(locale, "关闭", "Close")}
              </ActionButton>
            )}
            {step === 3 && !importResult && !importMutation.isPending && (
              <ActionButton tone="secondary" onClick={handleBack}>
                {localize(locale, "上一步", "Back")}
              </ActionButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
