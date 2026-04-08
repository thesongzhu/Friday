import { ArrowRight, GripVertical, Pin, Play, ShieldCheck, Sparkles, X } from "lucide-react";
import { ActionButton } from "@/components/core/primitives";
import { resolveLocalizedText } from "@/lib/i18n/localized-text";
import type { FridayPackDefinition } from "@/lib/packs/pack-registry";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";

export interface PackCardProps {
  pack: FridayPackDefinition;
  note?: string;
  statusLabel?: string;
  pinned?: boolean;
  compact?: boolean;
  onOpen: () => void;
  onPin?: () => void;
  onUnpin?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

export function PackCard(props: PackCardProps) {
  const { locale } = useAppLocale();
  const title = resolveLocalizedText(props.pack.title, locale);
  const summary = resolveLocalizedText(props.pack.summary, locale);

  return (
    <div
      data-testid={`pack-card-${props.pack.id}`}
      className={cn(
        "rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4 shadow-[var(--shadow-floating)]",
        props.compact ? "space-y-3" : "space-y-4",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-2.5 text-[color:var(--color-accent)]">
          <props.pack.icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-[color:var(--color-text-primary)]">{title}</h3>
                {locale === "zh" && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-[color:var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--color-accent)]">
                    <ShieldCheck className="h-3 w-3" />
                    官方
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">{summary}</p>
            </div>
            {props.pinned ? (
              <span className="inline-flex min-h-[28px] items-center rounded-full border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] px-2.5 text-[11px] font-semibold text-[color:var(--color-text-primary)]">
                <Pin className="mr-1 h-3.5 w-3.5" />
                {locale === "zh" ? "已加入首页" : "Pinned"}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {props.note || props.statusLabel ? (
        <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2.5">
          {props.statusLabel ? (
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--color-text-faint)]">
              {props.statusLabel}
            </p>
          ) : null}
          {props.note ? (
            <p className={cn("text-xs leading-5 text-[color:var(--color-text-secondary)]", props.statusLabel && "mt-1")}>
              {props.note}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <ActionButton data-testid={`pack-open-${props.pack.id}`} onClick={props.onOpen} className="flex-1 min-w-[148px]">
          <Sparkles className="mr-2 h-4 w-4" />
          {locale === "zh" ? "打开动作" : "Open Actions"}
        </ActionButton>
        {props.onPin ? (
          <ActionButton data-testid={`pack-pin-${props.pack.id}`} tone="secondary" onClick={props.onPin}>
            <Play className="mr-2 h-4 w-4" />
            {locale === "zh" ? "加入首页" : "Add To Home"}
          </ActionButton>
        ) : null}
        {props.onUnpin ? (
          <ActionButton data-testid={`pack-unpin-${props.pack.id}`} tone="secondary" onClick={props.onUnpin}>
            <X className="mr-2 h-4 w-4" />
            {locale === "zh" ? "拿下首页" : "Remove"}
          </ActionButton>
        ) : null}
        {props.onMoveUp ? (
          <ActionButton tone="secondary" onClick={props.onMoveUp}>
            <GripVertical className="mr-2 h-4 w-4" />
            {locale === "zh" ? "上移" : "Up"}
          </ActionButton>
        ) : null}
        {props.onMoveDown ? (
          <ActionButton tone="secondary" onClick={props.onMoveDown}>
            <ArrowRight className="mr-2 h-4 w-4 rotate-90" />
            {locale === "zh" ? "下移" : "Down"}
          </ActionButton>
        ) : null}
      </div>
    </div>
  );
}
