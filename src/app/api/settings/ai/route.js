import { refreshGeminiConfig, getGeminiConfig, geminiRuntimeInfo, testGeminiKey, describeGeminiError, DEFAULT_LIVE_MODEL, DEFAULT_EVALUATION_MODEL } from "@/lib/server/gemini";
import { db } from "@/lib/server/db";
import { encryptSecret, maskKey } from "@/lib/server/secrets";
import { audit } from "@/lib/server/audit";
import { errorResponse, json, httpError, readJsonBody, actorOf } from "@/lib/server/http";
import { nowIso } from "@/lib/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MODEL_KEYS = ["live_model", "evaluation_model", "generation_model", "screen_analysis_model"];
const cleanModels = (m = {}) => Object.fromEntries(MODEL_KEYS.map((k) => [k, String(m[k] || "").trim().slice(0, 100)]).filter(([, v]) => v && /^[a-zA-Z0-9._\-/]+$/.test(v)));

async function view() {
  await refreshGeminiConfig(true);
  const cfg = getGeminiConfig();
  const stored = (await db.getSetting("gemini")) || {};
  return {
    configured: cfg.configured,
    ...geminiRuntimeInfo(),
    models: { live_model: cfg.liveModel, evaluation_model: cfg.evaluationModel, generation_model: cfg.generationModel, screen_analysis_model: cfg.screenAnalysisModel },
    model_overrides: stored.models || {},
    defaults: { live_model: DEFAULT_LIVE_MODEL, evaluation_model: DEFAULT_EVALUATION_MODEL },
  };
}

/** GET - status only. The key itself is NEVER returned (only a masked hint). */
export async function GET() {
  try {
    return json(await view());
  } catch (err) {
    return errorResponse(err);
  }
}

/** PUT { api_key?, models? } - validates the key against Gemini, then stores it encrypted. */
export async function PUT(request) {
  try {
    const body = await readJsonBody(request);
    const actor = actorOf(request);
    const stored = (await db.getSetting("gemini")) || {};
    const models = { ...(stored.models || {}), ...cleanModels(body.models) };
    for (const k of MODEL_KEYS) if (body.models && body.models[k] === "") delete models[k];
    const next = { ...stored, models, updated_at: nowIso(), updated_by: actor };
    let warnings = [];
    const key = typeof body.api_key === "string" ? body.api_key.trim() : "";
    if (key) {
      if (!/^[A-Za-z0-9_\-]{20,200}$/.test(key)) throw httpError("That does not look like a Gemini API key.", 400);
      try {
        const t = await testGeminiKey(key, models);
        warnings = t.warnings;
      } catch (err) {
        throw httpError(`Key not saved - Gemini rejected it: ${describeGeminiError(err)}`, 400);
      }
      next.api_key_enc = encryptSecret(key);
      next.key_hint = maskKey(key);
    }
    await db.saveSetting("gemini", next);
    await audit("settings.gemini_updated", { entity_type: "settings", entity_id: "gemini", actor, summary: key ? `Gemini API key replaced (${maskKey(key)})` : "Gemini model settings updated", details: { models } });
    return json({ ...(await view()), warnings, saved: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE - removes the panel key (falls back to GEMINI_API_KEY from .env). */
export async function DELETE(request) {
  try {
    const stored = (await db.getSetting("gemini")) || {};
    const { api_key_enc, key_hint, ...rest } = stored;
    await db.saveSetting("gemini", { ...rest, updated_at: nowIso(), updated_by: actorOf(request) });
    await audit("settings.gemini_key_removed", { entity_type: "settings", entity_id: "gemini", actor: actorOf(request), summary: "Panel Gemini key removed (using .env key if present)" });
    return json(await view());
  } catch (err) {
    return errorResponse(err);
  }
}
