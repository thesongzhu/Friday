import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const MAX_CHARS_PER_LINE = 42;
const MAX_LINES_PER_BLOCK = 2;
const MAX_WORDS_PER_BLOCK = 12;
const WPM = 150;

function splitIntoSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function breakIntoBlocks(sentences) {
  const blocks = [];
  let currentWords = [];

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    for (const word of words) {
      currentWords.push(word);
      const joined = currentWords.join(" ");
      if (
        currentWords.length >= MAX_WORDS_PER_BLOCK ||
        joined.length >= MAX_CHARS_PER_LINE * MAX_LINES_PER_BLOCK
      ) {
        blocks.push(currentWords.join(" "));
        currentWords = [];
      }
    }
    if (currentWords.length > 0 && currentWords.length >= MAX_WORDS_PER_BLOCK / 2) {
      blocks.push(currentWords.join(" "));
      currentWords = [];
    }
  }
  if (currentWords.length > 0) {
    blocks.push(currentWords.join(" "));
  }
  return blocks;
}

function wrapLines(text) {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = "";
  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (candidate.length > MAX_CHARS_PER_LINE && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = candidate;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.slice(0, MAX_LINES_PER_BLOCK);
}

function formatTimestamp(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function assignTimings(blocks) {
  let currentTime = 0;
  return blocks.map((text, index) => {
    const wordCount = text.split(/\s+/).length;
    const duration = Math.max(1.2, (wordCount / WPM) * 60);
    const startTime = currentTime;
    const endTime = currentTime + duration;
    currentTime = endTime + 0.1;

    const lines = wrapLines(text);

    return {
      index: index + 1,
      startTime: formatTimestamp(startTime),
      endTime: formatTimestamp(endTime),
      durationSeconds: Math.round(duration * 10) / 10,
      lines,
      text,
      wordCount,
      charCount: text.length,
    };
  });
}

function generateSRT(captions) {
  return captions
    .map((c) => `${c.index}\n${c.startTime} --> ${c.endTime}\n${c.lines.join("\n")}`)
    .join("\n\n");
}

function checkReadability(captions) {
  const issues = [];
  for (const c of captions) {
    if (c.charCount > MAX_CHARS_PER_LINE * MAX_LINES_PER_BLOCK + 10) {
      issues.push(`Block ${c.index}: exceeds recommended character limit (${c.charCount} chars).`);
    }
    if (c.durationSeconds < 1.0) {
      issues.push(`Block ${c.index}: duration too short (${c.durationSeconds}s) for comfortable reading.`);
    }
    if (c.durationSeconds > 7.0) {
      issues.push(`Block ${c.index}: duration too long (${c.durationSeconds}s); consider splitting.`);
    }
  }
  return issues;
}

export async function execute(input = {}) {
  const transcript = asString(input.transcript ?? input.content ?? input.text);
  if (!transcript) {
    throw new Error("caption-subtitle-formatter requires a transcript input.");
  }

  const sentences = splitIntoSentences(transcript);
  const blocks = breakIntoBlocks(sentences);
  const captions = assignTimings(blocks);
  const srtOutput = generateSRT(captions);
  const readabilityIssues = checkReadability(captions);

  const totalWords = transcript.split(/\s+/).length;
  const totalDuration = captions.length > 0
    ? captions[captions.length - 1].endTime
    : "00:00:00,000";

  return {
    summary: `Formatted ${captions.length} caption block(s) from ${totalWords} words, estimated end time ${totalDuration}.`,
    nextStep: readabilityIssues.length > 0
      ? `Review ${readabilityIssues.length} readability issue(s) before finalizing.`
      : "Captions are ready; export the SRT content to your video editor.",
    details: {
      totalBlocks: captions.length,
      totalWords,
      estimatedEndTime: totalDuration,
      captions,
      srtOutput,
      readabilityIssues,
      settings: {
        maxCharsPerLine: MAX_CHARS_PER_LINE,
        maxLinesPerBlock: MAX_LINES_PER_BLOCK,
        maxWordsPerBlock: MAX_WORDS_PER_BLOCK,
        assumedWPM: WPM,
      },
    },
  };
}
