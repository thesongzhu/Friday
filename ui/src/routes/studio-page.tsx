import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileArchive,
  FolderOpen,
  Loader2,
  PlayCircle,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { useCustomPacks } from "@/hooks/use-custom-packs";
import { studioApi, type StudioArtifact, type StudioProductId, type StudioProductSummary, type StudioRun } from "@/lib/api/studio";
import { localize, resolveLocalizedText } from "@/lib/i18n/localized-text";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";

function productBadge(product: StudioProductSummary, locale: "zh" | "en"): string {
  const labels: Record<StudioProductSummary["category"], { zh: string; en: string }> = {
    audit: { zh: "审计", en: "Audit" },
    research: { zh: "研究", en: "Research" },
    presentation: { zh: "演示", en: "Slides" },
    app: { zh: "应用", en: "App" },
    automation: { zh: "引导", en: "Guide" },
    integration: { zh: "集成", en: "Integration" },
  };
  return locale === "zh" ? labels[product.category].zh : labels[product.category].en;
}

function defaultInputs(product?: StudioProductSummary): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of product?.inputs ?? []) {
    values[field.key] = field.defaultValue ?? "";
  }
  return values;
}

function downloadBase64File(fileName: string, mimeType: string, base64: string): void {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function StudioPage() {
  const { locale } = useAppLocale();
  const { createCustomPack } = useCustomPacks();
  const [selectedProductId, setSelectedProductId] = useState<StudioProductId>("seo_audit");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [currentRun, setCurrentRun] = useState<StudioRun | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const directoryInputRef = useRef<HTMLInputElement | null>(null);

  const productsQuery = useQuery({
    queryKey: ["studio", "products"],
    queryFn: () => studioApi.listProducts(),
  });

  const products = productsQuery.data?.products ?? [];
  const selectedProduct = useMemo(
    () => products.find((product) => product.id === selectedProductId) ?? products[0],
    [products, selectedProductId],
  );

  useEffect(() => {
    if (selectedProduct && selectedProduct.id !== selectedProductId) {
      setSelectedProductId(selectedProduct.id);
    }
  }, [selectedProduct, selectedProductId]);

  useEffect(() => {
    setInputs(defaultInputs(selectedProduct));
  }, [selectedProduct?.id]);

  useEffect(() => {
    const input = directoryInputRef.current;
    input?.setAttribute("webkitdirectory", "");
    input?.setAttribute("directory", "");
  }, []);

  const selectedArtifact = currentRun?.artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
  const artifactQuery = useQuery({
    queryKey: ["studio", "artifact", currentRun?.id, selectedArtifactId],
    queryFn: () => studioApi.getArtifact(currentRun!.id, selectedArtifactId!),
    enabled: Boolean(currentRun?.id && selectedArtifactId),
  });

  const runMutation = useMutation({
    mutationFn: () => {
      if (!selectedProduct) throw new Error("No product selected");
      return studioApi.createRun({
        productId: selectedProduct.id,
        inputs,
        locale,
      });
    },
    onSuccess: ({ run }) => {
      setCurrentRun(run);
      setSelectedArtifactId(run.artifacts.find((artifact) => artifact.previewable)?.id ?? run.artifacts[0]?.id ?? null);
      toast.success(localize(locale, "Studio 交付件已生成", "Studio deliverable generated"));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "生成失败", "Generation failed"));
    },
  });

  const exportMutation = useMutation({
    mutationFn: () => {
      if (!currentRun) throw new Error("No run selected");
      return studioApi.exportRun(currentRun.id);
    },
    onSuccess: (file) => {
      downloadBase64File(file.fileName, file.mimeType, file.base64);
      toast.success(localize(locale, "已导出 zip", "Zip exported"));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "导出失败", "Export failed"));
    },
  });

  const importMutation = useMutation({
    mutationFn: studioApi.importPack,
    onSuccess: ({ pack }) => {
      createCustomPack({
        name: pack.name,
        nameEn: pack.name,
        description: pack.description,
        descriptionEn: pack.description,
        skillIds: [],
        entryPrompts: pack.entryPrompts,
      });
      toast.success(localize(locale, "本地 pack 已导入任务库", "Local pack imported into your task library"));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "导入失败", "Import failed"));
    },
  });

  const canRun = Boolean(selectedProduct) && selectedProduct.inputs
    .filter((field) => field.required)
    .every((field) => inputs[field.key]?.trim());

  async function handleDirectoryImport(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    const payloadFiles = await Promise.all(Array.from(files).slice(0, 200).map(async (file) => {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      return { relativePath, content: await file.text(), encoding: "utf-8" as const };
    }));
    importMutation.mutate({ kind: "directory", files: payloadFiles, name: payloadFiles[0]?.relativePath.split("/")[0] });
  }

  async function handleZipImport(file: File | undefined): Promise<void> {
    if (!file) return;
    importMutation.mutate({
      kind: "zip",
      fileName: file.name,
      zipBase64: await fileToBase64(file),
    });
  }

  return (
    <div className="space-y-5 pb-4" data-testid="studio-surface-ready">
      <section className="rounded-[30px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-5 shadow-[var(--shadow-floating)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
              Friday Studio
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
              {localize(locale, "开箱即用的工作产品", "Ready-to-use work products")}
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                "选择一个交付入口，填写业务信息，然后直接得到报告、源码、幻灯片、步骤包或集成包。Studio 只使用本地运行时和公开网页审计，不会控制你的电脑。",
                "Pick a deliverable, add business context, and get a report, source package, slide deck, guide pack, or integration pack. Studio uses local runtime and public-page auditing only; it does not control your computer.",
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="success">{localize(locale, "First-party", "First-party")}</StatusPill>
            <StatusPill tone="success">{localize(locale, "本地优先", "Local-first")}</StatusPill>
            <StatusPill tone="neutral">{localize(locale, "本地运行", "Local runtime")}</StatusPill>
          </div>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(260px,0.9fr)_minmax(440px,1.2fr)_minmax(360px,1fr)]">
        <ShellCard title={localize(locale, "产品入口", "Product Entrypoints")}>
          {productsQuery.isLoading ? (
            <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4 text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "加载中…", "Loading...")}
            </div>
          ) : (
            <div className="space-y-2">
              {products.map((product) => {
                const active = product.id === selectedProduct?.id;
                return (
                  <button
                    type="button"
                    key={product.id}
                    onClick={() => {
                      setSelectedProductId(product.id);
                      setCurrentRun(null);
                      setSelectedArtifactId(null);
                    }}
                    className={cn(
                      "w-full rounded-2xl border px-4 py-3 text-left transition",
                      active
                        ? "border-[color:var(--color-accent)] bg-[color:var(--color-bg-surface-strong)]"
                        : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] hover:border-[color:var(--color-border-strong)]",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-sm font-semibold text-[color:var(--color-text-primary)]">
                        {resolveLocalizedText(product.title, locale)}
                      </h3>
                      <span className="rounded-full border border-[color:var(--color-border-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[color:var(--color-text-tertiary)]">
                        {productBadge(product, locale)}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                      {resolveLocalizedText(product.description, locale)}
                    </p>
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-5 rounded-2xl border border-dashed border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4">
            <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
              {localize(locale, "导入本地 pack", "Import local pack")}
            </p>
            <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-tertiary)]">
              {localize(locale, "支持目录和 zip；导入后会加入你的任务库。", "Supports directory and zip; imported packs are added to your task library.")}
            </p>
            <div className="mt-3 grid gap-2">
              <label className="inline-flex min-h-[40px] cursor-pointer items-center justify-center rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2 text-sm font-medium text-[color:var(--color-text-secondary)] hover:border-[color:var(--color-border-strong)]">
                <FolderOpen className="mr-2 h-4 w-4" />
                {localize(locale, "目录导入", "Directory")}
                <input
                  ref={directoryInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    void handleDirectoryImport(event.target.files);
                    event.target.value = "";
                  }}
                />
              </label>
              <label className="inline-flex min-h-[40px] cursor-pointer items-center justify-center rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2 text-sm font-medium text-[color:var(--color-text-secondary)] hover:border-[color:var(--color-border-strong)]">
                <FileArchive className="mr-2 h-4 w-4" />
                {localize(locale, "Zip 导入", "Zip")}
                <input
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  onChange={(event) => {
                    void handleZipImport(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </label>
            </div>
          </div>
        </ShellCard>

        <ShellCard
          title={selectedProduct ? resolveLocalizedText(selectedProduct.title, locale) : localize(locale, "生成交付件", "Generate Deliverable")}
          aside={selectedProduct ? <StatusPill tone="neutral">{resolveLocalizedText(selectedProduct.delivery, locale)}</StatusPill> : null}
        >
          <div className="space-y-4">
            {selectedProduct?.inputs.map((field) => (
              <label key={field.key} className="block">
                <span className="text-sm font-medium text-[color:var(--color-text-primary)]">
                  {resolveLocalizedText(field.label, locale)}
                  {field.required ? <span className="text-[color:var(--color-danger)]"> *</span> : null}
                </span>
                {field.help ? (
                  <span className="mt-1 block text-xs leading-5 text-[color:var(--color-text-tertiary)]">
                    {resolveLocalizedText(field.help, locale)}
                  </span>
                ) : null}
                {field.type === "select" ? (
                  <select
                    value={inputs[field.key] ?? field.defaultValue ?? ""}
                    onChange={(event) => setInputs((prev) => ({ ...prev, [field.key]: event.target.value }))}
                    className="mt-2 w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
                  >
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {resolveLocalizedText(option.label, locale)}
                      </option>
                    ))}
                  </select>
                ) : field.type === "textarea" || field.type === "multiline" ? (
                  <textarea
                    rows={field.type === "multiline" ? 6 : 4}
                    value={inputs[field.key] ?? ""}
                    onChange={(event) => setInputs((prev) => ({ ...prev, [field.key]: event.target.value }))}
                    className="mt-2 w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-sm leading-6 text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
                  />
                ) : (
                  <input
                    type={field.type === "url" ? "url" : "text"}
                    value={inputs[field.key] ?? ""}
                    onChange={(event) => setInputs((prev) => ({ ...prev, [field.key]: event.target.value }))}
                    className="mt-2 w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
                  />
                )}
              </label>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <ActionButton onClick={() => runMutation.mutate()} disabled={!canRun || runMutation.isPending}>
              {runMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-2 h-4 w-4" />}
              {localize(locale, "生成交付件", "Generate")}
            </ActionButton>
            {currentRun ? (
              <ActionButton tone="secondary" onClick={() => exportMutation.mutate()} disabled={exportMutation.isPending}>
                {exportMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                {localize(locale, "导出 zip", "Export zip")}
              </ActionButton>
            ) : null}
            {importMutation.isPending ? (
              <span className="inline-flex items-center text-xs text-[color:var(--color-text-tertiary)]">
                <Upload className="mr-2 h-4 w-4 animate-pulse" />
                {localize(locale, "正在导入…", "Importing...")}
              </span>
            ) : null}
          </div>
        </ShellCard>

        <ShellCard title={localize(locale, "结果和预览", "Result & Preview")}>
          {!currentRun ? (
            <div className="rounded-2xl border border-dashed border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-8 text-sm leading-6 text-[color:var(--color-text-secondary)]">
              {localize(locale, "生成后会在这里看到检查结果、文件列表和可预览 artifact。", "After generation, checks, files, and previewable artifacts appear here.")}
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-[color:var(--color-text-primary)]">{currentRun.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-[color:var(--color-text-secondary)]">
                      {resolveLocalizedText(currentRun.summary, locale)}
                    </p>
                  </div>
                  <StatusPill tone={currentRun.status === "completed" ? "success" : "danger"}>
                    {currentRun.status}
                  </StatusPill>
                </div>
              </div>

              <div className="space-y-2">
                {currentRun.checks.map((item) => (
                  <div key={item.id} className="flex gap-3 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2">
                    {item.status === "passed" ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-text-success)]" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-text-warning)]" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                        {resolveLocalizedText(item.label, locale)}
                      </p>
                      <p className="text-xs leading-5 text-[color:var(--color-text-secondary)]">
                        {resolveLocalizedText(item.detail, locale)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-2">
                {currentRun.artifacts.map((artifact) => (
                  <button
                    key={artifact.id}
                    type="button"
                    onClick={() => setSelectedArtifactId(artifact.id)}
                    className={cn(
                      "rounded-xl border px-3 py-2 text-xs font-medium transition",
                      artifact.id === selectedArtifactId
                        ? "border-[color:var(--color-accent)] bg-[color:var(--color-bg-surface-strong)] text-[color:var(--color-text-primary)]"
                        : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] text-[color:var(--color-text-secondary)]",
                    )}
                  >
                    {resolveLocalizedText(artifact.label, locale)}
                  </button>
                ))}
              </div>

              <ArtifactPreview
                artifact={selectedArtifact}
                loading={artifactQuery.isLoading}
                content={artifactQuery.data?.content}
                encoding={artifactQuery.data?.encoding}
              />
            </div>
          )}
        </ShellCard>
      </div>
    </div>
  );
}

function ArtifactPreview(props: {
  artifact: StudioArtifact | null;
  loading: boolean;
  content?: string;
  encoding?: "utf-8" | "base64";
}) {
  if (!props.artifact) return null;
  if (props.loading) {
    return (
      <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4 text-sm text-[color:var(--color-text-secondary)]">
        Loading artifact...
      </div>
    );
  }
  if (!props.content || props.encoding === "base64") {
    return (
      <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4 text-sm text-[color:var(--color-text-secondary)]">
        {props.artifact.relativePath}
      </div>
    );
  }
  if (props.artifact.mimeType === "text/html") {
    return (
      <iframe
        title={props.artifact.relativePath}
        srcDoc={props.content}
        sandbox=""
        className="h-[420px] w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-white"
      />
    );
  }
  return (
    <pre className="max-h-[420px] overflow-auto rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4 text-xs leading-5 text-[color:var(--color-text-secondary)]">
      {props.content}
    </pre>
  );
}
