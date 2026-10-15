import { refreshGeminiConfig } from "@/lib/server/gemini";
import { after } from "next/server";
import { listAttempts, createAttempt, runGeneration } from "@/lib/server/pkt";
import { assertPersistentStorage } from "@/lib/server/db";
import { getGeminiConfig, GeminiNotConfiguredError } from "@/lib/server/gemini";
import { errorResponse, json, readJsonBody, actorOf } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** GET /api/pkt/attempts?process_id=&agent_id=&status= (list without questions) */
export async function GET(request) {
  try {
    await refreshGeminiConfig();
    const url = new URL(request.url);
    const agentId = url.searchParams.get("agent_id");
    const attempts = await listAttempts({ process_id: url.searchParams.get("process_id"), agent_key: agentId ? `id:${agentId}` : null, status: url.searchParams.get("status") });
    return json({ attempts: attempts.map(({ questions, answers, ...a }) => ({ ...a, question_count: (questions || []).length, proctoring: a.proctoring ? { ...a.proctoring, events: undefined, event_count: (a.proctoring.events || []).length } : null })) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST { blueprint_id, agent_id, mode } - assigns a test; a fresh paper is generated in the background */
export async function POST(request) {
  try {
    await refreshGeminiConfig();
    assertPersistentStorage();
    if (!getGeminiConfig().configured) throw new GeminiNotConfiguredError();
    const body = await readJsonBody(request);
    const actor = actorOf(request);
    const attempt = await createAttempt({ ...body, actor });
    const job = () => runGeneration(attempt.id, actor);
    try {
      after(job);
    } catch {
      job();
    }
    return json({ attempt }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
