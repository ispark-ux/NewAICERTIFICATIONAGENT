import { after } from "next/server";
import { refreshGeminiConfig } from "@/lib/server/gemini";
import { db } from "@/lib/server/db";
import { candidatePaper, startAttempt, saveAnswers, addEvents, submitAttempt, runProctoringReview, setRecording, verifyShareToken, finalizeExpired } from "@/lib/server/pkt";
import { afterAssessment } from "@/lib/server/certification-status";
import { planRecordingUpload, storeRecordingPart, verifyRecordingUpload } from "@/lib/server/recording-upload";
import { errorResponse, json, httpError, readJsonBody } from "@/lib/server/http";
import { nowIso } from "@/lib/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Candidate-only API for the shared PKT link (/pkt/{attemptId}/{token}).
 * Every request is authorised by the secret token in the path. Only candidate
 * actions are exposed - answer keys, explanations and sources never leave the server.
 */
const KINDS = new Set(["camera", "screen"]);
const kindOf = (v) => {
  if (!KINDS.has(v)) throw httpError("kind must be 'camera' or 'screen'", 400);
  return v;
};
const background = (fn) => {
  try {
    after(fn);
  } catch {
    fn();
  }
};

async function load(attemptId, token) {
  const a = await db.getDoc("pkt_attempts", attemptId);
  if (!a) throw httpError("This test link is invalid.", 404);
  verifyShareToken(a, token);
  return finalizeExpired(a);
}

const actorFor = (a) => `candidate:${a.agent?.name || a.agent_key}`;

export async function GET(request, context) {
  try {
    await refreshGeminiConfig();
    const { attemptId, token, action } = await context.params;
    const a = await load(attemptId, token);
    if (action !== "paper") throw httpError("Not found", 404);
    if (a.status === "review" || a.status === "generating") return json({ waiting: true, message: "Your test is being prepared by your trainer. Keep this page open - it refreshes automatically.", title: a.blueprint?.title, agent: a.agent });
    if (a.status === "scored") return json({ finished: true, title: a.blueprint?.title, agent: a.agent, result: a.blueprint?.show_result_to_agent !== false ? { percentage: a.result.percentage, passed: a.result.passed, passing_score: a.result.passing_score, correct: a.result.correct, total: a.result.total } : null });
    if (!["ready", "in_progress"].includes(a.status)) throw httpError(`This test is ${a.status.replace(/_/g, " ")}. Contact your trainer.`, 409);
    return json({ paper: candidatePaper(a) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request, context) {
  try {
    await refreshGeminiConfig();
    const { attemptId, token, action } = await context.params;
    const a = await load(attemptId, token);
    const actor = actorFor(a);
    switch (action) {
      case "start":
        return json({ paper: candidatePaper(await startAttempt(attemptId, actor)) });
      case "answers":
        return json(await saveAnswers(attemptId, (await readJsonBody(request)).answers));
      case "events":
        return json(await addEvents(attemptId, (await readJsonBody(request)).events));
      case "submit": {
        const body = await readJsonBody(request);
        const s = await submitAttempt(attemptId, { answers: body.answers, reason: body.reason || "submitted", actor });
        background(() => afterAssessment({ process_id: s.process_id, agent_key: s.agent_key, agent_name: s.agent?.name, passed: s.result?.passed, trigger: `pkt ${s.id}` }));
        const show = s.blueprint?.show_result_to_agent !== false;
        return json({ result: show ? { percentage: s.result.percentage, score: s.result.score, max: s.result.max, passed: s.result.passed, passing_score: s.result.passing_score, correct: s.result.correct, total: s.result.total, integrity: s.proctoring?.integrity } : { hidden: true } });
      }
      case "proctoring-review":
        if (a.blueprint?.proctoring?.ai_review !== false) background(() => runProctoringReview(attemptId, "system"));
        return json({ ok: true }, { status: 202 });
      case "upload-url": {
        const body = await readJsonBody(request);
        return json(await planRecordingUpload(attemptId, kindOf(body.kind), body));
      }
      case "upload-part": {
        const kind = kindOf(new URL(request.url).searchParams.get("kind"));
        return json({ ok: true, ...(await storeRecordingPart(attemptId, kind, request)) });
      }
      case "upload-complete": {
        const body = await readJsonBody(request);
        const kind = kindOf(body.kind);
        const info = await verifyRecordingUpload(attemptId, kind, body.total_size);
        const rec = { size_bytes: info.size_bytes, parts: info.parts, storage: info.storage, mime_type: String(body.mime_type || "video/webm").slice(0, 100), duration_seconds: Number(body.meta?.duration_seconds) || null, uploaded_at: nowIso() };
        await setRecording(attemptId, kind, rec);
        return json({ ok: true, recording: rec });
      }
      default:
        throw httpError("Not found", 404);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
