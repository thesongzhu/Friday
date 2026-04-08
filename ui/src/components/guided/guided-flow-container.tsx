import type { ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";
import { resolveLocalizedText, type LocalizedText } from "@/lib/i18n/localized-text";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";
import { StepProgress, type StepProgressStep } from "./step-progress";

export interface GuidedFlowContainerProps {
  title: string | LocalizedText;
  steps: StepProgressStep[];
  currentStepIndex: number;
  children: ReactNode;
  onBack?: () => void;
  onCancel?: () => void;
  showBack?: boolean;
  showCancel?: boolean;
}

export function GuidedFlowContainer(props: GuidedFlowContainerProps) {
  const { locale } = useAppLocale();
  const {
    title,
    steps,
    currentStepIndex,
    children,
    onBack,
    onCancel,
    showBack = true,
    showCancel = true,
  } = props;
  const titleText = typeof title === "string" ? null : title;
  const titleLabel = typeof title === "string" ? title : resolveLocalizedText(title, locale);

  const showSidebar = locale === "zh" && steps.length > 1;

  return (
    <div className={cn("mx-auto w-full space-y-5", showSidebar ? "max-w-5xl" : "max-w-3xl")}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          {showBack && onBack && currentStepIndex > 0 && (
            <button
              type="button"
              onClick={onBack}
              className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-2 text-[color:var(--color-text-secondary)] transition hover:bg-[color:var(--color-bg-surface-strong)] hover:text-[color:var(--color-text-primary)]"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <h2 className="text-lg font-semibold text-[color:var(--color-text-primary)]">
            {titleText ? resolveLocalizedText(titleText, locale) : titleLabel}
          </h2>
        </div>
        {showCancel && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-2 text-[color:var(--color-text-faint)] transition hover:bg-[color:var(--color-bg-surface-strong)] hover:text-[color:var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {steps.length > 1 && !showSidebar && (
        <StepProgress steps={steps} orientation="horizontal" />
      )}

      <div className={cn("transition-opacity duration-200", showSidebar && "flex gap-6")}>
        {showSidebar && (
          <aside className="hidden w-[180px] shrink-0 pt-1 lg:block">
            <StepProgress steps={steps} orientation="vertical" />
          </aside>
        )}
        <div className={cn(showSidebar && "min-w-0 flex-1")}>
          {showSidebar && (
            <div className="mb-4 lg:hidden">
              <StepProgress steps={steps} orientation="horizontal" />
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
