import type React from "react";
import { cn } from "@/lib/utils/cn";
import type { ChatMessage } from "@/hooks/use-chat-session";

interface ChatMessageBubbleProps {
  message: ChatMessage;
  streamingText?: string;
}

export function ChatMessageBubble({ message, streamingText }: ChatMessageBubbleProps) {
  const isUser = message.role === "user";
  const displayText = message.role === "assistant" && message.status === "streaming"
    ? (streamingText || "")
    : message.content;

  return (
    <div
      className={cn(
        "flex w-full gap-3",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      {!isUser && (
        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-xs font-bold text-[color:var(--color-text-primary)]">
          F
        </div>
      )}

      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed",
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

      {isUser && (
        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-xs font-bold text-[color:var(--color-text-secondary)]">
          U
        </div>
      )}
    </div>
  );
}

/**
 * Lightweight markdown renderer — handles bold, inline code, code blocks,
 * headers, lists, and links without an external dependency.
 */
function MarkdownContent({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let key = 0;

  // Split by code blocks first
  const segments = text.split(/(```[\s\S]*?```)/g);

  for (const segment of segments) {
    if (segment.startsWith("```")) {
      // Code block
        const content = segment.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
      parts.push(
        <pre key={key++} className="my-2 overflow-x-auto rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-contrast)] p-3 text-xs text-[color:var(--color-text-primary)]">
          <code>{content}</code>
        </pre>,
      );
    } else {
      // Process inline markdown
      const lines = segment.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (i > 0) parts.push(<br key={key++} />);

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
              {"  "}• {renderInline(line.slice(2), key)}
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

function renderInline(text: string, baseKey: number): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let k = baseKey * 1000;
  // Match bold, inline code, and links
  const regex = /(\*\*(.*?)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2] !== undefined) {
      // Bold
      nodes.push(<strong key={k++} className="font-semibold text-[color:var(--color-text-primary)]">{match[2]}</strong>);
    } else if (match[4] !== undefined) {
      // Inline code
      nodes.push(<code key={k++} className="rounded bg-[color:var(--color-bg-contrast)] px-1 py-0.5 text-[color:var(--color-text-primary)]">{match[4]}</code>);
    } else if (match[6] !== undefined && match[7] !== undefined) {
      // Link
      nodes.push(<span key={k++} className="text-[color:var(--color-accent)] underline">{match[6]}</span>);
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [text];
}
