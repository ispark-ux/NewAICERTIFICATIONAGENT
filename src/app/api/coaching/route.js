import { refreshGeminiConfig } from "@/lib/server/gemini";
import { generateCoachingPlan, listCoachingPlans } from "@/lib/server/certification-status";
import { getGeminiConfig, GeminiNotConfiguredError, describeGeminiError } from "@/lib/server/gemini";
import { errorResponse, json, httpError, readJsonBody, actorOf } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** GET /api/coaching?process_id=&agent_key= */
export async function GET(request) {
  try {
    await refreshGeminiConfig();
    const url = new URL(request.url);
    return json({ plans: await listCoachingPlans({ process_id: url.searchParams.get("process_id"), agent_key: url.searchParams.get("agent_key") }) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST { process_id, agent_key } - targeted coaching plan from the latest voice + PKT results */
export async function POST(request) {
  try {
    await refreshGeminiConfig();
    if (!getGeminiConfig().configured) throw new GeminiNotConfiguredError();
    const body = await readJsonBody(request);
    try {
      return json({ plan: await generateCoachingPlan({ process_id: body.process_id, agent_key: body.agent_key, trigger: "manual", actor: actorOf(request) }) }, { status: 201 });
    } catch (err) {
      if (err.status) throw err;
      throw httpError(`Coaching plan failed: ${describeGeminiError(err)}`, 502);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
