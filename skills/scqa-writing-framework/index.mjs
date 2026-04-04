import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const TRANSITION_WORDS = /\b(however|but|yet|although|despite|unfortunately|nonetheless|still|conversely|on the other hand)\b/i;
const QUESTION_PATTERNS = /[?]|(\b(how|what|why|where|when|who|which|can|should|could|would|is it|are we)\b)/i;
const SOLUTION_HINTS = /\b(solution|answer|resolve|fix|approach|strategy|recommend|suggest|implement|adopt|use|leverage|build|create|launch)\b/i;
const CONTEXT_HINTS = /\b(currently|today|right now|at present|as of|existing|status quo|background|context|traditionally|historically)\b/i;
const PROBLEM_HINTS = /\b(problem|issue|challenge|risk|gap|pain|struggle|obstacle|bottleneck|limitation|threat|decline|drop|fail|break|cost|lose|delay)\b/i;

function splitSentences(text) {
  return text
    .replace(/([.!?])\s+/g, "$1\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function scoreSentence(sentence, patterns) {
  let score = 0;
  for (const p of patterns) {
    if (p.test(sentence)) score += 1;
  }
  return score;
}

function classifySentences(sentences) {
  const situation = [];
  const complication = [];
  const question = [];
  const answer = [];

  for (const s of sentences) {
    const ctxScore = scoreSentence(s, [CONTEXT_HINTS]);
    const probScore = scoreSentence(s, [PROBLEM_HINTS, TRANSITION_WORDS]);
    const qScore = scoreSentence(s, [QUESTION_PATTERNS]);
    const aScore = scoreSentence(s, [SOLUTION_HINTS]);

    const max = Math.max(ctxScore, probScore, qScore, aScore);
    if (max === 0) {
      // Default: if we have nothing yet in situation, it goes there; otherwise answer
      if (situation.length < 2) {
        situation.push(s);
      } else {
        answer.push(s);
      }
    } else if (max === ctxScore && complication.length === 0) {
      situation.push(s);
    } else if (max === probScore) {
      complication.push(s);
    } else if (max === qScore && s.includes("?")) {
      question.push(s);
    } else if (max === aScore) {
      answer.push(s);
    } else {
      // Fallback bucket based on order heuristic
      if (situation.length <= complication.length) situation.push(s);
      else if (complication.length <= question.length) complication.push(s);
      else answer.push(s);
    }
  }

  return { situation, complication, question, answer };
}

function ensureSection(label, bucket, fallback) {
  if (bucket.length > 0) return bucket.join(" ");
  return fallback;
}

function generateQuestion(complicationText) {
  if (/cost|expensive|budget/i.test(complicationText)) return "How can we reduce cost while maintaining quality?";
  if (/slow|delay|time/i.test(complicationText)) return "How can we speed up and remove bottlenecks?";
  if (/risk|fail|break/i.test(complicationText)) return "How can we mitigate the risks identified?";
  if (/gap|missing|lack/i.test(complicationText)) return "What steps will close the gap?";
  return "What is the best path forward given these challenges?";
}

export async function execute(input = {}) {
  const content = asString(input.content ?? input.text);
  if (!content) {
    throw new Error("scqa-writing-framework requires a content input.");
  }

  const sentences = splitSentences(content);
  const classified = classifySentences(sentences);

  const situationText = ensureSection("Situation", classified.situation, compact(sentences[0] || content, 200));
  const complicationText = ensureSection("Complication", classified.complication, "The current approach has unaddressed challenges.");
  const questionText = classified.question.length > 0
    ? classified.question.join(" ")
    : generateQuestion(complicationText);
  const answerText = ensureSection("Answer", classified.answer, "A structured plan addressing the complication is needed.");

  const scqa = {
    situation: situationText,
    complication: complicationText,
    question: questionText,
    answer: answerText,
  };

  const wordCount = content.split(/\s+/).length;
  const sectionCounts = {
    situationSentences: classified.situation.length,
    complicationSentences: classified.complication.length,
    questionSentences: classified.question.length,
    answerSentences: classified.answer.length,
  };

  return {
    summary: `SCQA framework applied to ${wordCount}-word input across 4 sections.`,
    nextStep: "Review the structured SCQA output and refine each section for your audience.",
    details: {
      scqa,
      sectionCounts,
      inputWordCount: wordCount,
      suggestedSkillId: "structured-copywriting-skill",
    },
  };
}
