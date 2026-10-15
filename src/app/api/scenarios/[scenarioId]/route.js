import { refreshGeminiConfig } from "@/lib/server/gemini";
import { getScenario, updateScenario, setScenarioStatus } from "@/lib/server/scenarios";
import { errorResponse, json, readJsonBody, actorOf } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request, context) {
  try {
    await refreshGeminiConfig();
    const { scenarioId } = await context.params;
    return json({ scenario: await getScenario(scenarioId) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PUT - edit content (returns to draft) */
export async function PUT(request, context) {
  try {
    await refreshGeminiConfig();
    const { scenarioId } = await context.params;
    return json({ scenario: await updateScenario(scenarioId, await readJsonBody(request), actorOf(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST { action: approve|reject|archive|draft, note, acknowledge } */
export async function POST(request, context) {
  try {
    await refreshGeminiConfig();
    const { scenarioId } = await context.params;
    const body = await readJsonBody(request);
    return json({ scenario: await setScenarioStatus(scenarioId, body.action, { actor: actorOf(request), note: body.note, acknowledge: Boolean(body.acknowledge) }) });
  } catch (err) {
    return errorResponse(err);
  }
}
