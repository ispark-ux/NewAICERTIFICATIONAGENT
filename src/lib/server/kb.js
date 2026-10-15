import { Type } from "@google/genai";
import { db } from "./db";
import { audit } from "./audit";
import { httpError } from "./http";
import { getGeminiConfig, generatePlainText, generateStructuredJson } from "./gemini";
import { uploadMediaToGemini } from "./screen-analysis";
import { nowIso } from "./storage";

/**
 * Process knowledge base - the single source of truth for scenarios, PKT
 * questions and voice evaluation. Only APPROVED document versions are used.
 */

export const DOC_TYPES = [
  { value: "sop", label: "SOP" },
  { value: "manual", label: "Training manual" },
  { value: "faq", label: "FAQ" },
  { value: "script", label: "Call script" },
  { value: "policy", label: "Policy" },
  { value: "escalation_matrix", label: "Escalation matrix" },
  { value: "other", label: "Other" },
];
const DOC_TYPE_SET = new Set(DOC_TYPES.map((d) => d.value));
export const KB_PART_BYTES = 512 * 1024;
const KB_MAX_BYTES = 60 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;

const rid = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;

export function detectDocKind(fileName = "", mime = "") {
  const n = String(fileName).toLowerCase();
  const m = String(mime).toLowerCase();
  if (n.endsWith(".pdf") || m === "application/pdf") return "pdf";
  if (n.endsWith(".docx") || m.includes("wordprocessingml")) return "docx";
  if (/\.(png|jpe?g|webp)$/.test(n) || m.startsWith("image/")) return "image";
  if (
    /\.(txt|md|markdown|csv|tsv|json|html?)$/.test(n) ||
    m.startsWith("text/") ||
    m === "application/json"
  )
    return "text";
  return "unsupported";
}

function cleanText(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

async function ocrWithGemini(buffer, mimeType, fileName) {
  const cfg = getGeminiConfig();
  const uploaded = await uploadMediaToGemini({
    buffer,
    mimeType,
    displayName: `kb-${fileName}`.slice(0, 60),
  });
  try {
    const { text, finishReason } = await generatePlainText({
      model: cfg.generationModel,
      parts: [
        {
          text: "Extract the COMPLETE text of this document verbatim, in reading order. Keep headings on their own lines, render tables as Markdown tables, keep numbered/bulleted lists. Do not summarise, translate, add or omit anything. Output only the document text.",
        },
        { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType } },
      ],
      maxOutputTokens: 65536,
    });
    return {
      text,
      warnings:
        finishReason === "MAX_TOKENS"
          ? [
              "Document is very long - OCR output was truncated. Split the file and upload the parts separately.",
            ]
          : [],
    };
  } finally {
    await uploaded.cleanup();
  }
}

/** Extracts plain text from an uploaded document buffer. */
export async function extractDocumentText(buffer, fileName, mimeType) {
  const kind = detectDocKind(fileName, mimeType);
  if (kind === "text")
    return { text: cleanText(buffer.toString("utf8")), method: "text", warnings: [] };
  if (kind === "docx") {
    const mammoth = (await import("mammoth")).default;
    const out = await mammoth.extractRawText({ buffer });
    return {
      text: cleanText(out.value),
      method: "docx",
      warnings: (out.messages || []).slice(0, 5).map((m) => m.message),
    };
  }
  if (kind === "pdf") {
    let text = "";
    let pages = 0;
    const warnings = [];
    try {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const res = await extractText(pdf, { mergePages: false });
      pages = res.totalPages || 0;
      const arr = Array.isArray(res.text) ? res.text : [res.text];
      text = arr.map((t, i) => `[Page ${i + 1}]\n${t}`).join("\n\n");
    } catch (err) {
      warnings.push(`Text layer extraction failed (${err.message}) - using OCR.`);
    }
    const letters = text.replace(/\[Page \d+\]/g, "").replace(/\s+/g, "").length;
    if (letters < Math.max(20, pages * 25)) {
      if (!getGeminiConfig().configured)
        throw httpError(
          "This PDF has no text layer (scanned). Configure GEMINI_API_KEY so it can be OCR'd, or upload a text-based PDF/DOCX.",
          400
        );
      const ocr = await ocrWithGemini(buffer, "application/pdf", fileName);
      return {
        text: cleanText(ocr.text),
        method: "pdf-ocr",
        pages,
        warnings: [
          ...warnings,
          "Scanned PDF - text extracted with Gemini OCR. Please review it.",
          ...ocr.warnings,
        ],
      };
    }
    return { text: cleanText(text), method: "pdf", pages, warnings };
  }
  if (kind === "image") {
    if (!getGeminiConfig().configured)
      throw httpError("Images need GEMINI_API_KEY for OCR.", 400);
    const ocr = await ocrWithGemini(buffer, mimeType || "image/png", fileName);
    return {
      text: cleanText(ocr.text),
      method: "image-ocr",
      warnings: [
        "Image - text extracted with Gemini OCR. Please review it.",
        ...ocr.warnings,
      ],
    };
  }
  throw httpError(
    "Unsupported file type. Upload PDF, DOCX, TXT, MD, CSV or an image (PNG/JPG). Export Excel/PowerPoint files to PDF or CSV first.",
    400
  );
}

// ---------------------------------------------------------------- documents
export async function listDocuments(process_id) {
  return db.listDocs("kb_documents", { process_id, limit: 1000 });
}

export async function getDocument(id) {
  const doc = await db.getDoc("kb_documents", id);
  if (!doc) throw httpError("Document not found", 404);
  return doc;
}

async function nextVersion(process_id, replaces_id) {
  if (!replaces_id) return { group_id: rid("GRP"), version: 1 };
  const prev = await db.getDoc("kb_documents", replaces_id, { withBody: false });
  if (!prev || prev.process_id !== process_id)
    throw httpError("The document to replace was not found in this process.", 404);
  const siblings = (await listDocuments(process_id)).filter(
    (d) => d.group_id === prev.group_id
  );
  return {
    group_id: prev.group_id,
    version: Math.max(...siblings.map((d) => Number(d.version) || 1)) + 1,
  };
}

function baseDoc({ process_id, title, doc_type, notes, actor }) {
  if (!process_id) throw httpError("process_id is required", 400);
  const t = String(title || "")
    .trim()
    .slice(0, 200);
  if (!t) throw httpError("Document title is required", 400);
  return {
    process_id,
    title: t,
    doc_type: DOC_TYPE_SET.has(doc_type) ? doc_type : "other",
    notes: String(notes || "").slice(0, 1000),
    uploaded_by: actor,
    agent_key: null,
  };
}

/** Step 1 of a file upload: register the document, the browser then sends parts. */
export async function createDocumentUpload({
  process_id,
  title,
  doc_type,
  notes,
  file_name,
  mime_type,
  size,
  replaces_id,
  actor,
}) {
  const kind = detectDocKind(file_name, mime_type);
  if (kind === "unsupported")
    throw httpError("Unsupported file type. Upload PDF, DOCX, TXT, MD, CSV or PNG/JPG.", 400);
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) throw httpError("File size is required", 400);
  if (bytes > KB_MAX_BYTES)
    throw httpError(
      `File is larger than ${KB_MAX_BYTES / 1048576} MB - split it into smaller documents.`,
      400
    );
  const v = await nextVersion(process_id, replaces_id);
  const doc = {
    id: rid("DOC"),
    ...baseDoc({ process_id, title, doc_type, notes, actor }),
    ...v,
    replaces_id: replaces_id || null,
    status: "uploading",
    source: "file",
    file_name: String(file_name || "document").slice(0, 200),
    mime_type: String(mime_type || "").slice(0, 100),
    size_bytes: bytes,
  };
  await db.saveDoc("kb_documents", doc);
  return {
    document: doc,
    part_size: KB_PART_BYTES,
    parts: Math.ceil(bytes / KB_PART_BYTES),
  };
}

export async function storeDocumentPart(id, index, buffer) {
  const doc = await db.getDoc("kb_documents", id, { withBody: false });
  if (!doc) throw httpError("Document not found", 404);
  if (doc.status !== "uploading")
    throw httpError("This document is not accepting uploads.", 409);
  if (!Number.isInteger(index) || index < 0 || index > 100000)
    throw httpError("Invalid part index", 400);
  if (!buffer.length) throw httpError("Empty part", 400);
  if (buffer.length > 4 * 1024 * 1024) throw httpError("Part too large", 413);
  return db.saveObjectPart(`kb/${id}`, index, buffer);
}

/** Step 3: assemble, extract text, keep as draft for trainer review/approval. */
export async function completeDocumentUpload(id, { total_size, actor }) {
  const doc = await db.getDoc("kb_documents", id, { withBody: false });
  if (!doc) throw httpError("Document not found", 404);
  const buffer = await db.readObject(`kb/${id}`);
  if (!buffer)
    throw httpError("No uploaded data found for this document - please upload again.", 400);
  if (Number(total_size) && buffer.length !== Number(total_size))
    throw httpError(
      `Upload incomplete (${buffer.length} of ${total_size} bytes) - please upload again.`,
      400
    );
  let extraction;
  try {
    extraction = await extractDocumentText(buffer, doc.file_name, doc.mime_type);
  } catch (err) {
    const failed = {
      ...doc,
      status: "failed",
      error: err.message,
      extracted_at: nowIso(),
    };
    await db.saveDoc("kb_documents", failed);
    await audit("kb.document_failed", {
      entity_type: "kb_document",
      entity_id: id,
      process_id: doc.process_id,
      actor,
      summary: `${doc.title}: ${err.message}`,
    });
    throw err;
  }
  if (!extraction.text || extraction.text.length < 20) {
    const failed = {
      ...doc,
      status: "failed",
      error: "No readable text found in this file.",
      extracted_at: nowIso(),
    };
    await db.saveDoc("kb_documents", failed);
    throw httpError("No readable text found in this file.", 400);
  }
  const saved = await db.saveDoc("kb_documents", {
    ...doc,
    status: "draft",
    body: extraction.text,
    char_count: extraction.text.length,
    extraction: {
      method: extraction.method,
      pages: extraction.pages || null,
      warnings: extraction.warnings || [],
    },
    extracted_at: nowIso(),
    error: null,
  });
  await audit("kb.document_uploaded", {
    entity_type: "kb_document",
    entity_id: id,
    process_id: doc.process_id,
    actor,
    summary: `${doc.title} v${doc.version} uploaded (${extraction.method}, ${extraction.text.length} chars)`,
    details: { file_name: doc.file_name, version: doc.version, group_id: doc.group_id },
  });
  const { body, ...rest } = saved;
  return rest;
}

/** Pasted text document (FAQs, notes) - no file upload needed. */
export async function createTextDocument({
  process_id,
  title,
  doc_type,
  notes,
  text,
  replaces_id,
  actor,
}) {
  const body = cleanText(text);
  if (body.length < 20)
    throw httpError("Please paste at least a few sentences of text.", 400);
  const v = await nextVersion(process_id, replaces_id);
  const doc = {
    id: rid("DOC"),
    ...baseDoc({ process_id, title, doc_type, notes, actor }),
    ...v,
    replaces_id: replaces_id || null,
    status: "draft",
    source: "text",
    file_name: null,
    mime_type: "text/plain",
    size_bytes: Buffer.byteLength(body),
    char_count: body.length,
    extraction: { method: "pasted", warnings: [] },
    extracted_at: nowIso(),
    body,
  };
  await db.saveDoc("kb_documents", doc);
  await audit("kb.document_uploaded", {
    entity_type: "kb_document",
    entity_id: doc.id,
    process_id,
    actor,
    summary: `${doc.title} v${doc.version} added (pasted text)`,
  });
  const { body: _b, ...rest } = doc;
  return rest;
}

/** Approve a version - the previously approved version of the same document is archived. */
export async function approveDocument(id, actor) {
  const doc = await db.getDoc("kb_documents", id, { withBody: false });
  if (!doc) throw httpError("Document not found", 404);
  if (!["draft", "archived"].includes(doc.status))
    throw httpError(`A ${doc.status} document cannot be approved.`, 409);
  const siblings = (await listDocuments(doc.process_id)).filter(
    (d) => d.group_id === doc.group_id && d.id !== id && d.status === "approved"
  );
  for (const s of siblings) {
    await db.saveDoc("kb_documents", {
      ...s,
      status: "archived",
      archived_at: nowIso(),
      superseded_by: id,
    });
  }
  const saved = await db.saveDoc("kb_documents", {
    ...doc,
    status: "approved",
    approved_by: actor,
    approved_at: nowIso(),
  });
  await audit("kb.document_approved", {
    entity_type: "kb_document",
    entity_id: id,
    process_id: doc.process_id,
    actor,
    summary: `${doc.title} v${doc.version} approved${
      siblings.length ? ` (superseded v${siblings.map((s) => s.version).join(", v")})` : ""
    }`,
  });
  return saved;
}

export async function archiveDocument(id, actor) {
  const doc = await db.getDoc("kb_documents", id, { withBody: false });
  if (!doc) throw httpError("Document not found", 404);
  const saved = await db.saveDoc("kb_documents", {
    ...doc,
    status: "archived",
    archived_at: nowIso(),
  });
  await audit("kb.document_archived", {
    entity_type: "kb_document",
    entity_id: id,
    process_id: doc.process_id,
    actor,
    summary: `${doc.title} v${doc.version} archived`,
  });
  return saved;
}

export async function deleteDocument(id, actor) {
  const doc = await db.getDoc("kb_documents", id, { withBody: false });
  if (!doc) throw httpError("Document not found", 404);
  if (doc.status === "approved")
    throw httpError(
      "Archive the approved version before deleting it (keeps the audit trail consistent).",
      409
    );
  await db.clearObject(`kb/${id}`).catch(() => {});
  await db.deleteDoc("kb_documents", id);
  await audit("kb.document_deleted", {
    entity_type: "kb_document",
    entity_id: id,
    process_id: doc.process_id,
    actor,
    summary: `${doc.title} v${doc.version} deleted`,
  });
  return true;
}

// ---------------------------------------------------------------- knowledge context
function splitSections(text) {
  const blocks = String(text || "")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const sections = [];
  let cur = "";
  for (const b of blocks) {
    if (cur && cur.length + b.length > 1200) {
      sections.push(cur);
      cur = b;
    } else cur = cur ? `${cur}\n${b}` : b;
    if (cur.length > 1800) {
      sections.push(cur);
      cur = "";
    }
  }
  if (cur) sections.push(cur);
  return sections;
}

export function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function buildKnowledgeContext(process_id, { maxChars = 400000 } = {}) {
  const approved = await db.listDocs("kb_documents", {
    process_id,
    status: "approved",
    limit: 500,
    withBody: true,
  });
  if (!approved.length)
    return { text: "", docs: [], docMap: new Map(), empty: true, truncated: false };
  const total = approved.reduce((s, d) => s + (d.body?.length || 0), 0);
  const ratio = total > maxChars ? maxChars / total : 1;
  const docMap = new Map();
  const parts = [];
  for (const d of approved) {
    const body =
      ratio < 1
        ? String(d.body || "").slice(0, Math.floor((d.body || "").length * ratio))
        : String(d.body || "");
    const sections = splitSections(body);
    docMap.set(d.id, {
      id: d.id,
      title: d.title,
      version: d.version,
      doc_type: d.doc_type,
      sections,
      norm: normalizeForMatch(d.body),
    });
    parts.push(
      `=== DOCUMENT doc_id=${d.id} | "${d.title}" | ${d.doc_type} | v${d.version} ===\n${sections
        .map((s, i) => `[§${i + 1}] ${s}`)
        .join("\n")}`
    );
  }
  return {
    text: parts.join("\n\n"),
    docs: approved.map((d) => ({
      id: d.id,
      title: d.title,
      version: d.version,
      doc_type: d.doc_type,
    })),
    docMap,
    empty: false,
    truncated: ratio < 1,
  };
}

export const SOURCE_REF_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    doc_id: { type: Type.STRING },
    section: { type: Type.INTEGER },
    quote: { type: Type.STRING },
  },
  required: ["doc_id", "section", "quote"],
};

export function verifyRefs(refs, ctx) {
  return (Array.isArray(refs) ? refs : []).slice(0, 8).map((r) => {
    const doc = ctx.docMap.get(String(r.doc_id || "").trim());
    const quote = String(r.quote || "")
      .trim()
      .slice(0, 600);
    const probe = normalizeForMatch(quote).slice(0, 80);
    const verified = Boolean(doc && probe && probe.length >= 8 && doc.norm.includes(probe));
    return {
      doc_id: doc ? doc.id : String(r.doc_id || "").slice(0, 40),
      doc_title: doc?.title || "Unknown document",
      version: doc?.version || null,
      section: Number.isFinite(Number(r.section)) ? Number(r.section) : null,
      quote,
      verified,
    };
  });
}

export const KB_RULES = `KNOWLEDGE RULES (mandatory)
- Use ONLY the APPROVED PROCESS DOCUMENTS below as the source of truth. Do not use outside knowledge about the company, its policies, timelines, amounts or procedures.
- Every fact, expected response, correct answer and evaluation criterion must be supported by a citation: { doc_id (exactly as shown in the document header), section (the [§n] number), quote (verbatim words copied from that section) }.
- If the documents are silent, ambiguous or contradict each other on something you need, DO NOT GUESS: flag it (ambiguity / conflict / gap) with citations and leave it out.`;

// ---------------------------------------------------------------- knowledge-base analysis
const ISSUE_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,80}$/;
const REMARK_STATUSES = new Set(["noted", "fixed", "ignored"]);

/**
 * Resolves an issue reference (e.g. "ISS-02", "ISSUE-ABC", "2", "issue-3")
 * to an index in the issues array. Falls back to index-based matching so old
 * analyses without id fields still work.
 */
function resolveIssueIndex(issues, issueId) {
  const raw = String(issueId || "").trim();
  if (!raw) return -1;

  // 1) Exact match
  let idx = issues.findIndex((i) => i.id === raw);
  if (idx !== -1) return idx;

  // 2) Case-insensitive exact match
  const upper = raw.toUpperCase();
  idx = issues.findIndex((i) => String(i.id || "").toUpperCase() === upper);
  if (idx !== -1) return idx;

  // 3) Trailing number -> index (ISS-02, ISSUE-2, "2", "issue-3")
  const m = raw.match(/(\d+)\s*$/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= issues.length) return n - 1;
    if (n >= 0 && n < issues.length) return n;
  }

  // 4) Fuzzy: compare normalized slugs (strip non-alphanumeric, uppercase)
  const norm = (s) =>
    String(s || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  const target = norm(raw);
  if (target) {
    idx = issues.findIndex((i) => norm(i.id) === target);
    if (idx !== -1) return idx;

    // 5) Prefix / contains match (handles ISSUE-CANCELLATION vs ISSUE-CANCELLATION-CHARGES)
    idx = issues.findIndex((i) => {
      const a = norm(i.id);
      return a && (a.startsWith(target) || target.startsWith(a));
    });
    if (idx !== -1) return idx;

    // 6) Partial contains (last-resort)
    idx = issues.findIndex((i) => {
      const a = norm(i.id);
      return a && (a.includes(target) || target.includes(a));
    });
    if (idx !== -1) return idx;
  }

  // 7) Match by description text (if issueId contains a recognizable word)
  const words = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 4);
  if (words.length) {
    idx = issues.findIndex((i) => {
      const d = String(i.description || "").toLowerCase();
      return words.every((w) => d.includes(w));
    });
    if (idx !== -1) return idx;
  }

  return -1;
}

function slugifyIssueId(issue, index) {
  const raw = String(issue?.id || "")
    .trim()
    .toUpperCase();
  if (ISSUE_ID_PATTERN.test(raw)) return raw;
  // Fallback: stable index-based id
  return `ISS-${String(index + 1).padStart(2, "0")}`;
}

const ISSUE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    id: {
      type: Type.STRING,
      description:
        "Stable uppercase slug, e.g. ISSUE-CANCELLATION-CHARGES. Must be unique per process and reproducible if the same issue is re-analysed.",
    },
    type: { type: Type.STRING, enum: ["conflict", "ambiguity", "gap", "outdated"] },
    severity: { type: Type.STRING, enum: ["high", "medium", "low"] },
    description: { type: Type.STRING },
    recommendation: { type: Type.STRING },
    source_refs: { type: Type.ARRAY, items: SOURCE_REF_SCHEMA },
  },
  required: ["id", "type", "severity", "description", "recommendation", "source_refs"],
};

const ANALYSIS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    topics: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          description: { type: Type.STRING },
          importance: { type: Type.STRING, enum: ["high", "medium", "low"] },
          source_refs: { type: Type.ARRAY, items: SOURCE_REF_SCHEMA },
        },
        required: ["name", "description", "importance", "source_refs"],
      },
    },
    issues: { type: Type.ARRAY, items: ISSUE_SCHEMA },
  },
  required: ["summary", "topics", "issues"],
};

function normalizeIssue(i, index, ctx) {
  const id = slugifyIssueId(i, index);
  return {
    id,
    type: ["conflict", "ambiguity", "gap", "outdated"].includes(i?.type)
      ? i.type
      : "ambiguity",
    severity: ["high", "medium", "low"].includes(i?.severity) ? i.severity : "medium",
    description: String(i?.description || "").slice(0, 1200),
    recommendation: String(i?.recommendation || "").slice(0, 800),
    source_refs: verifyRefs(i?.source_refs, ctx),
    trainer_remark: "",
    trainer_remark_status: "noted",
    trainer_remark_at: null,
    trainer_remark_by: null,
    reanalysed_at: null,
    reanalysis_history: [],
  };
}

/**
 * Backfills ids, remark fields, etc. on old analyses that were generated before
 * the id schema existed. Safe to call every time; returns a shallow-cloned
 * analysis with normalized issues.
 */
export function normalizeAnalysis(analysis) {
  if (!analysis) return analysis;
  const issues = (analysis.issues || []).map((i, index) => ({
    id: i.id || `ISS-${String(index + 1).padStart(2, "0")}`,
    type: i.type || "ambiguity",
    severity: i.severity || "medium",
    description: i.description || "",
    recommendation: i.recommendation || "",
    source_refs: i.source_refs || [],
    trainer_remark: i.trainer_remark || "",
    trainer_remark_status: i.trainer_remark_status || "noted",
    trainer_remark_at: i.trainer_remark_at || null,
    trainer_remark_by: i.trainer_remark_by || null,
    reanalysed_at: i.reanalysed_at || null,
    reanalysis_history: i.reanalysis_history || [],
  }));
  return { ...analysis, issues };
}

export async function analyzeKnowledgeBase(process_id, actor) {
  const ctx = await buildKnowledgeContext(process_id);
  if (ctx.empty)
    throw httpError("Approve at least one document in the knowledge base first.", 409);
  const cfg = getGeminiConfig();

  const previous = await getKnowledgeAnalysis(process_id);
  const previousById = new Map();
  for (const i of previous?.issues || []) if (i.id) previousById.set(i.id, i);

  const prompt = `You are a contact-center training analyst. Analyse the APPROVED PROCESS DOCUMENTS of one client process.

${KB_RULES}

TASKS
1. "summary": 3-5 sentences describing what the process covers.
2. "topics": 6-25 distinct, testable knowledge topics (e.g. "Refund eligibility", "Order tracking", "Escalation to L2"), each with a short description, importance and citations. These topics are used to configure knowledge tests, so make them specific and non-overlapping.
3. "issues": every conflict between documents/versions, ambiguous rule, missing information an agent would need, or outdated-looking content - with severity, a recommendation for the trainer and citations. Return an empty array if there are none.

IMPORTANT: Every issue MUST have a stable "id" field - an uppercase slug (e.g. "ISSUE-CANCELLATION-CHARGES", "ISSUE-WARRANTY-PERIOD", "ISSUE-ESCALATION-CONTACT"). If the same underlying problem existed in a previous analysis, reuse the EXACT same id so trainer remarks are preserved across re-analyses. Derive the id from the core topic, not from the wording.

APPROVED PROCESS DOCUMENTS${ctx.truncated ? " (long documents were truncated)" : ""}:
${ctx.text}`;

  const { data } = await generateStructuredJson({
    model: cfg.generationModel,
    parts: [{ text: prompt }],
    schema: ANALYSIS_SCHEMA,
    temperature: 0.2,
  });

  const seenIds = new Set();
  const issues = (data.issues || []).slice(0, 60).map((raw, index) => {
    const normalized = normalizeIssue(raw, index, ctx);
    let candidate = normalized.id;
    let suffix = 2;
    while (seenIds.has(candidate)) {
      candidate = `${normalized.id}-${suffix}`.slice(0, 80);
      suffix += 1;
    }
    seenIds.add(candidate);
    normalized.id = candidate;

    const prev = previousById.get(candidate);
    if (prev) {
      normalized.trainer_remark = prev.trainer_remark || "";
      normalized.trainer_remark_status = prev.trainer_remark_status || "noted";
      normalized.trainer_remark_at = prev.trainer_remark_at || null;
      normalized.trainer_remark_by = prev.trainer_remark_by || null;
      normalized.reanalysis_history = prev.reanalysis_history || [];
    }
    return normalized;
  });

  const analysis = {
    process_id,
    summary: String(data.summary || "").slice(0, 3000),
    topics: (data.topics || [])
      .slice(0, 40)
      .map((t) => ({
        name: String(t.name || "").slice(0, 120),
        description: String(t.description || "").slice(0, 600),
        importance: t.importance || "medium",
        source_refs: verifyRefs(t.source_refs, ctx),
      }))
      .filter((t) => t.name),
    issues,
    documents: ctx.docs,
    truncated: ctx.truncated,
    model: cfg.generationModel,
    analysed_at: nowIso(),
    analysed_by: actor,
  };

  await db.saveSetting(`kb_analysis:${process_id}`, analysis);
  await audit("kb.analysed", {
    entity_type: "process",
    entity_id: process_id,
    process_id,
    actor,
    summary: `Knowledge base analysed: ${analysis.topics.length} topics, ${analysis.issues.length} issues`,
    details: { documents: ctx.docs, issues: analysis.issues.length },
  });
  return analysis;
}

export async function getKnowledgeAnalysis(process_id) {
  const stored = (await db.getSetting(`kb_analysis:${process_id}`)) || null;
  return normalizeAnalysis(stored);
}

/** Saves a trainer remark on ONE issue. No Gemini call, other issues untouched. */
export async function saveTrainerRemark({ processId, issueId, remark, status, actor }) {
  if (!processId) throw httpError("process_id is required", 400);
  if (!issueId) throw httpError("issueId is required", 400);
  const analysis = await getKnowledgeAnalysis(processId);
  if (!analysis) throw httpError("Run a knowledge-base analysis first.", 404);
  const issues = Array.isArray(analysis.issues) ? analysis.issues : [];

  const idx = resolveIssueIndex(issues, issueId);
  if (idx === -1)
    throw httpError(`Issue ${issueId} not found in this analysis.`, 404);

  const next = {
    ...issues[idx],
    trainer_remark: String(remark || "").slice(0, 4000),
    trainer_remark_status: REMARK_STATUSES.has(status) ? status : "noted",
    trainer_remark_at: nowIso(),
    trainer_remark_by: actor || "trainer",
  };
  const nextIssues = issues.slice();
  nextIssues[idx] = next;
  const updatedAnalysis = { ...analysis, issues: nextIssues, updated_at: nowIso() };

  await db.saveSetting(`kb_analysis:${processId}`, updatedAnalysis);
  await audit("kb.issue_remark_saved", {
    entity_type: "process",
    entity_id: processId,
    process_id: processId,
    actor,
    summary: `${next.id}: remark saved (${next.trainer_remark_status})`,
    details: {
      issue_id: next.id,
      status: next.trainer_remark_status,
      remark_length: next.trainer_remark.length,
    },
  });
  return { analysis: updatedAnalysis, issue: next };
}

/** Re-runs Gemini ONLY for one issue. Others (and their remarks) untouched. */
export async function reanalyseSingleIssue({ processId, issueId, actor }) {
  if (!processId) throw httpError("process_id is required", 400);
  if (!issueId) throw httpError("issueId is required", 400);
  const analysis = await getKnowledgeAnalysis(processId);
  if (!analysis) throw httpError("Run a knowledge-base analysis first.", 404);
  const issues = Array.isArray(analysis.issues) ? analysis.issues : [];

  const idx = resolveIssueIndex(issues, issueId);
  if (idx === -1)
    throw httpError(`Issue ${issueId} not found in this analysis.`, 404);
  const target = issues[idx];

  const ctx = await buildKnowledgeContext(processId);
  if (ctx.empty)
    throw httpError("Approve at least one document in the knowledge base first.", 409);
  const cfg = getGeminiConfig();

  const refsBlock = (target.source_refs || [])
    .map(
      (r) =>
        `- [${r.doc_id}] §${r.section ?? "?"} | verified=${
          r.verified ? "yes" : "no"
        }\n  quote: "${r.quote || ""}"`
    )
    .join("\n");

  const prompt = `You are a contact-center training analyst. You previously flagged ONE issue in the approved knowledge base. Re-examine it against the CURRENT approved documents, taking the trainer's remark into account. Return the SAME issue id "${target.id}" with an updated description/recommendation (or unchanged if still valid).

${KB_RULES}

ORIGINAL ISSUE (id=${target.id})
- type: ${target.type}
- severity: ${target.severity}
- description: ${target.description}
- recommendation: ${target.recommendation}
- source_refs:
${refsBlock || "  (none)"}

TRAINER REMARK (context, may be empty)
- status: ${target.trainer_remark_status || "noted"}
- remark: ${target.trainer_remark || "(none)"}

TASKS
1. Re-check whether the issue still exists, has changed severity, or has been resolved by the documents.
2. If resolved, set severity to "low" and note in the recommendation that it now appears resolved, but KEEP the same id so history is preserved.
3. Keep citations accurate - quote verbatim from the approved documents.

APPROVED PROCESS DOCUMENTS${ctx.truncated ? " (long documents were truncated)" : ""}:
${ctx.text}`;

  const { data } = await generateStructuredJson({
    model: cfg.generationModel,
    parts: [{ text: prompt }],
    schema: ISSUE_SCHEMA,
    temperature: 0.2,
  });

  const fresh = normalizeIssue(data, idx, ctx);
  fresh.id = target.id;
  fresh.trainer_remark = target.trainer_remark || "";
  fresh.trainer_remark_status = target.trainer_remark_status || "noted";
  fresh.trainer_remark_at = target.trainer_remark_at || null;
  fresh.trainer_remark_by = target.trainer_remark_by || null;
  fresh.reanalysed_at = nowIso();
  fresh.reanalysis_history = [
    ...(target.reanalysis_history || []),
    {
      at: nowIso(),
      by: actor || "trainer",
      previous: {
        type: target.type,
        severity: target.severity,
        description: target.description,
        recommendation: target.recommendation,
      },
    },
  ].slice(-10);

  const nextIssues = issues.slice();
  nextIssues[idx] = fresh;
  const updatedAnalysis = {
    ...analysis,
    issues: nextIssues,
    last_reanalysed_issue: target.id,
    last_reanalysed_at: nowIso(),
  };
  await db.saveSetting(`kb_analysis:${processId}`, updatedAnalysis);
  await audit("kb.issue_reanalysed", {
    entity_type: "process",
    entity_id: processId,
    process_id: processId,
    actor,
    summary: `${target.id} re-analysed individually`,
    details: { issue_id: target.id, severity: fresh.severity, type: fresh.type },
  });
  return { analysis: updatedAnalysis, issue: fresh };
}

/** Short knowledge excerpt for the voice-call evaluator (policy check). */
export async function knowledgeForEvaluation(process_id, maxChars = 150000) {
  try {
    const ctx = await buildKnowledgeContext(process_id, { maxChars });
    return ctx.empty ? null : ctx.text;
  } catch {
    return null;
  }
}