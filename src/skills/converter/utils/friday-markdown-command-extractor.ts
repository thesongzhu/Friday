/**
 * Extracts executable command blocks from markdown content.
 *
 * Parses fenced code blocks tagged as `bash`, `sh`, `shell`, or untagged,
 * associating each block with a label derived from the nearest heading or
 * preceding descriptive text.
 */

export interface ExtractedCommand {
  /** Human-readable label from nearest heading or preceding text. */
  label: string;
  /** The raw command string (may be multi-line). */
  command: string;
  /** Language tag from the fenced block (`bash`, `sh`, `shell`, or `""` for untagged). */
  lang: string;
}

const SHELL_LANGS = new Set(["bash", "sh", "shell", ""]);

const FENCED_BLOCK_RE =
  /^```(\w*)\s*\n([\s\S]*?)^```\s*$/gm;

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/**
 * Extracts shell command blocks from markdown content.
 *
 * For each fenced code block with a shell-compatible language tag (bash, sh,
 * shell, or untagged), returns the command text and a descriptive label.
 *
 * The label is resolved by walking backwards from the code block to find:
 * 1. The nearest non-empty text line (used as inline label), or
 * 2. The nearest heading.
 *
 * If no label can be resolved, falls back to `"command-{index}"`.
 */
export function extractMarkdownCommands(markdown: string): ExtractedCommand[] {
  const lines = markdown.split("\n");
  const results: ExtractedCommand[] = [];

  // Pre-compute heading context for every line
  let currentHeading = "";
  const headingAtLine: string[] = [];
  for (const line of lines) {
    const hMatch = HEADING_RE.exec(line);
    if (hMatch) {
      currentHeading = hMatch[2]!.trim();
    }
    headingAtLine.push(currentHeading);
  }

  // Walk through and find fenced code blocks
  let i = 0;
  while (i < lines.length) {
    const openMatch = /^```(\w*)\s*$/.exec(lines[i]!);
    if (!openMatch) {
      i++;
      continue;
    }

    const lang = openMatch[1]!;
    if (!SHELL_LANGS.has(lang)) {
      // Skip past the entire non-shell fenced block
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      continue;
    }

    // Collect block content until closing ```
    const blockStartLine = i;
    i++;
    const contentLines: string[] = [];
    while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
      contentLines.push(lines[i]!);
      i++;
    }
    // Skip the closing ```
    if (i < lines.length) {
      i++;
    }

    const command = contentLines.join("\n").trim();
    if (!command) {
      continue;
    }

    // Resolve label: walk backwards from the opening ``` line
    const label = resolveLabel(lines, blockStartLine, headingAtLine, results.length);

    results.push({ label, command, lang });
  }

  return results;
}

/**
 * Resolves the best label for a code block by looking backwards from
 * `blockStartLine` for the nearest descriptive text or heading.
 */
function resolveLabel(
  lines: string[],
  blockStartLine: number,
  headingAtLine: string[],
  index: number,
): string {
  // Walk backwards from the line before the code block opening
  for (let j = blockStartLine - 1; j >= 0; j--) {
    const line = lines[j]!.trim();

    // Skip empty lines
    if (!line) continue;

    // Skip comment-only lines inside code blocks (shouldn't be here, but be safe)
    if (line.startsWith("```")) break;

    // If it's a heading, use it
    const hMatch = HEADING_RE.exec(line);
    if (hMatch) {
      return hMatch[2]!.trim();
    }

    // Use the nearest non-empty text as label — strip trailing colons
    return line.replace(/:$/, "").trim();
  }

  // Fall back to the heading context at the block start line
  const headingContext = headingAtLine[blockStartLine];
  if (headingContext) {
    return headingContext;
  }

  return `command-${index}`;
}
