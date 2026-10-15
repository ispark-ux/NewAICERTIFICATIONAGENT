import { refreshGeminiConfig } from "@/lib/server/gemini";
import { listDocuments, createDocumentUpload, createTextDocument, DOC_TYPES } from "@/lib/server/kb";
import { assertPersistentStorage } from "@/lib/server/db";
import { errorResponse, json, httpError, readJsonBody, actorOf } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/kb/documents?process_id= */
export async function GET(request) {
  try {
    await refreshGeminiConfig();
    const processId = new URL(request.url).searchParams.get("process_id");
    if (!processId) throw httpError("process_id is required", 400);
    return json({ documents: await listDocuments(processId), doc_types: DOC_TYPES });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/kb/documents  file: { process_id, title, doc_type, file_name, mime_type, size, replaces_id? }  |  text: { ..., text } */
export async function POST(request) {
  try {
    await refreshGeminiConfig();
    assertPersistentStorage();
    const body = await readJsonBody(request);
    const actor = actorOf(request);
    if (typeof body.text === "string") return json({ document: await createTextDocument({ ...body, actor }) }, { status: 201 });
    return json(await createDocumentUpload({ ...body, actor }), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
