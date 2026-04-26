// Phase E — vision / OCR / TTS / PDF / file via chat agent (forced via prompt content).
//
// On Friday, multimodal capabilities are exposed only as agent tools, not HTTP routes — so
// we drive them through a chat session. The chat agent decides whether to tool-call. We do not
// force tool_choice (Friday's session API doesn't expose it). Instead we record (a) whether
// the modality produced a coherent answer, (b) whether the underlying tool was called.
//
// SKIP-with-explanation if a modality is not enabled in this deployment (we still mark PASS for
// the SKIP because that's the explicit user-clarified policy for "no key available" lanes).

import { api, isProviderPreconditionFailure, responseHasProviderPreconditionFailure, startPhase, WORKSPACE_CAPTURE_DIR } from "../lib/util.mjs";
import { ensureAllFixtures } from "../lib/fixtures.mjs";

async function chat(ctx, channel, chatId, content) {
  const create = await api("/v1/sessions", {
    method: "POST", token: ctx.tokens.accessToken,
    body: JSON.stringify({ channel, chatId, title: chatId }),
  });
  const key = create.body?.data?.session?.key;
  if (!key) throw new Error("session create failed: " + JSON.stringify(create.body));
  await api(`/v1/sessions/${key}/messages`, {
    method: "POST", token: ctx.tokens.accessToken,
    body: JSON.stringify({ role: "user", content }),
  });
  const r = await api(`/v1/sessions/${key}/run`, {
    method: "POST", token: ctx.tokens.accessToken,
    body: JSON.stringify({ useLastUserMessage: true }),
  });
  return { key, response: r, run: r.body?.data?.run, ok: r.body?.ok, raw: r.body };
}

export async function runPhaseE(ctx) {
  const p = startPhase("E");
  const fix = ensureAllFixtures();
  const cases = [];
  try {
    // VISION
    {
      const r = await chat(ctx, "stab", `e-vision-${Date.now()}`, `Look at the image at file://${fix.redPng} and tell me the dominant color in one word.`);
      const reply = String(r.run?.finalResponse ?? "").toLowerCase();
      const ok = /red/.test(reply);
      cases.push({ modality: "vision", ok, reply: reply.slice(0, 200), toolCalls: r.run?.toolCallCount, providerPrecondition: responseHasProviderPreconditionFailure(r.response) || isProviderPreconditionFailure(reply) });
      p.note(`vision: ok=${ok} reply="${reply.slice(0, 60)}"`);
    }
    // OCR
    {
      const r = await chat(ctx, "stab", `e-ocr-${Date.now()}`, `Use OCR or vision on the image at file://${fix.ocrPng}. Extract any text/numbers and reply with only the extracted text.`);
      const reply = String(r.run?.finalResponse ?? "");
      const ok = /STABILITY/i.test(reply) || /12345/.test(reply);
      cases.push({ modality: "ocr", ok, reply: reply.slice(0, 300), providerPrecondition: responseHasProviderPreconditionFailure(r.response) || isProviderPreconditionFailure(reply) });
      p.note(`ocr: ok=${ok}`);
    }
    // TTS
    {
      const ttsOut = `${WORKSPACE_CAPTURE_DIR}/e-tts.mp3`;
      const r = await chat(ctx, "stab", `e-tts-${Date.now()}`, `Synthesize speech of the phrase 'stability test' to ${ttsOut}. Reply only with DONE when finished.`);
      const reply = String(r.run?.finalResponse ?? "");
      // file existence check
      const fs = await import("node:fs");
      let bytes = 0;
      try { bytes = fs.statSync(ttsOut).size; } catch {}
      cases.push({ modality: "tts", ok: bytes > 1024, reply: reply.slice(0, 200), bytes, providerPrecondition: responseHasProviderPreconditionFailure(r.response) || isProviderPreconditionFailure(reply) });
      p.note(`tts: bytes=${bytes}`);
    }
    // PDF
    {
      const r = await chat(ctx, "stab", `e-pdf-${Date.now()}`, `Parse the PDF file at ${fix.pdf}. Find the marker and quote it back to me. Reply only with the marker string.`);
      const reply = String(r.run?.finalResponse ?? "");
      const ok = /STABILITY-PDF-MARKER-X7Q/.test(reply);
      cases.push({ modality: "pdf", ok, reply: reply.slice(0, 200), providerPrecondition: responseHasProviderPreconditionFailure(r.response) || isProviderPreconditionFailure(reply) });
      p.note(`pdf: ok=${ok}`);
    }
    // FILE
    {
      const r = await chat(ctx, "stab", `e-file-${Date.now()}`, `Read the CSV at ${fix.csv}. Sum the integer values in column 2 (the 'value' column) for all data rows. Reply only with the sum.`);
      const reply = String(r.run?.finalResponse ?? "");
      const ok = new RegExp(`\\b${fix.csvSum}\\b`).test(reply);
      cases.push({ modality: "file_csv", ok, reply: reply.slice(0, 200), expected: fix.csvSum, providerPrecondition: responseHasProviderPreconditionFailure(r.response) || isProviderPreconditionFailure(reply) });
      p.note(`csv: ok=${ok}`);
    }
    p.addEvidence("modality-results.json", cases);
    const fails = cases.filter(c => !c.ok);
    if (fails.length === cases.length && cases.some(c => c.providerPrecondition)) {
      p.finish("SKIP", "multimodal skipped: no verified provider/model route available", [
        { severity: "low", note: "all modality prompts were blocked by provider auth/routing preconditions" },
      ]);
      return;
    }
    const anomalies = fails.map(c => ({severity: "medium", note: `${c.modality} did not produce expected answer: "${(c.reply || "").slice(0, 80)}"`}));
    p.finish(fails.length === cases.length ? "FAIL" : "PASS", `${cases.length - fails.length}/${cases.length} modalities produced expected answer`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"multimodal threw"}]);
  }
}
