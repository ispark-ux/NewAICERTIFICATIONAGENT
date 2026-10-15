"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { Alert, Button, Card, Field, Spinner, inputClass } from "@/components/ui";
import { useProcessPicker, ProcessSelect, Refs, Pill } from "@/components/trainer/common";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const CATS = ["information", "complaint", "objection", "exception", "escalation", "retention", "other"];
const STATUS_TONE = { draft: "amber", needs_review: "red", approved: "green", rejected: "slate", archived: "slate" };
const DIFF_TONE = { easy: "green", medium: "blue", hard: "red" };

function List({ title, items }) {
  if (!items?.length) return null;
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      <ul className="mt-1 list-disc pl-5 text-sm text-slate-700">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function ScenarioDetail({ scenario, onChanged }) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [ack, setAck] = useState(false);
  const [note, setNote] = useState("");
  const s = scenario;

  const startEdit = () => {
    setForm({ title: s.title, opening_line: s.opening_line, ai_prompt: s.ai_prompt, expected_resolution: s.expected_resolution, evaluator_notes: s.evaluator_notes, summary: s.summary });
    setEdit(true);
  };
  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      await api.updateScenario(s.id, form);
      setEdit(false);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };
  const act = async (action) => {
    setBusy(action);
    setError(null);
    try {
      await api.scenarioAction(s.id, { action, note, acknowledge: ack });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 border-t border-slate-100 bg-slate-50/60 px-5 py-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {s.ambiguities?.length ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
          <p className="text-sm font-semibold text-rose-800">⚠ AI flagged {s.ambiguities.length} ambiguity / conflict - resolve in the documents or edit the scenario before publishing</p>
          <ul className="mt-2 space-y-2">
            {s.ambiguities.map((a, i) => (
              <li key={i} className="text-sm text-rose-900">
                <span className="mr-1 rounded bg-rose-600 px-1 text-[10px] font-bold uppercase text-white">{a.severity}</span>
                {a.description}
                <Refs refs={a.source_refs} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {edit ? (
        <div className="grid gap-3">
          {[
            ["title", "Title", 1],
            ["summary", "Summary", 2],
            ["opening_line", "Opening line (customer speaks first)", 1],
            ["ai_prompt", "AI customer prompt", 12],
            ["expected_resolution", "Expected resolution", 4],
            ["evaluator_notes", "Evaluator notes", 6],
          ].map(([k, label, rows]) => (
            <Field key={k} label={label}>
              {rows === 1 ? <input className={inputClass} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /> : <textarea rows={rows} className={`${inputClass} ${k === "ai_prompt" ? "font-mono text-xs" : ""}`} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />}
            </Field>
          ))}
          <div className="flex gap-2">
            <Button onClick={save} loading={busy === "save"}>
              Save (returns to draft)
            </Button>
            <Button variant="ghost" onClick={() => setEdit(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Customer</p>
              <p className="text-sm text-slate-800">
                {s.customer?.name} {s.customer?.gender ? `(${s.customer.gender})` : ""} · {s.customer?.mood}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Knows (shares when asked)</p>
                {(s.customer?.facts || []).map((f) => (
                  <p key={f.key} className="text-xs text-slate-700">
                    <span className="text-slate-400">{f.key.replace(/_/g, " ")}:</span> <span className="font-mono">{f.value}</span>
                  </p>
                ))}
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Hidden (agent must find / tell)</p>
                {(s.hidden_facts || []).map((f) => (
                  <p key={f.key} className="text-xs text-slate-700">
                    <span className="text-slate-400">{f.key.replace(/_/g, " ")}:</span> {f.value}
                  </p>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Opening line</p>
              <p className="text-sm italic text-slate-800">“{s.opening_line}”</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Expected resolution</p>
              <p className="whitespace-pre-wrap text-sm text-slate-800">{s.expected_resolution}</p>
            </div>
            <List title="Required probing" items={s.required_probing} />
            <List title="Expected portal actions" items={s.expected_portal_actions} />
            <List title="Expected CRM actions" items={s.expected_crm_actions} />
            <p className="text-sm text-slate-700">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Escalation: </span>
              {s.escalation_required ? `required - ${s.escalation_path}` : "not required"}
            </p>
          </div>
          <div className="space-y-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Evaluator notes</p>
              <p className="whitespace-pre-wrap text-sm text-slate-700">{s.evaluator_notes}</p>
            </div>
            <details>
              <summary className="cursor-pointer text-xs font-semibold text-brand-700">AI customer prompt</summary>
              <pre className="scroll-thin mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-[11px] text-slate-700 ring-1 ring-slate-200">{s.ai_prompt}</pre>
            </details>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Sources ({s.source_refs?.filter((r) => r.verified).length || 0}/{s.source_refs?.length || 0} verified)</p>
              <Refs refs={s.source_refs} />
            </div>
            <p className="text-[11px] text-slate-400">
              Generated {formatDateTime(s.generated_at)} by {s.generated_by} ({s.model}) from {s.kb_documents?.map((d) => `${d.title} v${d.version}`).join(", ")}
              {s.reviewed_at ? ` · ${s.status} by ${s.reviewed_by} ${formatDateTime(s.reviewed_at)}` : ""}
              {s.usage_count ? ` · used in ${s.usage_count} assessment(s)` : ""}
            </p>
          </div>
        </div>
      )}

      {!edit ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
          <input className={`${inputClass} max-w-xs`} placeholder="Review note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          {s.ambiguities?.length && s.status !== "approved" ? (
            <label className="flex items-center gap-1.5 text-xs text-slate-700">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I reviewed the flagged ambiguities
            </label>
          ) : null}
          {s.status !== "approved" ? (
            <Button size="sm" onClick={() => act("approve")} loading={busy === "approve"} disabled={Boolean(s.ambiguities?.length) && !ack}>
              Approve & publish
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onClick={startEdit}>
            Edit
          </Button>
          {s.status !== "rejected" ? (
            <Button size="sm" variant="ghost" onClick={() => act("reject")} loading={busy === "reject"}>
              Reject
            </Button>
          ) : null}
          {s.status !== "archived" ? (
            <Button size="sm" variant="ghost" onClick={() => act("archive")} loading={busy === "archive"}>
              Archive
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ScenariosContent() {
  const { processes, processId, setProcessId } = useProcessPicker();
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(null);
  const [count, setCount] = useState(5);
  const [cats, setCats] = useState([]);
  const [difficulty, setDifficulty] = useState("mixed");
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    if (!processId) return;
    try {
      const d = await api.listScenarios(processId);
      setItems(d.scenarios || []);
    } catch (err) {
      setError(err.message);
    }
  }, [processId]);
  useEffect(() => {
    load();
  }, [load]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const d = await api.generateScenarios({ process_id: processId, count, categories: cats, difficulty, focus });
      setNotice(`${d.scenarios.length} scenario(s) generated${d.kb_issues?.length ? ` · knowledge-base issues noticed: ${d.kb_issues.join(" | ")}` : ""}. Review and approve them below.`);
      await load();
      if (d.scenarios[0]) setOpen(d.scenarios[0].id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const loadDetail = async (id) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    const d = await api.getScenario(id);
    setItems((list) => list.map((x) => (x.id === id ? d.scenario : x)));
  };

  const visible = items.filter((s) => filter === "all" || (filter === "review" ? ["draft", "needs_review"].includes(s.status) : s.status === filter));
  const counts = { approved: items.filter((s) => s.status === "approved").length, review: items.filter((s) => ["draft", "needs_review"].includes(s.status)).length };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <ProcessSelect processes={processes} value={processId} onChange={setProcessId} />
        <span className="text-sm text-slate-500">
          {counts.approved} published · {counts.review} awaiting review. Voice links automatically use a fresh published scenario per agent.
        </span>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card title="Generate scenarios from the knowledge base" subtitle="Scenarios, expected responses and evaluation criteria are derived only from approved documents; anything unclear is flagged instead of guessed.">
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="How many">
            <input type="number" min={1} max={10} className={inputClass} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </Field>
          <Field label="Difficulty">
            <select className={inputClass} value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
              {["mixed", "easy", "medium", "hard"].map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </Field>
          <div className="md:col-span-2">
            <Field label="Trainer focus (optional)">
              <input className={inputClass} value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="e.g. refund objections, angry customers, escalation to L2" />
            </Field>
          </div>
          <div className="md:col-span-4">
            <p className="mb-1 text-sm font-medium text-slate-700">Categories (empty = balanced mix)</p>
            <div className="flex flex-wrap gap-2">
              {CATS.map((c) => (
                <button key={c} type="button" onClick={() => setCats((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]))} className={`rounded-full px-3 py-1 text-sm ${cats.includes(c) ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600"}`}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3 md:col-span-4">
            <Button onClick={generate} loading={busy} disabled={busy || !processId}>
              Generate scenarios
            </Button>
            {busy ? (
              <span className="flex items-center gap-2 text-sm text-slate-500">
                <Spinner className="h-4 w-4" /> Gemini is reading the SOPs and writing scenarios (up to 2 minutes)…
              </span>
            ) : null}
          </div>
        </div>
      </Card>

      <Card
        title="Scenario library"
        padded={false}
        actions={
          <select className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="review">Awaiting review</option>
            <option value="approved">Published</option>
            <option value="rejected">Rejected</option>
            <option value="archived">Archived</option>
          </select>
        }
      >
        {visible.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No scenarios here yet.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {visible.map((s) => (
              <div key={s.id}>
                <button type="button" onClick={() => loadDetail(s.id)} className="flex w-full flex-wrap items-center gap-2 px-5 py-3 text-left hover:bg-slate-50">
                  <span className="font-semibold text-slate-900">{s.title}</span>
                  <Pill tone={STATUS_TONE[s.status]}>{s.status.replace("_", " ")}</Pill>
                  <Pill tone="violet">{s.category}</Pill>
                  <Pill tone={DIFF_TONE[s.difficulty]}>{s.difficulty}</Pill>
                  {s.escalation_required ? <Pill tone="amber">escalation</Pill> : null}
                  {s.ambiguities?.length ? <Pill tone="red">⚠ {s.ambiguities.length} flag(s)</Pill> : null}
                  <span className="ml-auto text-xs text-slate-400">{s.intent}</span>
                </button>
                {open === s.id ? <ScenarioDetail scenario={s} onChanged={load} /> : null}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export default function ScenariosPage() {
  return (
    <AdminShell title="AI scenario generator" subtitle="Realistic, document-grounded customer scenarios for voice certification - a different one for every assessment." wide>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <ScenariosContent />
      </Suspense>
    </AdminShell>
  );
}
