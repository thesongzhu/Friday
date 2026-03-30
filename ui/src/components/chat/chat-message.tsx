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
        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/10 text-xs font-bold text-emerald-300">
          F
        </div>
      )}

      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed",
          isUser
            ? "border border-white/10 bg-white/10 text-white"
            : "border border-emerald-400/20 bg-emerald-400/[0.06] text-white/90",
          message.status === "error" && "border-rose-400/30 bg-rose-400/10 text-rose-100",
        )}
      >
        {message.status === "streaming" && !displayText && (
          <div className="flex items-center gap-1.5 text-white/40">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" style={{ animationDelay: "150ms" }} />
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" style={{ animationDelay: "300ms" }} />
          </div>
        )}
        {displayText && (
          <div className="whitespace-pre-wrap break-words">
            {renderMarkdownSimple(displayText)}
          </div>
        )}
      </div>

      {isUser && (
        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/20 bg-white/10 text-xs font-bold text-white/70">
          U
        </div>
      )}
    </div>
  );
}

/**
 * Minimal markdown rendering — bold, inline code, code blocks, links, lists.
 * Does not use a heavy markdown library; just basic formatting.
 */
function renderMarkdownSimple(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m) // preserve code blocks as-is
    .replace(/\*\*(.*?)\*\*/g, "$1"); // bold → just text in plain render
  // More sophisticated rendering can be added later with a proper markdown component
}
