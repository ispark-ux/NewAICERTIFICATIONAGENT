import { refreshGeminiConfig } from "@/lib/server/gemini";
import { saveTrainerRemark } from "@/lib/server/kb";
import { errorResponse, json, httpError, readJsonBody, actorOf } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PATCH { process_id, remark, status } — save trainer remark on ONE issue (no Gemini call). */
export async function PATCH(request, { params }) {
  try {
    await refreshGeminiConfig();
    const body = await readJsonBody(request);
    if (!body.process_id) throw httpError("process_id is required", 400);

    // ✅ Next.js 15: params is a Promise
    const { issueId: rawIssueId } = await params;
    const issueId = decodeURIComponent(rawIssueId);

    const result = await saveTrainerRemark({
      processId: body.process_id,
      issueId,
      remark: typeof body.remark === "string" ? body.remark : "",
      status: body.status,
      actor: actorOf(request),
    });
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
}