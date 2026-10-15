import {
  refreshGeminiConfig,
  getGeminiConfig,
  GeminiNotConfiguredError,
  describeGeminiError,
} from "@/lib/server/gemini";
import { reanalyseSingleIssue } from "@/lib/server/kb";
import { errorResponse, json, httpError, readJsonBody, actorOf } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** POST { process_id } — re-run Gemini ONLY for this issue. Others stay untouched. */
export async function POST(request, { params }) {
  try {
    await refreshGeminiConfig();
    if (!getGeminiConfig().configured) throw new GeminiNotConfiguredError();
    const body = await readJsonBody(request);
    if (!body.process_id) throw httpError("process_id is required", 400);

    // ✅ Next.js 15: params is a Promise
    const { issueId: rawIssueId } = await params;
    const issueId = decodeURIComponent(rawIssueId);

    try {
      return json(
        await reanalyseSingleIssue({
          processId: body.process_id,
          issueId,
          actor: actorOf(request),
        })
      );
    } catch (err) {
      if (err.status) throw err;
      throw httpError(`Re-analysis failed: ${describeGeminiError(err)}`, 502);
    }
  } catch (err) {
    return errorResponse(err);
  }
}