import crypto from "crypto";
import { Type } from "@google/genai";
import { db } from "./db";
import { audit } from "./audit";
import { httpError } from "./http";
import { getGeminiConfig, generateStructuredJson, describeGeminiError } from "./gemini";
import { buildKnowledgeContext, verifyRefs, KB_RULES, SOURCE_REF_SCHEMA, getKnowledgeAnalysis } from "./kb";
import { getProcess } from "./processes";
import { uploadMediaToGemini } from "./screen-analysis";
import { nowIso } from "./storage";

/**
 * Process Knowledge Test (PKT)
 *   blueprint (trainer config)  ->  attempt = fresh AI paper per test / retest
 *   generating -> review (trainer approves) -> ready -> in_progress -> scored
 *   (failed_generation | cancelled | invalidated)
 * The test is taken INSIDE the admin panel (no public link) with camera + screen
 * proctoring. Answer keys never leave the server until the attempt is scored.
 */

export const QUESTION_TYPES = ["mcq", "multi", "tf", "scenario"];
const TYPE_LABEL = { mcq: "Multiple choice", multi: "Multiple select", tf: "True / False", scenario: "Scenario-based" };
const DIFFS = ["easy", "medium", "hard"];
export const VIOLATION_TYPES = new Set(["tab_hidden", "window_blur", "fullscreen_exit", "copy_attempt", "paste_attempt", "devtools_key", "print_screen", "context_menu", "screen_not_monitor", "face_not_visible", "multiple_faces", "looking_away", "looking_down", "phone_detected"]);
export const VISION_TYPES = new Set(["face_not_visible", "multiple_faces", "looking_away", "looking_down", "phone_detected"]);

export const newShareToken = () => crypto.randomBytes(18).toString("base64url");

/** Constant-time check of the candidate link token. */
export function verifyShareToken(attempt, token) {
  const a = Buffer.from(String(attempt?.share_token || ""));
  const b = Buffer.from(String(token || ""));
  if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const err = new Error("This test link is invalid or has been replaced. Ask your trainer for a new link.");
    err.status = 404;
    throw err;
  }
  return true;
}

/** Ensures an attempt has a share token (older attempts) and returns it. */
export async function ensureShareToken(id, { rotate = false } = {}) {
  const a = await db.getDoc("pkt_attempts", id);
  if (!a) throw httpError("Test attempt not found", 404);
  if (a.share_token && !rotate) return { attempt: a, token: a.share_token };
  const token = newShareToken();
  const saved = await db.saveDoc("pkt_attempts", { ...a, share_token: token });
  return { attempt: saved, token };
}
const TERMINAL_TYPES = new Set(["camera_stopped", "screen_stopped"]);

const str = (v, n = 2000) => String(v ?? "").trim().slice(0, n);
const r1 = (x) => Math.round(x * 10) / 10;
function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}
function attemptId() {
  const d = new Date();
  return `PKT-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(Math.floor(Math.random() * 1000000), 6)}`;
}

// ---------------------------------------------------------------- blueprints
export function normalizeBlueprint(input, existing = null) {
  const src = input || {};
  const num = (v, d, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
  };
  const title = str(src.title ?? existing?.title, 160);
  if (!title) throw httpError("Test title is required", 400);
  const process_id = existing?.process_id || src.process_id;
  if (!process_id) throw httpError("process_id is required", 400);
  const types = (Array.isArray(src.question_types) ? src.question_types : existing?.question_types || QUESTION_TYPES).filter((t) => QUESTION_TYPES.includes(t));
  const marksIn = { ...(existing?.marks || {}), ...(src.marks || {}) };
  const procIn = { ...(existing?.proctoring || {}), ...(src.proctoring || {}) };
  return {
    id: existing?.id || `PKB-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
    process_id,
    agent_key: null,
    status: src.status === "archived" ? "archived" : existing?.status === "archived" && src.status !== "active" ? "archived" : "active",
    title,
    description: str(src.description ?? existing?.description, 1000),
    question_count: num(src.question_count ?? existing?.question_count, 20, 3, 100),
    topics: (Array.isArray(src.topics) ? src.topics : typeof src.topics === "string" ? src.topics.split(/[,\n]/) : existing?.topics || []).map((t) => str(t, 120)).filter(Boolean).slice(0, 40),
    difficulty: ["easy", "medium", "hard", "mixed"].includes(src.difficulty ?? existing?.difficulty) ? src.difficulty ?? existing?.difficulty : "mixed",
    question_types: types.length ? types : ["mcq"],
    duration_minutes: num(src.duration_minutes ?? existing?.duration_minutes, 30, 5, 240),
    passing_score: num(src.passing_score ?? existing?.passing_score, 80, 1, 100),
    marks: { mcq: num(marksIn.mcq, 1, 1, 10), multi: num(marksIn.multi, 2, 1, 10), tf: num(marksIn.tf, 1, 1, 10), scenario: num(marksIn.scenario, 2, 1, 10) },
    require_review: src.require_review === undefined ? existing?.require_review !== false : Boolean(src.require_review),
    show_result_to_agent: src.show_result_to_agent === undefined ? existing?.show_result_to_agent !== false : Boolean(src.show_result_to_agent),
    mandatory: src.mandatory === undefined ? Boolean(existing?.mandatory) : Boolean(src.mandatory),
    proctoring: {
      camera: procIn.camera !== false,
      live_ai: procIn.live_ai !== false,
      screen: procIn.screen !== false,
      fullscreen: procIn.fullscreen !== false,
      block_copy_paste: procIn.block_copy_paste !== false,
      max_violations: num(procIn.max_violations, 5, 1, 50),
      ai_review: procIn.ai_review !== false,
    },
    created_by: existing?.created_by || src.actor || "admin",
    created_at: existing?.created_at,
  };
}

export async function saveBlueprint(input, actor, existingId = null) {
  const existing = existingId ? await db.getDoc("pkt_blueprints", existingId) : null;
  if (existingId && !existing) throw httpError("Test blueprint not found", 404);
  if (!existing && !(await getProcess(input.process_id))) throw httpError("Process not found", 404);
  const bp = normalizeBlueprint({ ...input, actor }, existing);
  await db.saveDoc("pkt_blueprints", bp);
  await audit(existing ? "pkt.blueprint_updated" : "pkt.blueprint_created", { entity_type: "pkt_blueprint", entity_id: bp.id, process_id: bp.process_id, actor, summary: `PKT "${bp.title}" ${existing ? "updated" : "created"} (${bp.question_count} q, pass ${bp.passing_score}%)` });
  return bp;
}

export async function listBlueprints(process_id) {
  return db.listDocs("pkt_blueprints", { process_id: process_id || undefined, limit: 500 });
}

// ---------------------------------------------------------------- paper generation
const QUESTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING, enum: QUESTION_TYPES },
          topic: { type: Type.STRING },
          difficulty: { type: Type.STRING, enum: DIFFS },
          stem: { type: Type.STRING },
          options: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, text: { type: Type.STRING } }, required: ["id", "text"] } },
          correct: { type: Type.ARRAY, items: { type: Type.STRING } },
          explanation: { type: Type.STRING },
          source_refs: { type: Type.ARRAY, items: SOURCE_REF_SCHEMA },
          ambiguous: { type: Type.BOOLEAN },
          ambiguity_note: { type: Type.STRING },
        },
        required: ["type", "topic", "difficulty", "stem", "options", "correct", "explanation", "source_refs", "ambiguous", "ambiguity_note"],
      },
    },
    kb_issues: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["questions", "kb_issues"],
};

const words = (t) => new Set(String(t || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2));
function similar(a, b) {
  if (!a.size || !b.size) return false;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter) >= 0.7;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Validates / normalises one generated question. Returns null when unusable. */
function cleanQuestion(q, marks, ctx) {
  const type = QUESTION_TYPES.includes(q.type) ? q.type : "mcq";
  const stem = str(q.stem, 2500);
  if (stem.length < 10) return null;
  let options;
  let correct;
  if (type === "tf") {
    const c = (q.correct || []).map((x) => String(x).trim().toLowerCase());
    const isTrue = c.some((x) => x === "a" || x === "true");
    const isFalse = c.some((x) => x === "b" || x === "false");
    if (isTrue === isFalse) return null;
    options = [{ id: "A", text: "True" }, { id: "B", text: "False" }];
    correct = [isTrue ? "A" : "B"];
  } else {
    const raw = (q.options || []).map((o) => ({ id: str(o.id, 4).toUpperCase(), text: str(o.text, 600) })).filter((o) => o.id && o.text);
    const uniq = [];
    for (const o of raw) if (!uniq.some((u) => u.id === o.id || u.text.toLowerCase() === o.text.toLowerCase())) uniq.push(o);
    if (uniq.length < 3 || uniq.length > 6) return null;
    const correctIds = new Set((q.correct || []).map((x) => str(x, 4).toUpperCase()));
    const correctOld = uniq.filter((o) => correctIds.has(o.id)).map((o) => o.id);
    if (!correctOld.length) return null;
    if ((type === "mcq" || type === "scenario") && correctOld.length !== 1) return null;
    if (type === "multi" && correctOld.length < 2) return null;
    const mixed = shuffle(uniq).map((o, i) => ({ old: o.id, id: String.fromCharCode(65 + i), text: o.text }));
    options = mixed.map(({ id, text }) => ({ id, text }));
    correct = mixed.filter((o) => correctOld.includes(o.old)).map((o) => o.id);
  }
  return {
    type,
    topic: str(q.topic, 120) || "General",
    difficulty: DIFFS.includes(q.difficulty) ? q.difficulty : "medium",
    stem,
    options,
    correct,
    explanation: str(q.explanation, 1500),
    source_refs: verifyRefs(q.source_refs, ctx),
    marks: marks[type] || 1,
  };
}

function allocate(count, keys) {
  const base = Math.floor(count / keys.length);
  const out = Object.fromEntries(keys.map((k) => [k, base]));
  for (let i = 0; i < count - base * keys.length; i += 1) out[keys[i % keys.length]] += 1;
  return out;
}

async function generatePaper(attempt) {
  const bp = attempt.blueprint;
  const ctx = await buildKnowledgeContext(attempt.process_id, { maxChars: 380000 });
  if (ctx.empty) throw httpError("No approved documents in the knowledge base for this process.", 409);
  const process_ = await getProcess(attempt.process_id);
  const analysis = await getKnowledgeAnalysis(attempt.process_id);

  // questions already used: everything this agent has seen + recent questions in the process
  const prior = await db.listDocs("pkt_attempts", { process_id: attempt.process_id, limit: 400 });
  const agentStems = [];
  const otherStems = [];
  for (const a of prior) {
    if (a.id === attempt.id || !Array.isArray(a.questions)) continue;
    for (const q of a.questions) (a.agent_key === attempt.agent_key ? agentStems : otherStems).push(q.stem);
  }
  const avoid = [...agentStems, ...otherStems.slice(0, 120)];
  const avoidSets = avoid.map(words);
  const agentSets = agentStems.map(words);

  const count = bp.question_count;
  const typeAlloc = allocate(count, bp.question_types);
  const extra = Math.max(3, Math.ceil(count * 0.35));
  const cfg = getGeminiConfig();
  const prompt = `You are writing a PROCESS KNOWLEDGE TEST (PKT) for contact-center agents of "${process_?.process_name || attempt.process_id}" who have just completed process training.

${KB_RULES}

PAPER SPECIFICATION
- Generate ${count + extra} questions (some will be filtered out). Target type mix: ${Object.entries(typeAlloc).map(([t, n]) => `${TYPE_LABEL[t]} (${t}) ≈ ${n + Math.ceil((n / count) * extra)}`).join(", ")}.
- Difficulty: ${bp.difficulty === "mixed" ? "about 30% easy, 50% medium, 20% hard" : bp.difficulty}.
- Topics: ${bp.topics.length ? bp.topics.join("; ") : analysis?.topics?.length ? `cover these evenly: ${analysis.topics.map((t) => t.name).join("; ")}` : "cover all important topics in the documents evenly"}.
- Types: "mcq" = 4 options, exactly 1 correct. "multi" = 4-6 options, 2 or more correct (the stem must say "Select all that apply"). "tf" = options exactly [{"id":"A","text":"True"},{"id":"B","text":"False"}], correct ["A"] or ["B"]. "scenario" = a short realistic customer situation followed by "What should the agent do?" with 4 options, exactly 1 correct.
- Option ids "A","B","C"...; "correct" lists the correct option ids. Distractors must be plausible but clearly wrong according to the documents. Avoid "All of the above"/"None of the above".
- Test understanding and correct application (eligibility, timelines, steps, escalation, compliance), not trivia like document titles.
- "explanation": why the answer is correct, referencing the rule. "source_refs": at least one verbatim citation that proves the correct answer.
- If the documents do not clearly determine the correct answer, set "ambiguous": true and explain in "ambiguity_note" (such questions are excluded and shown to the trainer). Otherwise ambiguous=false and ambiguity_note="".
- Every question must be NEW: do not repeat or paraphrase any of these previously used questions:
${avoid.length ? avoid.slice(0, 160).map((s) => `  - ${String(s).slice(0, 140)}`).join("\n") : "  (none)"}
- "kb_issues": conflicts/gaps you noticed in the documents (empty array if none).

APPROVED PROCESS DOCUMENTS${ctx.truncated ? " (long documents were truncated)" : ""}:
${ctx.text}`;

  const { data } = await generateStructuredJson({ model: cfg.generationModel, parts: [{ text: prompt }], schema: QUESTION_SCHEMA, temperature: 0.9 });
  const flagged = [];
  const pool = [];
  let duplicates = 0;
  let invalid = 0;
  for (const raw of data.questions || []) {
    if (raw.ambiguous) {
      flagged.push({ stem: str(raw.stem, 600), note: str(raw.ambiguity_note, 600), source_refs: verifyRefs(raw.source_refs, ctx) });
      continue;
    }
    const q = cleanQuestion(raw, bp.marks, ctx);
    if (!q) {
      invalid += 1;
      continue;
    }
    const w = words(q.stem);
    if (avoidSets.some((a) => similar(a, w)) || pool.some((p) => similar(words(p.stem), w))) {
      duplicates += 1;
      continue;
    }
    if (!q.source_refs.some((r) => r.verified)) q.unverified_source = true;
    pool.push(q);
  }
  // Prefer verified citations, then balance by type allocation and topics
  pool.sort((a, b) => Number(Boolean(a.unverified_source)) - Number(Boolean(b.unverified_source)));
  const picked = [];
  const byType = Object.fromEntries(bp.question_types.map((t) => [t, pool.filter((q) => q.type === t)]));
  for (const [t, n] of Object.entries(typeAlloc)) {
    const topicCount = new Map();
    const list = [...(byType[t] || [])].sort((a, b) => (topicCount.get(a.topic) || 0) - (topicCount.get(b.topic) || 0));
    for (const q of list) {
      if (picked.filter((p) => p.type === t).length >= n) break;
      picked.push(q);
      topicCount.set(q.topic, (topicCount.get(q.topic) || 0) + 1);
    }
  }
  for (const q of pool) {
    if (picked.length >= count) break;
    if (!picked.includes(q)) picked.push(q);
  }
  if (picked.length < Math.ceil(count * 0.6)) {
    throw httpError(`Only ${picked.length} usable questions could be generated (need ${count}). ${flagged.length ? `${flagged.length} were ambiguous in the documents. ` : ""}Add or clarify knowledge-base documents, or reduce the question count.`, 422);
  }
  const questions = shuffle(picked.slice(0, count)).map((q, i) => ({ id: `Q${i + 1}`, ...q }));
  const warnings = [];
  if (questions.length < count) warnings.push(`Only ${questions.length} of ${count} questions could be generated without repeats/ambiguity.`);
  if (questions.some((q) => q.unverified_source)) warnings.push(`${questions.filter((q) => q.unverified_source).length} question(s) have citations that could not be verified verbatim - please review them.`);
  return {
    questions,
    generation: {
      model: cfg.generationModel,
      at: nowIso(),
      kb_documents: ctx.docs,
      requested: count,
      generated: (data.questions || []).length,
      duplicates_removed: duplicates,
      invalid_removed: invalid,
      flagged_ambiguous: flagged,
      kb_issues: (data.kb_issues || []).map((x) => str(x, 600)).slice(0, 20),
      warnings,
      avoided_previous: avoid.length,
      agent_previous_questions: agentSets.length,
    },
  };
}

// ---------------------------------------------------------------- attempts
export async function getAttempt(id) {
  const a = await db.getDoc("pkt_attempts", id);
  if (!a) throw httpError("Test attempt not found", 404);
  return finalizeIfExpired(a);
}

export async function listAttempts({ process_id, agent_key, status, limit = 500 } = {}) {
  return db.listDocs("pkt_attempts", { process_id: process_id || undefined, agent_key: agent_key || undefined, status: status || undefined, limit });
}

/** Creates an attempt (fresh paper is generated in the background by runGeneration). */
export async function createAttempt({ blueprint_id, agent_id, mode = "in_person", actor }) {
  const bp = await db.getDoc("pkt_blueprints", blueprint_id);
  if (!bp) throw httpError("Test blueprint not found", 404);
  if (bp.status === "archived") throw httpError("This test is archived.", 409);
  const agent = await db.getAgent(agent_id);
  if (!agent) throw httpError("Agent not found", 404);
  const agent_key = `id:${agent.id}`;
  const previous = await listAttempts({ process_id: bp.process_id, agent_key, limit: 200 });
  if (previous.some((p) => ["generating", "review", "ready", "in_progress"].includes(p.status))) {
    throw httpError("This agent already has an open test - complete, cancel or invalidate it first.", 409);
  }
  const attempt = {
    id: attemptId(),
    process_id: bp.process_id,
    agent_key,
    status: "generating",
    blueprint_id: bp.id,
    blueprint: { ...bp },
    agent: { id: agent.id, name: agent.name, email: agent.email || null, employee_id: agent.employee_id || null },
    attempt_no: previous.filter((p) => ["scored", "invalidated"].includes(p.status)).length + 1,
    mode: mode === "online" ? "online" : "in_person",
    share_token: newShareToken(),
    questions: [],
    answers: {},
    proctoring: { events: [], violations: 0, integrity: { status: "pending", reasons: [] } },
    created_by: actor,
  };
  await db.saveDoc("pkt_attempts", attempt);
  await audit("pkt.attempt_created", { entity_type: "pkt_attempt", entity_id: attempt.id, process_id: bp.process_id, agent_key, actor, summary: `PKT "${bp.title}" assigned to ${agent.name} (attempt ${attempt.attempt_no}, ${attempt.mode})` });
  return attempt;
}

export async function runGeneration(id, actor = "system") {
  let attempt = await db.getDoc("pkt_attempts", id);
  if (!attempt) return;
  try {
    const paper = await generatePaper(attempt);
    attempt = await db.getDoc("pkt_attempts", id);
    if (!attempt || attempt.status !== "generating") return;
    const review = attempt.blueprint.require_review !== false;
    attempt = { ...attempt, ...paper, status: review ? "review" : "ready", error: null };
    await db.saveDoc("pkt_attempts", attempt);
    await audit("pkt.paper_generated", {
      entity_type: "pkt_attempt",
      entity_id: id,
      process_id: attempt.process_id,
      agent_key: attempt.agent_key,
      actor,
      summary: `Fresh paper generated: ${paper.questions.length} questions${paper.generation.flagged_ambiguous.length ? `, ${paper.generation.flagged_ambiguous.length} ambiguous excluded` : ""}${review ? " - awaiting trainer review" : ""}`,
      details: { questions: paper.questions.map((q) => ({ id: q.id, type: q.type, topic: q.topic, stem: q.stem, correct: q.correct, source_refs: q.source_refs })), generation: paper.generation },
    });
  } catch (err) {
    const message = err.status ? err.message : describeGeminiError(err);
    const cur = await db.getDoc("pkt_attempts", id);
    if (cur) await db.saveDoc("pkt_attempts", { ...cur, status: "failed_generation", error: message });
    await audit("pkt.paper_failed", { entity_type: "pkt_attempt", entity_id: id, process_id: attempt.process_id, agent_key: attempt.agent_key, actor, summary: `Paper generation failed: ${message}` });
  }
}

export async function regenerate(id, actor) {
  const a = await getAttempt(id);
  if (!["review", "ready", "failed_generation"].includes(a.status)) throw httpError(`A ${a.status} test cannot be regenerated.`, 409);
  await db.saveDoc("pkt_attempts", { ...a, status: "generating", questions: [], error: null });
  await audit("pkt.paper_regenerate", { entity_type: "pkt_attempt", entity_id: id, process_id: a.process_id, agent_key: a.agent_key, actor, summary: "Paper regeneration requested" });
}

export async function removeQuestion(id, qid, actor) {
  const a = await getAttempt(id);
  if (a.status !== "review") throw httpError("Questions can only be removed while the paper is in review.", 409);
  const questions = a.questions.filter((q) => q.id !== qid);
  if (questions.length < 3) throw httpError("A paper needs at least 3 questions.", 409);
  const saved = await db.saveDoc("pkt_attempts", { ...a, questions, removed_questions: [...(a.removed_questions || []), a.questions.find((q) => q.id === qid)].filter(Boolean) });
  await audit("pkt.question_removed", { entity_type: "pkt_attempt", entity_id: id, process_id: a.process_id, agent_key: a.agent_key, actor, summary: `Question ${qid} removed by trainer` });
  return saved;
}

export async function approvePaper(id, actor) {
  const a = await getAttempt(id);
  if (a.status !== "review") throw httpError(`A ${a.status} paper cannot be approved.`, 409);
  const saved = await db.saveDoc("pkt_attempts", { ...a, status: "ready", approved_by: actor, approved_at: nowIso() });
  await audit("pkt.paper_approved", { entity_type: "pkt_attempt", entity_id: id, process_id: a.process_id, agent_key: a.agent_key, actor, summary: `Paper (${a.questions.length} questions) approved for ${a.agent.name}` });
  return saved;
}

export async function startAttempt(id, actor) {
  const a = await getAttempt(id);
  if (a.status === "in_progress") return a; // resume after a page reload
  if (a.status !== "ready") throw httpError(a.status === "review" ? "The trainer must approve the paper before the test can start." : `A ${a.status} test cannot be started.`, 409);
  const now = Date.now();
  const saved = await db.saveDoc("pkt_attempts", { ...a, status: "in_progress", started_at: new Date(now).toISOString(), deadline_at: new Date(now + a.blueprint.duration_minutes * 60000).toISOString(), started_by: actor });
  await audit("pkt.started", { entity_type: "pkt_attempt", entity_id: id, process_id: a.process_id, agent_key: a.agent_key, actor, summary: `${a.agent.name} started the PKT (${a.blueprint.duration_minutes} min)` });
  return saved;
}

/** Candidate view - no answer keys, explanations or sources. */
export function candidatePaper(a) {
  return {
    id: a.id,
    status: a.status,
    title: a.blueprint.title,
    agent: a.agent,
    attempt_no: a.attempt_no,
    duration_minutes: a.blueprint.duration_minutes,
    passing_score: a.blueprint.passing_score,
    proctoring: a.blueprint.proctoring,
    started_at: a.started_at || null,
    deadline_at: a.deadline_at || null,
    server_time: nowIso(),
    answers: a.answers || {},
    violations: a.proctoring?.violations || 0,
    show_result: a.blueprint?.show_result_to_agent !== false,
    questions: (a.questions || []).map((q) => ({ id: q.id, type: q.type, topic: q.topic, stem: q.stem, options: q.options, marks: q.marks })),
  };
}

function cleanAnswers(a, answers) {
  const valid = new Map((a.questions || []).map((q) => [q.id, new Set(q.options.map((o) => o.id))]));
  const out = {};
  for (const [qid, val] of Object.entries(answers || {})) {
    const opts = valid.get(qid);
    if (!opts) continue;
    const list = (Array.isArray(val) ? val : [val]).map((x) => String(x).toUpperCase()).filter((x) => opts.has(x));
    if (list.length) out[qid] = [...new Set(list)].sort();
  }
  return out;
}

export async function saveAnswers(id, answers) {
  const a = await db.getDoc("pkt_attempts", id);
  if (!a) throw httpError("Test attempt not found", 404);
  if (a.status !== "in_progress") throw httpError("This test is not in progress.", 409);
  await db.saveDoc("pkt_attempts", { ...a, answers: cleanAnswers(a, answers), answers_saved_at: nowIso() });
  return { ok: true };
}

export async function addEvents(id, events) {
  const a = await db.getDoc("pkt_attempts", id);
  if (!a) throw httpError("Test attempt not found", 404);
  const list = (Array.isArray(events) ? events : []).slice(0, 200).map((e) => ({ t: typeof e.t === "string" ? e.t : nowIso(), type: str(e.type, 40), detail: str(e.detail, 300) }));
  const all = [...(a.proctoring?.events || []), ...list].slice(-1000);
  const violations = all.filter((e) => VIOLATION_TYPES.has(e.type)).length;
  await db.saveDoc("pkt_attempts", { ...a, proctoring: { ...(a.proctoring || {}), events: all, violations } });
  return { ok: true, violations };
}

export function scoreAttempt(a) {
  const passing = a.blueprint.passing_score;
  const per = [];
  const topics = new Map();
  const types = new Map();
  const diffs = new Map();
  let score = 0;
  let max = 0;
  const bump = (map, key, ok, marks, qmax) => {
    const e = map.get(key) || { key, correct: 0, total: 0, marks: 0, max: 0 };
    e.total += 1;
    e.max += qmax;
    if (ok) {
      e.correct += 1;
      e.marks += marks;
    }
    map.set(key, e);
  };
  for (const q of a.questions || []) {
    const given = (a.answers?.[q.id] || []).slice().sort();
    const correct = q.correct.slice().sort();
    const ok = given.length === correct.length && given.every((g, i) => g === correct[i]);
    const marks = ok ? q.marks : 0;
    score += marks;
    max += q.marks;
    per.push({ id: q.id, correct: ok, answered: given.length > 0, given, marks, max: q.marks });
    bump(topics, q.topic, ok, marks, q.marks);
    bump(types, q.type, ok, marks, q.marks);
    bump(diffs, q.difficulty, ok, marks, q.marks);
  }
  const fin = (m) => Array.from(m.values()).map((e) => ({ ...e, percentage: e.max ? r1((e.marks / e.max) * 100) : 0 })).sort((x, y) => x.percentage - y.percentage);
  const percentage = max ? r1((score / max) * 100) : 0;
  const byTopic = fin(topics);
  return {
    score,
    max,
    percentage,
    passed: percentage >= passing,
    passing_score: passing,
    answered: per.filter((p) => p.answered).length,
    correct: per.filter((p) => p.correct).length,
    total: per.length,
    by_topic: byTopic.map(({ key, ...r }) => ({ topic: key, ...r })),
    by_type: fin(types).map(({ key, ...r }) => ({ type: key, ...r })),
    by_difficulty: fin(diffs).map(({ key, ...r }) => ({ difficulty: key, ...r })),
    gaps: byTopic.filter((t) => t.percentage < passing).map((t) => ({ topic: t.key, percentage: t.percentage, missed: t.total - t.correct })),
    per_question: per,
    scored_at: nowIso(),
  };
}

function integrityOf(a) {
  const p = a.proctoring || {};
  const reasons = [];
  let status = "clean";
  const max = a.blueprint?.proctoring?.max_violations || 5;
  if (p.terminated_reason) {
    status = "violation";
    reasons.push(`Terminated: ${p.terminated_reason}`);
  }
  if ((p.violations || 0) >= max) {
    status = "violation";
    reasons.push(`${p.violations} proctoring violations (limit ${max})`);
  } else if ((p.violations || 0) > 0) {
    if (status === "clean") status = "suspicious";
    reasons.push(`${p.violations} proctoring event(s)`);
  }
  const vision = (p.events || []).filter((e) => VISION_TYPES.has(e.type));
  if (vision.length) {
    const byType = {};
    for (const e of vision) byType[e.type] = (byType[e.type] || 0) + 1;
    reasons.push(`Camera AI: ${Object.entries(byType).map(([k, v]) => `${k.replace(/_/g, " ")} ×${v}`).join(", ")}`);
    if (byType.phone_detected || byType.multiple_faces) status = "violation";
    else if (status === "clean") status = "suspicious";
  }
  const ai = p.ai_review;
  if (ai?.verdict === "violation") {
    status = "violation";
    reasons.push(`AI review: ${ai.summary}`);
  } else if (ai?.verdict === "suspicious") {
    if (status === "clean") status = "suspicious";
    reasons.push(`AI review: ${ai.summary}`);
  }
  return { status, reasons };
}

export async function submitAttempt(id, { answers, reason = "submitted", actor }) {
  const a = await db.getDoc("pkt_attempts", id);
  if (!a) throw httpError("Test attempt not found", 404);
  if (a.status === "scored") return a;
  if (a.status !== "in_progress") throw httpError(`A ${a.status} test cannot be submitted.`, 409);
  const now = Date.now();
  const late = a.deadline_at && now > new Date(a.deadline_at).getTime() + 90000;
  const finalAnswers = answers && !late ? cleanAnswers(a, answers) : a.answers || {};
  const proctoring = { ...(a.proctoring || {}) };
  if (TERMINAL_TYPES.has(reason) || reason === "max_violations") proctoring.terminated_reason = reason.replace(/_/g, " ");
  const next = { ...a, answers: finalAnswers, status: "scored", submitted_at: new Date(now).toISOString(), submit_reason: late ? "time_expired" : reason, submitted_by: actor, proctoring };
  next.result = scoreAttempt(next);
  next.proctoring.integrity = integrityOf(next);
  await db.saveDoc("pkt_attempts", next);
  await audit("pkt.scored", {
    entity_type: "pkt_attempt",
    entity_id: id,
    process_id: a.process_id,
    agent_key: a.agent_key,
    actor,
    summary: `${a.agent.name}: ${next.result.percentage}% (${next.result.score}/${next.result.max}) - ${next.result.passed ? "PASSED" : "NOT PASSED"} · integrity ${next.proctoring.integrity.status}${next.submit_reason !== "submitted" ? ` · ${next.submit_reason}` : ""}`,
    details: { result: { ...next.result, per_question: undefined }, answers: finalAnswers, violations: proctoring.violations || 0 },
  });
  return next;
}

/** Server-side safety net: an in-progress test past its deadline is scored with the saved answers. */
export async function finalizeExpired(a) {
  return finalizeIfExpired(a);
}
async function finalizeIfExpired(a) {
  if (a.status === "in_progress" && a.deadline_at && Date.now() > new Date(a.deadline_at).getTime() + 5 * 60000) {
    return submitAttempt(a.id, { answers: null, reason: "time_expired", actor: "system" });
  }
  return a;
}

export async function cancelAttempt(id, actor, reason = "") {
  const a = await getAttempt(id);
  if (!["generating", "review", "ready", "failed_generation"].includes(a.status)) throw httpError(`A ${a.status} test cannot be cancelled (invalidate it instead).`, 409);
  const saved = await db.saveDoc("pkt_attempts", { ...a, status: "cancelled", cancelled_by: actor, cancel_reason: str(reason, 500) });
  await audit("pkt.cancelled", { entity_type: "pkt_attempt", entity_id: id, process_id: a.process_id, agent_key: a.agent_key, actor, summary: `Test cancelled${reason ? `: ${reason}` : ""}` });
  return saved;
}

export async function invalidateAttempt(id, actor, reason = "") {
  const a = await getAttempt(id);
  if (!["scored", "in_progress"].includes(a.status)) throw httpError(`A ${a.status} test cannot be invalidated.`, 409);
  if (!str(reason)) throw httpError("A reason is required to invalidate a test.", 400);
  const saved = await db.saveDoc("pkt_attempts", { ...a, status: "invalidated", invalidated_by: actor, invalidated_at: nowIso(), invalidation_reason: str(reason, 1000) });
  await audit("pkt.invalidated", { entity_type: "pkt_attempt", entity_id: id, process_id: a.process_id, agent_key: a.agent_key, actor, summary: `Test invalidated: ${reason}` });
  return saved;
}

export async function setRecording(id, kind, info) {
  const a = await db.getDoc("pkt_attempts", id);
  if (!a) throw httpError("Test attempt not found", 404);
  return db.saveDoc("pkt_attempts", { ...a, proctoring: { ...(a.proctoring || {}), [kind]: info } });
}

// ---------------------------------------------------------------- AI proctoring review
const REVIEW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verdict: { type: Type.STRING, enum: ["clean", "suspicious", "violation"] },
    integrity_score: { type: Type.INTEGER },
    summary: { type: Type.STRING },
    flags: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          source: { type: Type.STRING, enum: ["camera", "screen", "events"] },
          timestamp: { type: Type.STRING },
          type: { type: Type.STRING, enum: ["another_person", "phone", "absent", "looking_away", "talking", "reading_notes", "ai_tool", "search_engine", "other_app", "messaging", "other"] },
          severity: { type: Type.STRING, enum: ["low", "medium", "high"] },
          description: { type: Type.STRING },
        },
        required: ["source", "timestamp", "type", "severity", "description"],
      },
    },
  },
  required: ["verdict", "integrity_score", "summary", "flags"],
};

export async function runProctoringReview(id, actor = "system") {
  const a = await db.getDoc("pkt_attempts", id);
  if (!a) return null;
  const cfg = getGeminiConfig();
  const uploads = [];
  try {
    const parts = [];
    for (const kind of ["camera", "screen"]) {
      const buf = await db.getRecordingBuffer(id, kind).catch(() => null);
      if (buf && buf.length > 20000) {
        const up = await uploadMediaToGemini({ buffer: buf, mimeType: "video/webm", displayName: `${id}-${kind}` });
        uploads.push(up);
        parts.push({ text: `${kind.toUpperCase()} RECORDING:` }, { fileData: { fileUri: up.uri, mimeType: up.mimeType }, videoMetadata: { fps: 0.5 } });
      }
    }
    if (!parts.length) throw new Error("No camera or screen recording available for review.");
    const events = (a.proctoring?.events || []).slice(-150).map((e) => `${e.t} ${e.type}${e.detail ? ` (${e.detail})` : ""}`).join("\n");
    const prompt = `You are an exam proctor reviewing a ${a.blueprint.duration_minutes}-minute online knowledge test taken by a contact-center agent. Review the recordings for academic dishonesty. Report ONLY what is actually visible/audible - do not speculate.

CAMERA (webcam): another person present or helping, a phone or second device being used, the candidate absent, repeatedly looking away/down at notes, talking to someone, reading from paper/books.
SCREEN: ChatGPT, Gemini, Copilot or any AI assistant; Google/Bing search; notes/documents/SOP files opened; WhatsApp/Teams/other messaging; any application or tab other than the test page.

Timestamps are mm:ss from the start of each recording. Verdict: "clean" (nothing material), "suspicious" (minor or unclear issues), "violation" (clear cheating evidence). integrity_score 0-100 (100 = fully clean).

BROWSER EVENTS LOGGED DURING THE TEST:
${events || "(none)"}`;
    const { data } = await generateStructuredJson({ model: cfg.screenAnalysisModel, parts: [{ text: prompt }, ...parts], schema: REVIEW_SCHEMA, temperature: 0.1 });
    const review = {
      verdict: ["clean", "suspicious", "violation"].includes(data.verdict) ? data.verdict : "suspicious",
      integrity_score: Math.max(0, Math.min(100, Math.round(Number(data.integrity_score) || 0))),
      summary: str(data.summary, 1500),
      flags: (data.flags || []).slice(0, 50).map((f) => ({ source: f.source, timestamp: str(f.timestamp, 20), type: f.type, severity: f.severity, description: str(f.description, 500) })),
      model: cfg.screenAnalysisModel,
      reviewed_at: nowIso(),
    };
    const cur = await db.getDoc("pkt_attempts", id);
    const next = { ...cur, proctoring: { ...(cur.proctoring || {}), ai_review: review } };
    next.proctoring.integrity = integrityOf(next);
    await db.saveDoc("pkt_attempts", next);
    await audit("pkt.proctoring_reviewed", { entity_type: "pkt_attempt", entity_id: id, process_id: a.process_id, agent_key: a.agent_key, actor, summary: `AI proctoring review: ${review.verdict} (integrity ${review.integrity_score}/100, ${review.flags.length} flag(s))` });
    return review;
  } catch (err) {
    const cur = await db.getDoc("pkt_attempts", id);
    if (cur) await db.saveDoc("pkt_attempts", { ...cur, proctoring: { ...(cur.proctoring || {}), ai_review_error: err.status ? err.message : describeGeminiError(err) } });
    return null;
  } finally {
    for (const u of uploads) await u.cleanup();
  }
}

// ---------------------------------------------------------------- aggregation for dashboards
export function summarizePkt(attempts) {
  const scored = attempts.filter((a) => a.status === "scored" && a.result);
  const topics = new Map();
  for (const a of scored) {
    for (const t of a.result.by_topic || []) {
      const e = topics.get(t.topic) || { topic: t.topic, questions: 0, correct: 0, attempts: 0, below: new Set() };
      e.questions += t.total;
      e.correct += t.correct;
      e.attempts += 1;
      if (t.percentage < a.result.passing_score) e.below.add(a.agent_key);
      topics.set(t.topic, e);
    }
  }
  const integrity = { clean: 0, suspicious: 0, violation: 0, pending: 0 };
  for (const a of scored) integrity[a.proctoring?.integrity?.status || "pending"] = (integrity[a.proctoring?.integrity?.status || "pending"] || 0) + 1;
  const pct = scored.map((a) => a.result.percentage);
  return {
    total: attempts.length,
    scored: scored.length,
    passed: scored.filter((a) => a.result.passed).length,
    pass_rate: scored.length ? r1((scored.filter((a) => a.result.passed).length / scored.length) * 100) : null,
    avg_score: pct.length ? r1(pct.reduce((s, v) => s + v, 0) / pct.length) : null,
    awaiting_review: attempts.filter((a) => a.status === "review").length,
    in_progress: attempts.filter((a) => a.status === "in_progress").length,
    integrity,
    topic_gaps: Array.from(topics.values())
      .map((e) => ({ topic: e.topic, questions: e.questions, correct: e.correct, percentage: e.questions ? r1((e.correct / e.questions) * 100) : 0, attempts: e.attempts, agents_below: e.below.size }))
      .sort((a, b) => a.percentage - b.percentage),
  };
}

/** Best / latest scored (non-invalidated) PKT for one agent + process. */
export function pktStatusFor(attempts, agentKey, processId) {
  const mine = attempts.filter((a) => a.agent_key === agentKey && a.process_id === processId).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const scored = mine.filter((a) => a.status === "scored" && a.result);
  const latest = scored[scored.length - 1] || null;
  return {
    attempts: scored.length,
    open: mine.find((a) => ["generating", "review", "ready", "in_progress"].includes(a.status)) || null,
    latest_score: latest ? latest.result.percentage : null,
    best_score: scored.length ? Math.max(...scored.map((a) => a.result.percentage)) : null,
    passed: scored.some((a) => a.result.passed && a.proctoring?.integrity?.status !== "violation"),
    latest_id: latest?.id || mine[mine.length - 1]?.id || null,
    latest_integrity: latest?.proctoring?.integrity?.status || null,
    gaps: latest?.result?.gaps || [],
  };
}
