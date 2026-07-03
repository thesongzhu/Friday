export function parseTestRef(ref) {
  if (typeof ref !== "string") return null;
  const idx = ref.lastIndexOf("::");
  if (idx <= 0 || idx + 2 >= ref.length) return null;
  return { file: ref.slice(0, idx).trim(), fn: ref.slice(idx + 2).trim() };
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveRustTest(content, fn) {
  const rustRe = new RegExp(String.raw`\bfn\s+${escapeRe(fn)}\s*\(`);
  const match = rustRe.exec(content);
  if (!match) return { declared: false, ignored: false };

  const lines = content.split(/\r?\n/);
  const fnLineIndex = content.slice(0, match.index).split(/\r?\n/).length - 1;
  const attributeText = collectRustAttributeText(lines, fnLineIndex);

  return {
    declared: true,
    ignored: rustAttributeTextHasIgnore(attributeText),
  };
}

export function fileDeclaresTest(content, fn) {
  if (resolveRustTest(content, fn).declared) return true;

  const tsRe = new RegExp(
    String.raw`\b(?:it|test)\s*\(\s*(['"\`])${escapeRe(fn)}\1`
  );
  return tsRe.test(content);
}

function collectRustAttributeText(lines, fnLineIndex) {
  const blocksByEnd = rustAttributeBlocksByEnd(lines);
  const blocks = [];

  for (let i = fnLineIndex - 1; i >= 0; ) {
    const trimmed = lines[i]?.trim() ?? "";
    if (
      trimmed === "" ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("///") ||
      trimmed.startsWith("//!")
    ) {
      i--;
      continue;
    }

    const block = blocksByEnd.get(i);
    if (!block) break;

    blocks.unshift(block.text);
    i = block.start - 1;
  }

  return blocks.join("\n");
}

function rustAttributeBlocksByEnd(lines) {
  const blocks = new Map();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("#[") && !trimmed.startsWith("#![")) continue;

    const start = i;
    let end = i;
    let balance = 0;
    for (; end < lines.length; end++) {
      balance += countChar(lines[end], "[");
      balance -= countChar(lines[end], "]");
      if (balance <= 0) break;
    }

    blocks.set(end, {
      start,
      end,
      text: lines.slice(start, end + 1).join("\n"),
    });
    i = end;
  }

  return blocks;
}

function rustAttributeTextHasIgnore(attributeText) {
  return (
    /#\[\s*ignore(?:\s|=|\])/.test(attributeText) ||
    /#\[\s*cfg_attr\s*\([\s\S]*?\bignore\b/.test(attributeText)
  );
}

function countChar(value, char) {
  let count = 0;
  for (const current of value) {
    if (current === char) count++;
  }
  return count;
}
