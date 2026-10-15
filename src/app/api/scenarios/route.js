import { refreshGeminiConfig } from "@/lib/server/gemini";
import { listScenarios, SCENARIO_CATEGORIES } from "@/lib/server/scenarios";
import { errorResponse, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/scenarios?process_id=&status= */
export async function GET(request) {
  try {
    await refreshGeminiConfig();
    const url = new URL(request.url);
    return json({ scenarios: await listScenarios(url.searchParams.get("process_id"), url.searchParams.get("status")), categories: SCENARIO_CATEGORIES });
  } catch (err) {
    return errorResponse(err);
  }
}
