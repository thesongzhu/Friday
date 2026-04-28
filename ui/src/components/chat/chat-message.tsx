import type React from "react";
import { useCallback, useState } from "react";
import { Copy, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { redactSecretLikeText } from "@/lib/security/redact-secrets";
import { isSafeHref, toSafeHref } from "@/lib/security/safe-url";
import type { ChatMessage } from "@/hooks/use-chat-session";

interface ChatMessageBubbleProps {
  message: ChatMessage;
  streamingText?: string;
  onRetry?: () => void;
}

export function ChatMessageBubble({ message, streamingText, onRetry }: ChatMessageBubbleProps) {
  const isUser = message.role === "user";
  const rawDisplayText = message.role === "assistant" && message.status === "streaming"
    ? (streamingText || "")
    : message.content;
  const displayText = redactSecretLikeText(rawDisplayText);

  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(displayText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [displayText]);

  return (
    <div
      className={cn(
        "group/msg flex w-full gap-3",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      {!isUser && (
        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-xs font-bold text-[color:var(--color-text-primary)]">
          F
        </div>
      )}

      <div className="relative max-w-[75%]">
        <div
          className={cn(
            "rounded-2xl px-4 py-3 text-sm leading-relaxed",
            isUser
              ? "border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface-strong)] text-[color:var(--color-text-primary)]"
              : "border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-text-primary)]",
            message.status === "error" && "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] text-[color:var(--color-text-primary)]",
          )}
        >
          {message.status === "streaming" && !displayText && (
            <div className="flex items-center gap-1.5 text-[color:var(--color-text-tertiary)]">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--color-accent)]" />
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--color-accent)]" style={{ animationDelay: "150ms" }} />
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--color-accent)]" style={{ animationDelay: "300ms" }} />
            </div>
          )}
          {displayText && (
            <div className="whitespace-pre-wrap break-words">
              <MarkdownContent text={displayText} />
            </div>
          )}
        </div>

        {/* Hover action buttons */}
        {displayText && (
          <div
            className={cn(
              "absolute -top-2 flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100",
              isUser ? "left-0 -translate-x-full pr-1" : "right-0 translate-x-full pl-1",
            )}
          >
            <button
              type="button"
              onClick={handleCopy}
              className="flex h-6 w-6 items-center justify-center rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-tertiary)] shadow-sm transition-colors hover:text-[color:var(--color-text-primary)]"
              title={copied ? "已复制" : "复制"}
            >
              <Copy className="h-3 w-3" />
            </button>
            {!isUser && onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="flex h-6 w-6 items-center justify-center rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-tertiary)] shadow-sm transition-colors hover:text-[color:var(--color-text-primary)]"
                title="重试"
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            )}
          </div>
        )}

        {/* Copied tooltip */}
        {copied && (
          <div
            className={cn(
              "absolute -top-7 rounded-md bg-[color:var(--color-bg-contrast)] px-2 py-0.5 text-[10px] text-[color:var(--color-text-primary)] shadow",
              isUser ? "right-0" : "left-0",
            )}
          >
            已复制
          </div>
        )}
      </div>

      {isUser && (
        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-xs font-bold text-[color:var(--color-text-secondary)]">
          U
        </div>
      )}
    </div>
  );
}

// ─── Action feedback badge detection ───

const ACTION_BADGE_RE = /^([\p{Emoji_Presentation}\p{Emoji}\u200d]+)\s*(已.+)$/u;

function isActionBadgeLine(line: string): boolean {
  return ACTION_BADGE_RE.test(line.trim());
}

function ActionBadge({ line }: { line: string }) {
  const match = line.trim().match(ACTION_BADGE_RE);
  if (!match) return null;
  const emoji = match[1];
  const text = match[2];
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--color-accent-soft)] px-2 py-0.5 text-xs font-medium text-[color:var(--color-text-primary)]">
      <span>{emoji}</span>
      <span>{text}</span>
    </span>
  );
}

// ─── Code block with copy button ───

function CodeBlock({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  return (
    <div className="group/code relative my-2">
      <pre className="overflow-x-auto rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-contrast)] p-3 pr-12 text-xs text-[color:var(--color-text-primary)]">
        <code>{content}</code>
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 rounded-md border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-text-tertiary)] opacity-0 transition-opacity hover:text-[color:var(--color-text-primary)] group-hover/code:opacity-100"
      >
        {copied ? "已复制 ✓" : "复制"}
      </button>
    </div>
  );
}

/**
 * Lightweight markdown renderer — handles bold, inline code, code blocks,
 * headers, lists, links, and action feedback badges without an external dependency.
 */
export function MarkdownContent({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let key = 0;

  // Split by code blocks first
  const segments = text.split(/(```[\s\S]*?```)/g);

  for (const segment of segments) {
    if (segment.startsWith("```")) {
      // Code block with copy button
      const content = segment.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
      parts.push(<CodeBlock key={key++} content={content} />);
    } else {
      // Process inline markdown
      const lines = segment.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (i > 0) parts.push(<br key={key++} />);

        // Action feedback badges
        if (isActionBadgeLine(line)) {
          parts.push(<ActionBadge key={key++} line={line} />);
          continue;
        }

        // Headers
        if (line.startsWith("### ")) {
          parts.push(<strong key={key++} className="text-[color:var(--color-text-primary)]">{line.slice(4)}</strong>);
          continue;
        }
        if (line.startsWith("## ")) {
          parts.push(<strong key={key++} className="text-base text-[color:var(--color-text-primary)]">{line.slice(3)}</strong>);
          continue;
        }

        // List items
        if (/^[-*] /.test(line)) {
          parts.push(
            <span key={key++} className="ml-2">
              {"  "}&bull; {renderInline(line.slice(2), key)}
            </span>,
          );
          key++;
          continue;
        }

        // Regular text with inline formatting
        parts.push(<span key={key++}>{renderInline(line, key)}</span>);
        key++;
      }
    }
  }

  return <>{parts}</>;
}

export function isSafeMarkdownLinkHref(href: string): boolean {
  return isSafeHref(href, { allowRelative: false });
}

function renderInline(text: string, baseKey: number): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let k = baseKey * 1000;
  // Match bold, inline code, and links
  const regex = /(\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*)|(__([^\s_](?:[\s\S]*?[^\s_])?)__)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2] !== undefined || match[4] !== undefined) {
      // Bold
      nodes.push(<strong key={k++} className="font-semibold text-[color:var(--color-text-primary)]">{match[2] ?? match[4]}</strong>);
    } else if (match[6] !== undefined) {
      // Inline code
      nodes.push(<code key={k++} className="rounded bg-[color:var(--color-bg-contrast)] px-1 py-0.5 text-[color:var(--color-text-primary)]">{match[6]}</code>);
    } else if (match[8] !== undefined && match[9] !== undefined) {
      const safeHref = toSafeHref(match[9], { allowRelative: false });
      if (safeHref) {
        nodes.push(
          <a
            key={k++}
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-[color:var(--color-text-primary)] hover:text-[color:var(--color-accent)] transition-colors"
          >
            {match[8]}
          </a>,
        );
      } else {
        nodes.push(<span key={k++}>{match[8]}</span>);
      }
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [text];
}
