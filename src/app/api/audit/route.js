import { refreshGeminiConfig } from "@/lib/server/gemini";
import { listAudit } from "@/lib/server/audit";
import { errorResponse, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/audit?process_id=&limit= */
export async function GET(request) {
  try {
    await refreshGeminiConfig();
    const url = new URL(request.url);
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit")) || 500));
    return json({ entries: await listAudit({ process_id: url.searchParams.get("process_id") || undefined, limit }) });
  } catch (err) {
    return errorResponse(err);
  }
}
