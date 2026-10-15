import { refreshGeminiConfig } from "@/lib/server/gemini";
import { getDocument, deleteDocument } from "@/lib/server/kb";
import { errorResponse, json, actorOf } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/kb/documents/{id} - includes extracted text */
export async function GET(request, context) {
  try {
    await refreshGeminiConfig();
    const { docId } = await context.params;
    return json({ document: await getDocument(docId) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request, context) {
  try {
    await refreshGeminiConfig();
    const { docId } = await context.params;
    await deleteDocument(docId, actorOf(request));
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
