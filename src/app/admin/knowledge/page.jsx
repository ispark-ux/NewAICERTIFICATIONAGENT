"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { Alert, Button, Card, Field, Modal, Spinner, inputClass } from "@/components/ui";
import { api } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { useProcessPicker, ProcessSelect, Refs } from "@/components/trainer/common";

const STATUS = {
  uploading: "bg-slate-100 text-slate-600",
  draft: "bg-amber-50 text-amber-700",
  approved: "bg-emerald-50 text-emerald-700",
  archived: "bg-slate-100 text-slate-500",
  failed: "bg-rose-50 text-rose-700",
};
const SEV = {
  high: "bg-rose-600 text-white",
  medium: "bg-amber-500 text-white",
  low: "bg-slate-400 text-white",
};
const REMARK_STATUS = {
  noted: { cls: "bg-slate-100 text-slate-600", label: "Noted" },
  fixed: { cls: "bg-emerald-50 text-emerald-700", label: "Fixed" },
  ignored: { cls: "bg-slate-100 text-slate-400", label: "Ignored" },
};

function UploadCard({ processId, docTypes, replaceTarget, onDone, onCancelReplace }) {
  const [mode, setMode] = useState("file");
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("sop");
  const [notes, setNotes] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (replaceTarget) {
      setTitle(replaceTarget.title);
      setDocType(replaceTarget.doc_type);
    }
  }, [replaceTarget]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const base = {
        process_id: processId,
        title: title || file?.name?.replace(/\.[^.]+$/, "") || "",
        doc_type: docType,
        notes,
        replaces_id: replaceTarget?.id || undefined,
      };
      if (mode === "text") {
        await api.createKbDocument({ ...base, text });
      } else {
        if (!file) throw new Error("Choose a file first.");
        setProgress("Registering document…");
        const created = await api.createKbDocument({
          ...base,
          file_name: file.name,
          mime_type: file.type || "",
          size: file.size,
        });
        const id = created.document.id;
        const partSize = created.part_size;
        const count = Math.max(1, Math.ceil(file.size / partSize));
        for (let i = 0; i < count; i += 1) {
          for (let attempt = 0; ; attempt += 1) {
            try {
              await api.uploadKbPart(
                id,
                i,
                file.slice(i * partSize, Math.min(file.size, (i + 1) * partSize))
              );
              break;
            } catch (err) {
              if (attempt >= 4 || (err.status && err.status < 500 && err.status !== 429))
                throw err;
              await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
            }
          }
          setProgress(`Uploading ${Math.round(((i + 1) / count) * 100)}%`);
        }
        setProgress("Extracting text (large or scanned PDFs can take a minute)…");
        await api.completeKbDocument(id, file.size);
      }
      setTitle("");
      setNotes("");
      setText("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      setProgress("");
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  return (
    <Card
      title={
        replaceTarget
          ? `Upload new version of “${replaceTarget.title}” (v${replaceTarget.version + 1})`
          : "Add process document"
      }
      subtitle="SOPs, training manuals, FAQs, call scripts, policies, escalation matrices. New documents start as draft and must be approved before AI uses them."
    >
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-4">
        <div className="flex gap-1 md:col-span-4">
          {["file", "text"].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                mode === m ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
              }`}
            >
              {m === "file" ? "Upload file" : "Paste text"}
            </button>
          ))}
          {replaceTarget ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={onCancelReplace}
            >
              Cancel new version
            </Button>
          ) : null}
        </div>
        <Field label="Title" required>
          <input
            className={inputClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Refund & Returns SOP"
          />
        </Field>
        <Field label="Document type">
          <select
            className={inputClass}
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
          >
            {docTypes.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="md:col-span-2">
          <Field label="Notes (optional)">
            <input
              className={inputClass}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Effective date, owner, what changed…"
            />
          </Field>
        </div>
        {mode === "file" ? (
          <div className="md:col-span-4">
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.csv,.json,.html,.png,.jpg,.jpeg,.webp"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-brand-700"
            />
            <p className="mt-1 text-xs text-slate-500">
              PDF (text or scanned), DOCX, TXT, MD, CSV, PNG/JPG · up to 60 MB · uploaded in 512 KB
              parts (no size errors). Export Excel/PowerPoint to PDF or CSV.
            </p>
          </div>
        ) : (
          <div className="md:col-span-4">
            <textarea
              className={`${inputClass} min-h-[10rem]`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste FAQ / policy / script text here"
            />
          </div>
        )}
        {error ? (
          <div className="md:col-span-4">
            <Alert tone="error">{error}</Alert>
          </div>
        ) : null}
        <div className="flex items-center gap-3 md:col-span-4">
          <Button type="submit" loading={busy} disabled={busy || !processId}>
            {replaceTarget ? "Upload new version" : "Add document"}
          </Button>
          {progress ? <span className="text-sm text-slate-500">{progress}</span> : null}
        </div>
      </form>
    </Card>
  );
}

/**
 * One issue box on the left, Trainer Remarks on the right.
 * Trainer can edit, save, re-analyse just this issue, and mark status.
 */
function IssueCard({ issue, processId, onSaved }) {
  const [remark, setRemark] = useState(issue.trainer_remark || "");
  const [status, setStatus] = useState(issue.trainer_remark_status || "noted");
  const [saving, setSaving] = useState(false);
  const [reanalysing, setReanalysing] = useState(false);
  const [error, setError] = useState(null);
  const [openHistory, setOpenHistory] = useState(false);
  const dirty =
    remark !== (issue.trainer_remark || "") ||
    status !== (issue.trainer_remark_status || "noted");

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.saveIssueRemark(processId, issue.id, { remark, status });
      onSaved(res.issue);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const reanalyse = async () => {
    if (
      !window.confirm(
        `Re-analyse issue ${issue.id} with Gemini? Other issues will not be touched.`
      )
    )
      return;
    setReanalysing(true);
    setError(null);
    try {
      const res = await api.reanalyseIssue(processId, issue.id);
      setRemark(res.issue.trainer_remark || "");
      setStatus(res.issue.trainer_remark_status || "noted");
      onSaved(res.issue);
    } catch (err) {
      setError(err.message);
    } finally {
      setReanalysing(false);
    }
  };

  const st = REMARK_STATUS[status] || REMARK_STATUS.noted;

  return (
    <li className="rounded-lg border border-slate-200 p-3 text-sm">
      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                SEV[issue.severity] || SEV.medium
              }`}
            >
              {issue.severity}
            </span>
            <span className="text-xs font-semibold uppercase text-slate-500">
              {issue.type}
            </span>
            {issue.id ? (
              <span className="mono text-[10px] text-slate-400">{issue.id}</span>
            ) : null}
            {issue.reanalysed_at ? (
              <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700">
                re-analysed {formatDateTime(issue.reanalysed_at)}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-slate-800">{issue.description}</p>
          {issue.recommendation ? (
            <p className="mt-1 text-xs text-slate-600">→ {issue.recommendation}</p>
          ) : null}
          <Refs refs={issue.source_refs} />
        </div>

        <div className="w-full shrink-0 rounded-lg border border-brand-200 bg-brand-50/40 p-3 lg:w-80">
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">
              Trainer Remarks
            </p>
            <span
              className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold ${st.cls}`}
            >
              {st.label}
            </span>
          </div>
          <textarea
            className={`${inputClass} mt-1 min-h-[5rem] text-xs`}
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            placeholder="Correct the policy, add missing info, note what changed…"
          />
          <div className="mt-1 flex items-center gap-2">
            <select
              className={`${inputClass} text-xs`}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="noted">Noted</option>
              <option value="fixed">Fixed</option>
              <option value="ignored">Ignored</option>
            </select>
            <Button size="sm" onClick={save} loading={saving} disabled={!dirty || saving}>
              Save
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={reanalyse}
              loading={reanalysing}
              disabled={reanalysing}
            >
              ↻ Re-analyse
            </Button>
          </div>
          {error ? <p className="mt-1 text-[11px] text-rose-600">{error}</p> : null}
          {issue.trainer_remark_at ? (
            <p className="mt-1 text-[10px] text-slate-500">
              Saved {formatDateTime(issue.trainer_remark_at)}
              {issue.trainer_remark_by ? ` by ${issue.trainer_remark_by}` : ""}
            </p>
          ) : null}
          {issue.reanalysis_history?.length ? (
            <div className="mt-2">
              <button
                type="button"
                className="text-[10px] font-medium text-brand-600 hover:underline"
                onClick={() => setOpenHistory((v) => !v)}
              >
                {openHistory ? "Hide" : "Show"} re-analysis history (
                {issue.reanalysis_history.length})
              </button>
              {openHistory ? (
                <ul className="mt-1 space-y-1 text-[10px] text-slate-500">
                  {issue.reanalysis_history
                    .slice()
                    .reverse()
                    .map((h, i) => (
                      <li key={i} className="rounded bg-white/60 p-1.5">
                        <span className="font-semibold">{formatDateTime(h.at)}</span> ·{" "}
                        {h.by || "trainer"}
                        <div className="text-slate-400">
                          was: {h.previous?.severity}/{h.previous?.type}
                        </div>
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function KnowledgeContent() {
  const { processes, processId, setProcessId, process } = useProcessPicker();
  const [docs, setDocs] = useState([]);
  const [docTypes, setDocTypes] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [error, setError] = useState(null);
  const [view, setView] = useState(null);
  const [replaceTarget, setReplaceTarget] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    if (!processId) return;
    setLoading(true);
    try {
      const [d, a] = await Promise.all([
        api.listKbDocuments(processId),
        api.getKbAnalysis(processId),
      ]);
      setDocs(d.documents || []);
      setDocTypes(d.doc_types || []);
      setAnalysis(a.analysis);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [processId]);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const d of docs) {
      if (!map.has(d.group_id)) map.set(d.group_id, []);
      map.get(d.group_id).push(d);
    }
    return Array.from(map.values()).map((list) =>
      list.sort((a, b) => b.version - a.version)
    );
  }, [docs]);

  const act = async (doc, action) => {
    setBusyId(doc.id);
    setError(null);
    try {
      if (action === "delete") {
        if (!window.confirm(`Delete “${doc.title}” v${doc.version}?`)) return;
        await api.deleteKbDocument(doc.id);
      } else await api.kbDocumentAction(doc.id, action);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const openView = async (doc) => {
    setView({ doc, text: null });
    try {
      const d = await api.getKbDocument(doc.id);
      setView({ doc: d.document, text: d.document.body || "" });
    } catch (err) {
      setView({ doc, text: `Could not load text: ${err.message}` });
    }
  };

  const analyse = async () => {
    setAnalysing(true);
    setError(null);
    try {
      const d = await api.analyzeKb(processId);
      setAnalysis(d.analysis);
    } catch (err) {
      setError(err.message);
    } finally {
      setAnalysing(false);
    }
  };

  const applyIssueUpdate = (updatedIssue) => {
    setAnalysis((prev) => {
      if (!prev) return prev;
      const issues = (prev.issues || []).map((i) =>
        i.id === updatedIssue.id ? updatedIssue : i
      );
      return { ...prev, issues };
    });
  };

  const approved = docs.filter((d) => d.status === "approved");
  const typeLabel = (v) => docTypes.find((t) => t.value === v)?.label || v;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <ProcessSelect processes={processes} value={processId} onChange={setProcessId} />
        <span className="text-sm text-slate-500">
          {approved.length} approved document(s) ·{" "}
          {approved.reduce((s, d) => s + (d.char_count || 0), 0).toLocaleString()} characters used by
          AI
        </span>
        <Button variant="secondary" className="ml-auto" onClick={load} loading={loading}>
          Refresh
        </Button>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <UploadCard
        processId={processId}
        docTypes={docTypes.length ? docTypes : [{ value: "sop", label: "SOP" }]}
        replaceTarget={replaceTarget}
        onCancelReplace={() => setReplaceTarget(null)}
        onDone={() => {
          setReplaceTarget(null);
          load();
        }}
      />

      <Card
        title={`Documents - ${process?.process_name || ""}`}
        subtitle="One approved version per document is used by the scenario generator, PKT generator and voice evaluator. Approving a new version archives the previous one."
        padded={false}
      >
        {groups.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No documents yet.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {groups.map((versions) => {
              const top = versions[0];
              return (
                <div key={top.group_id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-900">{top.title}</p>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                      {typeLabel(top.doc_type)}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() => {
                        setReplaceTarget(top);
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                    >
                      + New version
                    </Button>
                  </div>
                  <table className="mt-2 w-full text-sm">
                    <tbody className="divide-y divide-slate-50">
                      {versions.map((d) => (
                        <tr key={d.id} className="align-top">
                          <td className="w-14 py-1.5 font-mono text-xs text-slate-500">
                            v{d.version}
                          </td>
                          <td className="w-28 py-1.5">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                                STATUS[d.status] || STATUS.draft
                              }`}
                            >
                              {d.status}
                            </span>
                          </td>
                          <td className="py-1.5 text-xs text-slate-600">
                            {d.file_name || "Pasted text"} · {formatBytes(d.size_bytes)} ·{" "}
                            {(d.char_count || 0).toLocaleString()} chars ·{" "}
                            {d.extraction?.method || ""}
                            {d.extraction?.pages ? ` · ${d.extraction.pages} pages` : ""}
                            <span className="block text-slate-400">
                              Uploaded {formatDateTime(d.created_at)} by {d.uploaded_by || "—"}
                              {d.approved_at
                                ? ` · approved ${formatDateTime(d.approved_at)} by ${
                                    d.approved_by
                                  }`
                                : ""}
                            </span>
                            {d.extraction?.warnings?.length ? (
                              <span className="block text-amber-600">
                                ⚠ {d.extraction.warnings.join(" · ")}
                              </span>
                            ) : null}
                            {d.error ? (
                              <span className="block text-rose-600">{d.error}</span>
                            ) : null}
                            {d.notes ? (
                              <span className="block italic text-slate-500">{d.notes}</span>
                            ) : null}
                          </td>
                          <td className="py-1.5 text-right">
                            <div className="flex justify-end gap-1">
                              {d.char_count ? (
                                <Button size="sm" variant="ghost" onClick={() => openView(d)}>
                                  View text
                                </Button>
                              ) : null}
                              {["draft", "archived"].includes(d.status) ? (
                                <Button
                                  size="sm"
                                  onClick={() => act(d, "approve")}
                                  loading={busyId === d.id}
                                >
                                  Approve
                                </Button>
                              ) : null}
                              {d.status === "approved" ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => act(d, "archive")}
                                  loading={busyId === d.id}
                                >
                                  Archive
                                </Button>
                              ) : null}
                              {d.status !== "approved" ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-rose-600"
                                  onClick={() => act(d, "delete")}
                                  disabled={busyId === d.id}
                                >
                                  Delete
                                </Button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card
        title="AI knowledge-base analysis"
        subtitle={
          analysis
            ? `Analysed ${formatDateTime(analysis.analysed_at)} by ${analysis.analysed_by} · ${
                analysis.documents?.length || 0
              } documents${analysis.truncated ? " · (long documents truncated)" : ""}`
            : "Find testable topics and flag conflicting, ambiguous or missing policy before generating scenarios and tests."
        }
        actions={
          <Button onClick={analyse} loading={analysing} disabled={!approved.length || analysing}>
            {analysis ? "Re-analyse" : "Analyse knowledge base"}
          </Button>
        }
      >
        {analysing ? (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Gemini is reading the approved documents (30-90 s)…
          </p>
        ) : null}
        {!analysis && !analysing ? (
          <p className="text-sm text-slate-500">
            {approved.length ? "Not analysed yet." : "Approve at least one document first."}
          </p>
        ) : null}
        {analysis ? (
          <div className="space-y-5">
            <p className="text-sm text-slate-700">{analysis.summary}</p>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Issues to resolve ({analysis.issues.length})
              </p>
              {analysis.issues.length ? (
                <ul className="space-y-2">
                  {analysis.issues.map((i, k) => (
                    <IssueCard
                      key={i.id || k}
                      issue={i}
                      processId={processId}
                      onSaved={applyIssueUpdate}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-emerald-600">
                  No conflicts, ambiguities or gaps found.
                </p>
              )}
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Testable topics ({analysis.topics.length}) - used to configure PKTs
              </p>
              <div className="grid gap-2 md:grid-cols-2">
                {analysis.topics.map((t, k) => (
                  <div key={k} className="rounded-lg border border-slate-200 p-3 text-sm">
                    <p className="font-semibold text-slate-800">
                      {t.name}{" "}
                      <span className="text-[11px] font-normal text-slate-400">
                        · {t.importance}
                      </span>
                    </p>
                    <p className="text-xs text-slate-600">{t.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </Card>

      <Modal
        wide
        open={Boolean(view)}
        title={view ? `${view.doc.title} · v${view.doc.version}` : ""}
        onClose={() => setView(null)}
      >
        {view?.text === null ? (
          <Spinner />
        ) : (
          <pre className="scroll-thin max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
            {view?.text}
          </pre>
        )}
      </Modal>
    </div>
  );
}

export default function KnowledgePage() {
  return (
    <AdminShell
      title="Knowledge base"
      subtitle="Approved process documents - the single source of truth for scenarios, knowledge tests and evaluation."
      wide
    >
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <KnowledgeContent />
      </Suspense>
    </AdminShell>
  );
}