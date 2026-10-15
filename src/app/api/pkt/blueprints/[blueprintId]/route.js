import { refreshGeminiConfig } from "@/lib/server/gemini";
import { db } from "@/lib/server/db";
import { saveBlueprint } from "@/lib/server/pkt";
import { errorResponse, json, httpError, readJsonBody, actorOf } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request, context) {
  try {
    await refreshGeminiConfig();
    const { blueprintId } = await context.params;
    const bp = await db.getDoc("pkt_blueprints", blueprintId);
    if (!bp) throw httpError("Test blueprint not found", 404);
    return json({ blueprint: bp });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(request, context) {
  try {
    await refreshGeminiConfig();
    const { blueprintId } = await context.params;
    return json({ blueprint: await saveBlueprint(await readJsonBody(request), actorOf(request), blueprintId) });
  } catch (err) {
    return errorResponse(err);
  }
}
