import { refreshGeminiConfig } from "@/lib/server/gemini";
import { listBlueprints, saveBlueprint } from "@/lib/server/pkt";
import { assertPersistentStorage } from "@/lib/server/db";
import { errorResponse, json, readJsonBody, actorOf } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request) {
  try {
    await refreshGeminiConfig();
    return json({ blueprints: await listBlueprints(new URL(request.url).searchParams.get("process_id")) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request) {
  try {
    await refreshGeminiConfig();
    assertPersistentStorage();
    return json({ blueprint: await saveBlueprint(await readJsonBody(request), actorOf(request)) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
