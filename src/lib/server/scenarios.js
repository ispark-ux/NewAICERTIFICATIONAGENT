import { Type } from "@google/genai";
import { db } from "./db";
import { audit } from "./audit";
import { httpError } from "./http";
import { getGeminiConfig, generateStructuredJson } from "./gemini";
import { buildKnowledgeContext, verifyRefs, KB_RULES, SOURCE_REF_SCHEMA } from "./kb";
import { getProcess } from "./processes";
import { agentKeyOf } from "./sessions";
import { nowIso } from "./storage";

export const SCENARIO_CATEGORIES = ["information", "complaint", "objection", "exception", "escalation", "retention", "other"];
const DIFFICULTIES = ["easy", "medium", "hard"];
const rid = () => `SCN-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

const KV = { type: Type.OBJECT, properties: { key: { type: Type.STRING }, value: { type: Type.STRING } }, required: ["key", "value"] };
const SCENARIO_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    scenarios: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          category: { type: Type.STRING, enum: SCENARIO_CATEGORIES },
          intent: { type: Type.STRING },
          difficulty: { type: Type.STRING, enum: DIFFICULTIES },
          summary: { type: Type.STRING },
          customer_name: { type: Type.STRING },
          customer_gender: { type: Type.STRING },
          customer_mood: { type: Type.STRING },
          customer_facts: { type: Type.ARRAY, items: KV },
          hidden_facts: { type: Type.ARRAY, items: KV },
          opening_line: { type: Type.STRING },
          ai_prompt: { type: Type.STRING },
          expected_resolution: { type: Type.STRING },
          evaluator_notes: { type: Type.STRING },
          required_probing: { type: Type.ARRAY, items: { type: Type.STRING } },
          expected_portal_actions: { type: Type.ARRAY, items: { type: Type.STRING } },
          expected_crm_actions: { type: Type.ARRAY, items: { type: Type.STRING } },
          escalation_required: { type: Type.BOOLEAN },
          escalation_path: { type: Type.STRING },
          source_refs: { type: Type.ARRAY, items: SOURCE_REF_SCHEMA },
          ambiguities: {
            type: Type.ARRAY,
            items: { type: Type.OBJECT, properties: { description: { type: Type.STRING }, severity: { type: Type.STRING, enum: ["high", "medium", "low"] }, source_refs: { type: Type.ARRAY, items: SOURCE_REF_SCHEMA } }, required: ["description", "severity", "source_refs"] },
          },
        },
        required: ["title", "category", "intent", "difficulty", "summary", "customer_name", "customer_mood", "customer_facts", "hidden_facts", "opening_line", "ai_prompt", "expected_resolution", "evaluator_notes", "required_probing", "expected_portal_actions", "expected_crm_actions", "escalation_required", "escalation_path", "source_refs", "ambiguities"],
      },
    },
    kb_issues: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["scenarios", "kb_issues"],
};

const snake = (k) => String(k || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "detail";
const str = (v, n = 4000) => String(v ?? "").trim().slice(0, n);
const arr = (v, n = 20, len = 300) => (Array.isArray(v) ? v : []).map((x) => str(x, len)).filter(Boolean).slice(0, n);

export async function generateScenarios({ process_id, count = 5, categories = [], difficulty = "mixed", focus = "", actor }) {
  const process_ = await getProcess(process_id);
  if (!process_) throw httpError("Process not found", 404);
  const ctx = await buildKnowledgeContext(process_id);
  if (ctx.empty) throw httpError("Approve at least one document in the knowledge base before generating scenarios.", 409);
  const n = Math.max(1, Math.min(10, Math.round(Number(count) || 5)));
  const cats = (Array.isArray(categories) ? categories : []).filter((c) => SCENARIO_CATEGORIES.includes(c));
  const existing = await db.listDocs("scenarios", { process_id, limit: 300 });
  const cfg = getGeminiConfig();

  const prompt = `You design realistic customer-call scenarios to certify contact-center agents of "${process_.process_name}". Each scenario is role-played live by an AI voice customer, so it must be specific and playable.

${KB_RULES}

GENERATE ${n} DISTINCT SCENARIOS
- Categories to cover: ${cats.length ? cats.join(", ") : "a balanced mix of information requests, complaints, objections, policy exceptions and escalations"}.
- Difficulty: ${difficulty === "mixed" ? "mix easy, medium and hard" : difficulty}. Hard = upset customer, multiple issues, objection handling or an escalation decision.
${focus ? `- Trainer focus: ${str(focus, 500)}` : ""}
- Call language: ${process_.language || "Hindi/Hinglish"} (opening_line and the customer's lines in ai_prompt must be in this language; everything else in English).
- Do NOT repeat these existing scenarios: ${existing.map((s) => s.title).slice(0, 80).join(" | ") || "(none)"}.
- Invent realistic customer details (name, IDs such as order/ticket numbers in the same style as "${Object.values(process_.customer_profile || {}).filter((v) => /[A-Z]{1,4}\d{3,}/.test(String(v))).join(", ") || "ST12345"}", dates, amounts) - but every POLICY fact (eligibility, timelines, charges, steps, escalation rules) must come from the documents with citations.

FIELDS
- customer_facts: what the customer knows and shares only when asked (key/value, e.g. order_id / ST48213).
- hidden_facts: what the customer does NOT know and the agent must find in the system or explain (e.g. order_status / Delayed, refund_eligibility / Not eligible after 7 days) - derived from the documents.
- opening_line: the customer's first sentence.
- ai_prompt: a complete role-play prompt for the AI customer in this structure: who you are and why you call; WHAT YOU KNOW (share only when asked); WHAT YOU DO NOT KNOW (never say it); HOW TO RESPOND (correct answer -> accept; wrong/contradicting answer -> push back; closing without resolution -> follow up; hold -> wait; objections the customer raises); MOOD.
- expected_resolution: exactly what a correct agent must tell/do, per the documents.
- evaluator_notes: correct resolution, mandatory steps, required probing, whether hold/transfer/escalation is expected, common mistakes to penalise.
- expected_portal_actions / expected_crm_actions: system steps the documents require (empty if none).
- escalation_required + escalation_path (per the escalation matrix, or "" if not required).
- source_refs: citations for the policy facts used. ambiguities: anything you could not resolve from the documents (empty array if none).
- kb_issues: general problems in the documents you noticed (conflicts/gaps), else empty.

APPROVED PROCESS DOCUMENTS${ctx.truncated ? " (long documents were truncated)" : ""}:
${ctx.text}`;

  const { data } = await generateStructuredJson({ model: cfg.generationModel, parts: [{ text: prompt }], schema: SCENARIO_SCHEMA, temperature: 0.8 });
  const now = nowIso();
  const saved = [];
  for (const s of (data.scenarios || []).slice(0, n)) {
    const ambiguities = (s.ambiguities || []).map((a) => ({ description: str(a.description, 800), severity: a.severity || "medium", source_refs: verifyRefs(a.source_refs, ctx) })).filter((a) => a.description);
    const doc = {
      id: rid(),
      process_id,
      agent_key: null,
      status: ambiguities.length ? "needs_review" : "draft",
      title: str(s.title, 200) || "Untitled scenario",
      category: SCENARIO_CATEGORIES.includes(s.category) ? s.category : "other",
      intent: str(s.intent, 300),
      difficulty: DIFFICULTIES.includes(s.difficulty) ? s.difficulty : "medium",
      summary: str(s.summary, 1500),
      customer: {
        name: str(s.customer_name, 80) || "Customer",
        gender: str(s.customer_gender, 20),
        mood: str(s.customer_mood, 300),
        facts: (s.customer_facts || []).map((f) => ({ key: snake(f.key), value: str(f.value, 200) })).filter((f) => f.value).slice(0, 15),
      },
      hidden_facts: (s.hidden_facts || []).map((f) => ({ key: snake(f.key), value: str(f.value, 400) })).filter((f) => f.value).slice(0, 15),
      opening_line: str(s.opening_line, 500),
      ai_prompt: str(s.ai_prompt, 12000),
      expected_resolution: str(s.expected_resolution, 3000),
      evaluator_notes: str(s.evaluator_notes, 5000),
      required_probing: arr(s.required_probing),
      expected_portal_actions: arr(s.expected_portal_actions),
      expected_crm_actions: arr(s.expected_crm_actions),
      escalation_required: Boolean(s.escalation_required),
      escalation_path: str(s.escalation_path, 500),
      source_refs: verifyRefs(s.source_refs, ctx),
      ambiguities,
      kb_documents: ctx.docs,
      generated_by: actor,
      model: cfg.generationModel,
      generated_at: now,
      usage_count: 0,
    };
    if (!doc.opening_line || !doc.ai_prompt) continue;
    await db.saveDoc("scenarios", doc);
    saved.push(doc);
  }
  const kbIssues = arr(data.kb_issues, 20, 600);
  await audit("scenario.generated", { entity_type: "scenario", entity_id: saved.map((s) => s.id).join(","), process_id, actor, summary: `${saved.length} scenario(s) generated${saved.filter((s) => s.ambiguities.length).length ? `, ${saved.filter((s) => s.ambiguities.length).length} flagged for ambiguity` : ""}`, details: { ids: saved.map((s) => s.id), kb_issues: kbIssues, documents: ctx.docs } });
  return { scenarios: saved, kb_issues: kbIssues };
}

export async function listScenarios(process_id, status) {
  return db.listDocs("scenarios", { process_id: process_id || undefined, status: status || undefined, limit: 500 });
}

export async function getScenario(id) {
  const s = await db.getDoc("scenarios", id);
  if (!s) throw httpError("Scenario not found", 404);
  return s;
}

const EDITABLE = ["title", "summary", "opening_line", "ai_prompt", "expected_resolution", "evaluator_notes", "escalation_path", "difficulty", "category"];

export async function updateScenario(id, patch, actor) {
  const s = await getScenario(id);
  const next = { ...s };
  for (const k of EDITABLE) if (patch[k] !== undefined) next[k] = str(patch[k], k === "ai_prompt" ? 12000 : 5000);
  for (const k of ["required_probing", "expected_portal_actions", "expected_crm_actions"]) if (patch[k] !== undefined) next[k] = arr(typeof patch[k] === "string" ? patch[k].split(/\n/) : patch[k]);
  if (patch.escalation_required !== undefined) next.escalation_required = Boolean(patch.escalation_required);
  if (next.status === "approved") next.status = "draft"; // edited content must be re-approved
  next.edited_by = actor;
  next.edited_at = nowIso();
  await db.saveDoc("scenarios", next);
  await audit("scenario.edited", { entity_type: "scenario", entity_id: id, process_id: s.process_id, actor, summary: `Scenario "${next.title}" edited`, details: { fields: Object.keys(patch) } });
  return next;
}

/** approve (publish) / reject / archive / draft. Flagged scenarios need acknowledgement. */
export async function setScenarioStatus(id, action, { actor, note = "", acknowledge = false } = {}) {
  const s = await getScenario(id);
  const map = { approve: "approved", reject: "rejected", archive: "archived", draft: "draft" };
  const status = map[action];
  if (!status) throw httpError("Unknown action", 400);
  if (status === "approved" && s.ambiguities?.length && !acknowledge) throw httpError("This scenario has flagged ambiguities. Review them and confirm they are resolved (acknowledge) before publishing.", 409);
  const next = { ...s, status, review_note: str(note, 1000) || s.review_note || "", reviewed_by: actor, reviewed_at: nowIso(), ...(status === "approved" ? { approved_by: actor, approved_at: nowIso(), ambiguities_acknowledged: Boolean(s.ambiguities?.length) } : {}) };
  await db.saveDoc("scenarios", next);
  await audit(`scenario.${status}`, { entity_type: "scenario", entity_id: id, process_id: s.process_id, actor, summary: `Scenario "${s.title}" ${status}${note ? ` - ${note}` : ""}` });
  return next;
}

/** Stable copy stored on the certification session. */
export function scenarioSnapshot(s) {
  if (!s) return null;
  const { kb_documents, generated_by, model, usage_count, body, ...rest } = s;
  return rest;
}

/** Overlays a scenario on the process configuration used by the AI customer + evaluator. */
export function applyScenario(process, scenario) {
  if (!process || !scenario) return process;
  const facts = Object.fromEntries((scenario.customer?.facts || []).map((f) => [f.key, f.value]));
  const hidden = Object.fromEntries((scenario.hidden_facts || []).map((f) => [f.key, f.value]));
  const notes = [
    scenario.evaluator_notes,
    scenario.expected_resolution ? `EXPECTED RESOLUTION: ${scenario.expected_resolution}` : "",
    `ESCALATION: ${scenario.escalation_required ? `required - ${scenario.escalation_path || "as per the escalation matrix"}` : "not required for this scenario"}.`,
    scenario.source_refs?.length ? `SOURCES: ${scenario.source_refs.map((r) => `${r.doc_title} §${r.section}: "${r.quote}"`).join(" | ")}` : "",
  ].filter(Boolean).join("\n\n");
  return {
    ...process,
    customer_profile: { name: scenario.customer?.name || "Customer", ...(scenario.customer?.gender ? { gender: scenario.customer.gender } : {}), ...facts, mood: scenario.customer?.mood || "" },
    scenario: {
      title: scenario.title,
      customer_problem: scenario.summary,
      opening_line: scenario.opening_line,
      customer_known_facts: (scenario.customer?.facts || []).map((f) => `${f.key.replace(/_/g, " ")}: ${f.value}`),
      hidden_information: { ...hidden, correct_resolution: scenario.expected_resolution },
    },
    ai_prompt: scenario.ai_prompt,
    evaluator_notes: notes,
    required_probing: scenario.required_probing?.length ? scenario.required_probing : process.required_probing,
    expected_portal_actions: scenario.expected_portal_actions?.length ? scenario.expected_portal_actions : process.expected_portal_actions,
    expected_crm_actions: scenario.expected_crm_actions?.length ? scenario.expected_crm_actions : process.expected_crm_actions,
    scenario_id: scenario.id,
    scenario_category: scenario.category,
    scenario_difficulty: scenario.difficulty,
  };
}

/** Process config actually used for a session (scenario snapshot applied). */
export async function getEffectiveProcess(session) {
  const process_ = await getProcess(session?.process_id);
  if (!process_) return null;
  return session?.scenario_snapshot ? applyScenario(process_, session.scenario_snapshot) : process_;
}

/**
 * Chooses the scenario for a new voice assessment.
 *   mode "default"  -> none (process default scenario)
 *   mode "specific" -> scenarioId (must be approved)
 *   mode "random" / "auto" -> an approved scenario the agent has not had yet (least used first);
 *                    "auto" falls back to the process default when no scenario is approved.
 */
export async function chooseScenario({ process_id, mode = "auto", scenarioId = null, agentLike = null }) {
  if (mode === "default") return null;
  if (mode === "specific") {
    const s = await getScenario(scenarioId);
    if (s.process_id !== process_id) throw httpError("Scenario belongs to another process.", 400);
    if (s.status !== "approved") throw httpError("Only approved (published) scenarios can be assigned.", 409);
    return s;
  }
  const approved = await db.listDocs("scenarios", { process_id, status: "approved", limit: 500 });
  if (!approved.length) {
    if (mode === "random") throw httpError("No approved scenarios for this process yet - generate and approve some first.", 409);
    return null;
  }
  const key = agentKeyOf(agentLike || {});
  const sessions = await db.listSessionsLite({ limit: 5000 });
  const usedByAgent = new Set(key ? sessions.filter((s) => s.process_id === process_id && agentKeyOf(s) === key && s.scenario_id).map((s) => s.scenario_id) : []);
  const usage = new Map();
  for (const s of sessions) if (s.scenario_id) usage.set(s.scenario_id, (usage.get(s.scenario_id) || 0) + 1);
  const fresh = approved.filter((s) => !usedByAgent.has(s.id));
  const pool = fresh.length ? fresh : approved;
  const minUse = Math.min(...pool.map((s) => usage.get(s.id) || 0));
  const least = pool.filter((s) => (usage.get(s.id) || 0) === minUse);
  return least[Math.floor(Math.random() * least.length)];
}

export async function markScenarioUsed(scenario) {
  if (!scenario) return;
  try {
    const s = await db.getDoc("scenarios", scenario.id, { withBody: false });
    if (s) await db.saveDoc("scenarios", { ...s, usage_count: (Number(s.usage_count) || 0) + 1, last_used_at: nowIso() });
  } catch {
    /* non-critical */
  }
}
