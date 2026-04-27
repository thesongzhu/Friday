// Phase P — provider multi-fallback: register fake-fail provider, set as primary, run chat.
import { api, isProviderPreconditionFailure, responseHasProviderPreconditionFailure, startPhase } from "../lib/util.mjs";

export async function runPhaseP(ctx) {
  const p = startPhase("P");
  try {
    const realProviders = await api("/v1/providers", { token: ctx.tokens.accessToken });
    const real = chooseRealProvider(realProviders.body?.data?.items ?? []);
    const realId = real?.id;
    const defaultModel = real?.defaultModel ?? real?.config?.defaultModel ?? real?.config?.supportedModels?.[0] ?? "deepseek-v4-pro";
    const baseUrl = real?.baseUrl ?? (real?.kind === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com");
    const supportedModels = real?.config?.supportedModels?.length ? real.config.supportedModels : [defaultModel];
    p.note(`real provider kind=${real?.kind ?? "(none)"} id=${realId ?? "(none)"} model=${defaultModel}`);
    // Create fake-fail provider matching the real provider kind, then put the real
    // provider behind it as fallback.
    const fakePayload = {
      kind: real?.kind ?? "deepseek", name: `fake-fail-${real?.kind ?? "deepseek"}`,
      baseUrl,
      api: real?.config?.api ?? "openai-responses",
      authMode: real?.config?.authMode ?? "bearer-token",
      apiKey: "sk-fake-deliberately-invalid-key-xyz123", // pragma: allowlist secret
      supportedModels,
      defaultModel,
      validateOnSave: false,
    };
    const fakeRes = await api("/v1/providers", {
      method: "POST", token: ctx.tokens.accessToken,
      body: JSON.stringify(fakePayload),
    });
    p.addEvidence("fake-create.json", { status: fakeRes.status, body: fakeRes.body, payload: fakePayload });
    const fakeId = fakeRes.body?.data?.id
      ?? fakeRes.body?.data?.profile?.id
      ?? fakeRes.body?.data?.provider?.id;
    if (!fakeId) {
      p.note(`fake-create failed: status=${fakeRes.status} body=${JSON.stringify(fakeRes.body).slice(0,400)}`);
    } else {
      p.note(`fake-create ok id=${fakeId}`);
    }
    if (fakeId && realId) {
      // Set fake as default; real as fallback
      const route = await api("/v1/model-routing", {
        method: "PUT", token: ctx.tokens.accessToken,
        body: JSON.stringify({
          defaultProviderId: fakeId, defaultModel,
          fallbackProviderIds: [realId],
        }),
      });
      p.addEvidence("model-routing.json", route.body);
      // Send a chat request — expect first call fails on fake, fallback to real
      const create = await api("/v1/sessions", {
        method: "POST", token: ctx.tokens.accessToken,
        body: JSON.stringify({ channel: "stab", chatId: `p-${Date.now()}` }),
      });
      const key = create.body?.data?.session?.key;
      await api(`/v1/sessions/${key}/messages`, {
        method: "POST", token: ctx.tokens.accessToken,
        body: JSON.stringify({ role: "user", content: "Reply only with the integer 99." }),
      });
      const r = await api(`/v1/sessions/${key}/run`, {
        method: "POST", token: ctx.tokens.accessToken,
        body: JSON.stringify({ useLastUserMessage: true }),
      });
      p.addEvidence("chat-run.json", { status: r.status, body: r.body });
      const reply = r.body?.data?.run?.finalResponse ?? "";
      p.note(`fallback reply: ${String(reply).slice(0, 60)}`);
      // Restore real as default
      await api("/v1/model-routing", {
        method: "PUT", token: ctx.tokens.accessToken,
        body: JSON.stringify({ defaultProviderId: realId, defaultModel, fallbackProviderIds: [] }),
      });
      // Try to delete fake provider for cleanliness
      await api(`/v1/providers/${fakeId}`, { method: "DELETE", token: ctx.tokens.accessToken });
      if (responseHasProviderPreconditionFailure(r) || isProviderPreconditionFailure(reply)) {
        p.finish("SKIP", "provider fallback skipped: verified fallback provider is not currently usable", [
          { severity: "low", note: `text provider precondition failed during fallback probe: "${String(reply).slice(0, 120)}"` },
        ]);
        return;
      }
      const ok = /99/.test(String(reply));
      const anomalies = ok ? [] : [{severity:"high", note:`fallback expected '99', got "${String(reply).slice(0,80)}"`}];
      p.finish(ok ? "PASS" : "FAIL", `provider fallback: reply contains 99 = ${ok}`, anomalies);
    } else {
      p.finish("SKIP", "provider fallback skipped: fake provider or verified fallback provider unavailable", [{severity:"low", note:"setup precondition unavailable"}]);
    }
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"provider-fallback threw"}]);
  }
}

function chooseRealProvider(items) {
  const envPriority = ["DEEPSEEK_API_KEY", "FRIDAY_DEEPSEEK_API_KEY", "OPENAI_API_KEY"];
  return items
    .filter((item) => item?.enabled !== false && item?.config?.keySource?.kind === "env-ref")
    .sort((a, b) => {
      const ai = envPriority.indexOf(a.config.keySource.envVar);
      const bi = envPriority.indexOf(b.config.keySource.envVar);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    })[0] ?? null;
}
