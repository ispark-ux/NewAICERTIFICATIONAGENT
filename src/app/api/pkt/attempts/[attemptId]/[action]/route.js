import { refreshGeminiConfig } from "@/lib/server/gemini";
import { after } from "next/server";
import { db } from "@/lib/server/db";
import {
  getAttempt,
  runGeneration,
  regenerate,
  removeQuestion,
  approvePaper,
  startAttempt,
  candidatePaper,
  saveAnswers,
  addEvents,
  submitAttempt,
  cancelAttempt,
  invalidateAttempt,
  runProctoringReview,
  setRecording,
  createAttempt,
  ensureShareToken,
} from "@/lib/server/pkt";
import { getEmailSettings } from "@/lib/server/certifications";
import { renderPktInviteEmail, sendMail, emailConfigured } from "@/lib/server/email";
import { audit } from "@/lib/server/audit";
import { publicBaseUrl } from "@/lib/server/http";
import { afterAssessment } from "@/lib/server/certification-status";
import { planRecordingUpload, storeRecordingPart, verifyRecordingUpload } from "@/lib/server/recording-upload";
import { streamParts } from "@/lib/server/recording-stream";
import { errorResponse, json, httpError, readJsonBody, actorOf } from "@/lib/server/http";
import { nowIso } from "@/lib/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const KINDS = new Set(["camera", "screen"]);
function kindOf(v) {
  if (!KINDS.has(v)) throw httpError("kind must be 'camera' or 'screen'", 400);
  return v;
}
function background(fn) {
  try {
    after(fn);
  } catch {
    fn();
  }
}

export async function POST(request, context) {
  try {
    await refreshGeminiConfig();
    const { attemptId, action } = await context.params;
    const actor = actorOf(request);
    switch (action) {
      case "regenerate": {
        await regenerate(attemptId, actor);
        background(() => runGeneration(attemptId, actor));
        return json({ ok: true }, { status: 202 });
      }
      case "remove-question": {
        const body = await readJsonBody(request);
        return json({ attempt: await removeQuestion(attemptId, body.question_id, actor) });
      }
      case "approve":
        return json({ attempt: await approvePaper(attemptId, actor) });
      case "start":
        return json({ paper: candidatePaper(await startAttempt(attemptId, actor)) });
      case "answers":
        return json(await saveAnswers(attemptId, (await readJsonBody(request)).answers));
      case "events":
        return json(await addEvents(attemptId, (await readJsonBody(request)).events));
      case "submit": {
        const body = await readJsonBody(request);
        const a = await submitAttempt(attemptId, { answers: body.answers, reason: body.reason || "submitted", actor });
        background(() => afterAssessment({ process_id: a.process_id, agent_key: a.agent_key, agent_name: a.agent?.name, passed: a.result?.passed, trigger: `pkt ${a.id}` }));
        return json({ result: { percentage: a.result.percentage, score: a.result.score, max: a.result.max, passed: a.result.passed, passing_score: a.result.passing_score, correct: a.result.correct, total: a.result.total, by_topic: a.result.by_topic, integrity: a.proctoring?.integrity } });
      }
      case "cancel":
        return json({ attempt: await cancelAttempt(attemptId, actor, (await readJsonBody(request)).reason) });
      case "invalidate": {
        const a = await invalidateAttempt(attemptId, actor, (await readJsonBody(request)).reason);
        background(() => afterAssessment({ process_id: a.process_id, agent_key: a.agent_key, agent_name: a.agent?.name, passed: true, trigger: `pkt invalidated ${a.id}` }));
        return json({ attempt: a });
      }
      case "retest": {
        const prev = await getAttempt(attemptId);
        const body = await readJsonBody(request);
        const a = await createAttempt({ blueprint_id: prev.blueprint_id, agent_id: prev.agent.id, mode: body.mode || prev.mode, actor });
        background(() => runGeneration(a.id, actor));
        return json({ attempt: a }, { status: 202 });
      }
      case "share": {
        // { send_email?, rotate? } -> personal candidate link (for WFH agents)
        const body = await readJsonBody(request);
        const { attempt: a, token } = await ensureShareToken(attemptId, { rotate: Boolean(body.rotate) });
        if (["scored", "cancelled", "invalidated"].includes(a.status)) throw httpError(`This test is ${a.status} - create a retest to share a new link.`, 409);
        const url = `${publicBaseUrl(request)}/pkt/${a.id}/${token}`;
        let email = null;
        if (body.send_email) {
          if (!a.agent?.email) throw httpError("This agent has no email address - copy the link instead.", 400);
          const settings = await getEmailSettings();
          if (!emailConfigured(settings)) throw httpError("Email is not configured (Settings → Email). Copy the link instead.", 400);
          const { subject, html, text } = renderPktInviteEmail({ attempt: a, url });
          const info = await sendMail(settings, { to: [a.agent.email], cc: settings.notify_cc, subject, html, text });
          email = { status: "sent", to: info.to, at: nowIso() };
          await db.saveDoc("pkt_attempts", { ...a, invite_email: email });
        }
        await audit(body.rotate ? "pkt.link_rotated" : "pkt.link_shared", { entity_type: "pkt_attempt", entity_id: a.id, process_id: a.process_id, agent_key: a.agent_key, actor, summary: `${body.rotate ? "New test link created" : "Test link shared"} for ${a.agent?.name}${email ? ` - emailed to ${a.agent.email}` : ""}` });
        return json({ url, email, status: a.status });
      }
      case "proctoring-review": {
        const a = await getAttempt(attemptId);
        if (a.blueprint?.proctoring?.ai_review === false) return json({ skipped: true });
        background(() => runProctoringReview(attemptId, actor));
        return json({ ok: true }, { status: 202 });
      }
      case "upload-url": {
        const body = await readJsonBody(request);
        await getAttempt(attemptId);
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
        throw httpError(`Unknown action '${action}'`, 404);
    }
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(request, context) {
  try {
    await refreshGeminiConfig();
    const { attemptId, action } = await context.params;
    switch (action) {
      case "paper": {
        const a = await getAttempt(attemptId);
        if (!["ready", "in_progress"].includes(a.status)) throw httpError(a.status === "review" ? "The paper is waiting for trainer approval." : `This test is ${a.status.replace(/_/g, " ")}.`, 409);
        return json({ paper: candidatePaper(a) });
      }
      case "recording": {
        const kind = kindOf(new URL(request.url).searchParams.get("type"));
        const access = await db.getRecordingAccess(attemptId, kind);
        if (!access) throw httpError(`No ${kind} recording for this test.`, 404);
        return streamParts(access, kind === "camera" ? "screen" : "screen", request.headers.get("range"));
      }
      default:
        throw httpError(`Unknown action '${action}'`, 404);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
