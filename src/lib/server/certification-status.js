import { Type } from "@google/genai";
import { db } from "./db";
import { audit, listAudit } from "./audit";
import { httpError } from "./http";
import { getGeminiConfig, generateStructuredJson } from "./gemini";
import { buildKnowledgeContext, verifyRefs, KB_RULES, SOURCE_REF_SCHEMA } from "./kb";
import { getProcess } from "./processes";
import { agentKeyOf } from "./sessions";
import { pktStatusFor } from "./pkt";
import { nowIso } from "./storage";

/** Mandatory assessments per process (process.certification). */
export function certificationRequirements(process) {
  const c = process?.certification || {};
  return { require_voice: c.require_voice !== false, require_pkt: Boolean(c.require_pkt), auto_coaching: c.auto_coaching !== false };
}

/** Unified status for one agent in one process. */
export function unifiedStatus({ process, voiceResults, pktAttempts, agentKey }) {
  const req = certificationRequirements(process);
  const voice = voiceResults.filter(Boolean);
  const voicePassed = voice.some((r) => r.passed && !r.ztp_failed);
  const latestVoice = voice[voice.length - 1] || null;
  const pkt = pktStatusFor(pktAttempts, agentKey, process.process_id);
  const missing = [];
  if (req.require_voice && !voicePassed) missing.push(voice.length ? "Voice assessment not passed" : "Voice assessment not completed");
  if (req.require_pkt && !pkt.passed) missing.push(pkt.attempts ? "PKT not passed" : "PKT not completed");
  return {
    certified: missing.length === 0 && (req.require_voice || req.require_pkt),
    requirements: req,
    missing,
    voice: { attempts: voice.length, passed: voicePassed, latest_score: latestVoice ? latestVoice.percentage : null, best_score: voice.length ? Math.max(...voice.map((r) => Number(r.percentage) || 0)) : null, critical_failure: Boolean(latestVoice?.ztp_failed) },
    pkt,
  };
}

async function loadAgentData(process_id, agent_key) {
  const [sessions, results, attempts] = await Promise.all([db.listSessionsLite({ limit: 5000 }), db.listResults({ limit: 5000 }), db.listDocs("pkt_attempts", { process_id, agent_key, limit: 200 })]);
  const mine = sessions.filter((s) => s.process_id === process_id && agentKeyOf(s) === agent_key && s.status === "completed").sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const byId = new Map(results.map((r) => [r.session_id, r]));
  return { sessions: mine, voiceResults: mine.map((s) => byId.get(s.session_id)).filter(Boolean), attempts };
}

/** Re-evaluates certification after an assessment and records a decision in the audit trail when it changes. */
export async function recordCertificationDecision({ process_id, agent_key, agent_name, trigger, actor = "system" }) {
  if (!agent_key) return null;
  const process_ = await getProcess(process_id);
  if (!process_) return null;
  const data = await loadAgentData(process_id, agent_key);
  const status = unifiedStatus({ process: process_, voiceResults: data.voiceResults, pktAttempts: data.attempts, agentKey: agent_key });
  const history = (await listAudit({ process_id, limit: 2000 })).filter((e) => e.agent_key === agent_key && (e.action === "certification.granted" || e.action === "certification.revoked"));
  const lastGranted = history[0]?.action === "certification.granted";
  if (status.certified && !lastGranted) {
    await audit("certification.granted", { entity_type: "agent", entity_id: agent_key, process_id, agent_key, actor, summary: `${agent_name || agent_key} CERTIFIED for ${process_.process_name} (trigger: ${trigger})`, details: status });
  } else if (!status.certified && lastGranted) {
    await audit("certification.revoked", { entity_type: "agent", entity_id: agent_key, process_id, agent_key, actor, summary: `${agent_name || agent_key} certification no longer valid (${status.missing.join(", ")})`, details: status });
  } else {
    await audit("certification.evaluated", { entity_type: "agent", entity_id: agent_key, process_id, agent_key, actor, summary: `${agent_name || agent_key}: ${status.certified ? "certified" : `not certified - ${status.missing.join(", ")}`} (trigger: ${trigger})`, details: status });
  }
  return status;
}

// ---------------------------------------------------------------- coaching plans
const COACHING_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    priority_areas: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          area: { type: Type.STRING },
          why: { type: Type.STRING },
          evidence: { type: Type.ARRAY, items: { type: Type.STRING } },
          actions: { type: Type.ARRAY, items: { type: Type.STRING } },
          practice_drill: { type: Type.STRING },
          source_refs: { type: Type.ARRAY, items: SOURCE_REF_SCHEMA },
        },
        required: ["area", "why", "evidence", "actions", "practice_drill", "source_refs"],
      },
    },
    strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
    next_assessment: {
      type: Type.OBJECT,
      properties: { type: { type: Type.STRING, enum: ["voice", "pkt", "both"] }, focus_topics: { type: Type.ARRAY, items: { type: Type.STRING } }, scenario_categories: { type: Type.ARRAY, items: { type: Type.STRING } }, recommended_after_days: { type: Type.INTEGER } },
      required: ["type", "focus_topics", "scenario_categories", "recommended_after_days"],
    },
  },
  required: ["summary", "priority_areas", "strengths", "next_assessment"],
};

export async function generateCoachingPlan({ process_id, agent_key, trigger = "manual", actor = "system" }) {
  const process_ = await getProcess(process_id);
  if (!process_) throw httpError("Process not found", 404);
  if (!agent_key) throw httpError("agent_key is required", 400);
  const data = await loadAgentData(process_id, agent_key);
  const latestVoice = data.voiceResults[data.voiceResults.length - 1] || null;
  const scoredPkt = data.attempts.filter((a) => a.status === "scored" && a.result).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const latestPkt = scoredPkt[0] || null;
  if (!latestVoice && !latestPkt) throw httpError("No completed assessment for this agent yet.", 409);
  const agentName = latestPkt?.agent?.name || data.sessions[data.sessions.length - 1]?.agent_name || agent_key;

  const voiceBlock = latestVoice
    ? JSON.stringify({
        score: latestVoice.percentage,
        passed: latestVoice.passed,
        critical_failure: latestVoice.ztp_failed,
        weak_parameters: (latestVoice.parameters || []).filter((p) => p.status === "NC" || (p.status === "C" && p.marks < p.max_marks)).map((p) => ({ parameter: p.parameter, marks: `${p.marks}/${p.max_marks}`, reason: p.reason, evidence: (p.evidence || []).slice(0, 3).map((e) => `${e.speaker}: ${e.text}`) })),
        screen_check_failures: (latestVoice.screen_analysis?.verification || []).filter((v) => v.result === "fail" || v.result === "partial").map((v) => `${v.title}: ${v.result}${v.value_seen ? ` (seen: ${v.value_seen})` : ""}`),
      }, null, 1)
    : "(no voice assessment yet)";
  const pktBlock = latestPkt
    ? JSON.stringify({
        score: latestPkt.result.percentage,
        passed: latestPkt.result.passed,
        topic_performance: latestPkt.result.by_topic.map((t) => `${t.topic}: ${t.percentage}% (${t.correct}/${t.total})`),
        missed_questions: latestPkt.questions.filter((q) => !latestPkt.result.per_question.find((p) => p.id === q.id)?.correct).slice(0, 15).map((q) => ({ topic: q.topic, question: q.stem, correct_answer: q.correct.map((c) => q.options.find((o) => o.id === c)?.text).join(" | "), explanation: q.explanation })),
      }, null, 1)
    : "(no PKT yet)";

  const ctx = await buildKnowledgeContext(process_id, { maxChars: 250000 });
  const cfg = getGeminiConfig();
  const prompt = `You are a senior contact-center trainer. Write a targeted, practical coaching plan for agent "${agentName}" of process "${process_.process_name}" based on their latest assessment results.

${ctx.empty ? "No approved process documents are available - base the plan on the assessment evidence only and leave source_refs empty." : KB_RULES}

RULES
- 2-6 priority areas, most important first. Each: why (linked to the evidence), concrete evidence from the results, 2-5 specific actions (what to re-read, what to say/do differently - quote correct phrasing/policy from the documents), one practice drill, and citations to the SOP sections to revise.
- Be specific to this agent's mistakes; no generic advice.
- next_assessment: which fresh assessment to take next (voice / pkt / both), focus topics, scenario categories (information, complaint, objection, exception, escalation, retention) and after how many days.

LATEST VOICE ASSESSMENT:
${voiceBlock}

LATEST PROCESS KNOWLEDGE TEST:
${pktBlock}

${ctx.empty ? "" : `APPROVED PROCESS DOCUMENTS:\n${ctx.text}`}`;
  const { data: out } = await generateStructuredJson({ model: cfg.generationModel, parts: [{ text: prompt }], schema: COACHING_SCHEMA, temperature: 0.4 });
  const plan = {
    id: `CPL-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
    process_id,
    agent_key,
    status: "active",
    agent_name: agentName,
    trigger,
    summary: String(out.summary || "").slice(0, 2000),
    priority_areas: (out.priority_areas || []).slice(0, 6).map((p) => ({
      area: String(p.area || "").slice(0, 200),
      why: String(p.why || "").slice(0, 1000),
      evidence: (p.evidence || []).map((e) => String(e).slice(0, 500)).slice(0, 6),
      actions: (p.actions || []).map((e) => String(e).slice(0, 600)).slice(0, 6),
      practice_drill: String(p.practice_drill || "").slice(0, 800),
      source_refs: ctx.empty ? [] : verifyRefs(p.source_refs, ctx),
    })),
    strengths: (out.strengths || []).map((s) => String(s).slice(0, 300)).slice(0, 6),
    next_assessment: out.next_assessment || null,
    based_on: { voice_session: latestVoice?.session_id || null, voice_score: latestVoice?.percentage ?? null, pkt_attempt: latestPkt?.id || null, pkt_score: latestPkt?.result?.percentage ?? null },
    model: cfg.generationModel,
    created_by: actor,
    created_at: nowIso(),
  };
  const previous = await db.listDocs("coaching_plans", { process_id, agent_key, status: "active", limit: 20 });
  for (const p of previous) await db.saveDoc("coaching_plans", { ...p, status: "superseded" });
  await db.saveDoc("coaching_plans", plan);
  await audit("coaching.plan_created", { entity_type: "coaching_plan", entity_id: plan.id, process_id, agent_key, actor, summary: `Coaching plan for ${agentName}: ${plan.priority_areas.map((p) => p.area).join(", ")}`, details: { based_on: plan.based_on, trigger } });
  return plan;
}

export async function listCoachingPlans({ process_id, agent_key, status } = {}) {
  return db.listDocs("coaching_plans", { process_id: process_id || undefined, agent_key: agent_key || undefined, status: status || undefined, limit: 500 });
}

/** Called after any assessment: decision + automatic coaching for failures (never throws). */
export async function afterAssessment({ process_id, agent_key, agent_name, passed, trigger }) {
  try {
    await recordCertificationDecision({ process_id, agent_key, agent_name, trigger });
    const process_ = await getProcess(process_id);
    if (!passed && certificationRequirements(process_).auto_coaching && getGeminiConfig().configured) {
      await generateCoachingPlan({ process_id, agent_key, trigger: `auto:${trigger}` });
    }
  } catch (err) {
    console.error(`[afterAssessment] ${agent_key}:`, err.message);
  }
}
