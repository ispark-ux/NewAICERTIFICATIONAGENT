import { refreshGeminiConfig } from "@/lib/server/gemini";
import { analyzeKnowledgeBase, getKnowledgeAnalysis } from "@/lib/server/kb";
import { getGeminiConfig, GeminiNotConfiguredError, describeGeminiError } from "@/lib/server/gemini";
import { errorResponse, json, httpError, readJsonBody, actorOf } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request) {
  try {
    await refreshGeminiConfig();
    const processId = new URL(request.url).searchParams.get("process_id");
    if (!processId) throw httpError("process_id is required", 400);
    return json({ analysis: await getKnowledgeAnalysis(processId) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST { process_id } - topics + conflicts/ambiguities/gaps in the approved documents */
export async function POST(request) {
  try {
    await refreshGeminiConfig();
    const body = await readJsonBody(request);
    if (!body.process_id) throw httpError("process_id is required", 400);
    if (!getGeminiConfig().configured) throw new GeminiNotConfiguredError();
    try {
      return json({ analysis: await analyzeKnowledgeBase(body.process_id, actorOf(request)) });
    } catch (err) {
      if (err.status) throw err;
      throw httpError(`Analysis failed: ${describeGeminiError(err)}`, 502);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
