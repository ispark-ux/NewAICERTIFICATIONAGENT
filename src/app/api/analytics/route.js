import { refreshGeminiConfig } from "@/lib/server/gemini";
import { db } from "@/lib/server/db";
import { listProcesses } from "@/lib/server/processes";
import { computeAnalytics } from "@/lib/server/analytics";
import { errorResponse, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/analytics?process_id=&from=&to= -> overview, sections, parameters, pareto, processes, agents */
export async function GET(request) {
  try {
    await refreshGeminiConfig();
    const url = new URL(request.url);
    const filters = {
      process_id: url.searchParams.get("process_id") || null,
      from: url.searchParams.get("from") || null,
      to: url.searchParams.get("to") || null,
    };
    const [sessions, results, processes, agents, pktAttempts] = await Promise.all([
      db.listSessionsLite({ limit: 5000 }),
      db.listResults({ limit: 5000 }),
      listProcesses({ includeInactive: true }),
      db.listAgents().catch(() => []),
      db.listDocs("pkt_attempts", { limit: 3000 }).catch(() => []),
    ]);
    return json(computeAnalytics({ sessions, results, processes, agents, pktAttempts, filters }));
  } catch (err) {
    return errorResponse(err);
  }
}
