import { refreshGeminiConfig } from "@/lib/server/gemini";
import { storeDocumentPart, completeDocumentUpload, approveDocument, archiveDocument } from "@/lib/server/kb";
import { errorResponse, json, httpError, readJsonBody, actorOf } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** POST part?index= (raw ≤512 KB) | complete { total_size } | approve | archive */
export async function POST(request, context) {
  try {
    await refreshGeminiConfig();
    const { docId, action } = await context.params;
    const actor = actorOf(request);
    switch (action) {
      case "part": {
        const index = Number(new URL(request.url).searchParams.get("index"));
        const declared = Number(request.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > 4 * 1024 * 1024) throw httpError("Part too large", 413);
        const buffer = Buffer.from(await request.arrayBuffer());
        return json({ ok: true, ...(await storeDocumentPart(docId, index, buffer)) });
      }
      case "complete": {
        const body = await readJsonBody(request);
        return json({ document: await completeDocumentUpload(docId, { total_size: body.total_size, actor }) });
      }
      case "approve":
        return json({ document: await approveDocument(docId, actor) });
      case "archive":
        return json({ document: await archiveDocument(docId, actor) });
      default:
        throw httpError(`Unknown action '${action}'`, 404);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
