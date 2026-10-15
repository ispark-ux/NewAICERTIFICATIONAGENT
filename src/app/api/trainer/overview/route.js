import { refreshGeminiConfig } from "@/lib/server/gemini";
import { db } from "@/lib/server/db";
import { listProcesses } from "@/lib/server/processes";
import { computeAnalytics } from "@/lib/server/analytics";
import { summarizePkt } from "@/lib/server/pkt";
import { getKnowledgeAnalysis } from "@/lib/server/kb";
import { errorResponse, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/trainer/overview?process_id= - pending work, agents (voice + PKT + certification), recurring failures */
export async function GET(request) {
  try {
    await refreshGeminiConfig();
    const processId = new URL(request.url).searchParams.get("process_id") || null;
    const [sessions, results, processes, agents, pktAttempts, docs, scenarios, plans] = await Promise.all([
      db.listSessionsLite({ limit: 5000 }),
      db.listResults({ limit: 5000 }),
      listProcesses({ includeInactive: true }),
      db.listAgents().catch(() => []),
      db.listDocs("pkt_attempts", { process_id: processId || undefined, limit: 3000 }),
      db.listDocs("kb_documents", { process_id: processId || undefined, limit: 2000 }),
      db.listDocs("scenarios", { process_id: processId || undefined, limit: 2000 }),
      db.listDocs("coaching_plans", { process_id: processId || undefined, status: "active", limit: 2000 }),
    ]);
    const analytics = computeAnalytics({ sessions, results, processes, agents, pktAttempts, filters: { process_id: processId } });
    const analyses = await Promise.all((processId ? [processId] : processes.map((p) => p.process_id)).map((id) => getKnowledgeAnalysis(id).catch(() => null)));
    const planByAgent = new Map(plans.map((p) => [`${p.process_id}|${p.agent_key}`, { id: p.id, created_at: p.created_at, areas: p.priority_areas.map((a) => a.area) }]));
    return json({
      pending: {
        docs_draft: docs.filter((d) => d.status === "draft").length,
        docs_failed: docs.filter((d) => d.status === "failed").length,
        docs_approved: docs.filter((d) => d.status === "approved").length,
        scenarios_review: scenarios.filter((s) => s.status === "draft" || s.status === "needs_review").length,
        scenarios_flagged: scenarios.filter((s) => s.status === "needs_review").length,
        scenarios_approved: scenarios.filter((s) => s.status === "approved").length,
        papers_review: pktAttempts.filter((a) => a.status === "review").length,
        pkt_ready: pktAttempts.filter((a) => a.status === "ready").length,
        pkt_in_progress: pktAttempts.filter((a) => a.status === "in_progress").length,
        kb_issues: analyses.reduce((s, a) => s + (a?.issues?.length || 0), 0),
        kb_issues_high: analyses.reduce((s, a) => s + (a?.issues || []).filter((i) => i.severity === "high").length, 0),
      },
      overview: analytics.overview,
      agents: analytics.agents.map((a) => ({ ...a, coaching: planByAgent.get(`${a.process_id}|${a.key}`) || null })),
      voice_pareto: analytics.pareto.parameters_by_marks.rows.slice(0, 8),
      screen_pareto: analytics.pareto.screen_checks.rows.slice(0, 6),
      pkt: summarizePkt(pktAttempts),
      recent_pkt: pktAttempts.slice(0, 15).map((a) => ({ id: a.id, agent: a.agent?.name, status: a.status, percentage: a.result?.percentage ?? null, passed: a.result?.passed ?? null, integrity: a.proctoring?.integrity?.status || null, created_at: a.created_at, title: a.blueprint?.title })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
