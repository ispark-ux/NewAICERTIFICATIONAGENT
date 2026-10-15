import { refreshGeminiConfig } from "@/lib/server/gemini";
import { generateScenarios } from "@/lib/server/scenarios";
import { assertPersistentStorage } from "@/lib/server/db";
import { getGeminiConfig, GeminiNotConfiguredError, describeGeminiError } from "@/lib/server/gemini";
import { errorResponse, json, httpError, readJsonBody, actorOf } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** POST { process_id, count, categories[], difficulty, focus } */
export async function POST(request) {
  try {
    await refreshGeminiConfig();
    assertPersistentStorage();
    const body = await readJsonBody(request);
    if (!body.process_id) throw httpError("process_id is required", 400);
    if (!getGeminiConfig().configured) throw new GeminiNotConfiguredError();
    try {
      return json(await generateScenarios({ ...body, actor: actorOf(request) }), { status: 201 });
    } catch (err) {
      if (err.status) throw err;
      throw httpError(`Scenario generation failed: ${describeGeminiError(err)}`, 502);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
