"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import AdminShell from "@/components/AdminShell";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { useProcessPicker, ProcessSelect, Pill, pct, ATTEMPT_TONE, INTEGRITY_TONE } from "@/components/trainer/common";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import ShareLink from "@/components/pkt/ShareLink";

const TYPES = [
  { id: "mcq", label: "Multiple choice" },
  { id: "multi", label: "Multiple select" },
  { id: "tf", label: "True / False" },
  { id: "scenario", label: "Scenario-based" },
];
const EMPTY = {
  title: "",
  description: "",
  question_count: 20,
  topics: [],
  difficulty: "mixed",
  question_types: ["mcq", "multi", "tf", "scenario"],
  duration_minutes: 30,
  passing_score: 80,
  marks: { mcq: 1, multi: 2, tf: 1, scenario: 2 },
  require_review: true,
  mandatory: false,
  show_result_to_agent: true,
  proctoring: { camera: true, live_ai: true, screen: true, fullscreen: true, block_copy_paste: true, max_violations: 5, ai_review: true },
};

function BlueprintForm({ processId, topicsAvailable, initial, onSaved, onCancel }) {
  const [f, setF] = useState(initial || EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [customTopic, setCustomTopic] = useState("");
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const toggle = (k, v) => setF((x) => ({ ...x, [k]: x[k].includes(v) ? x[k].filter((y) => y !== v) : [...x[k], v] }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (initial?.id) await api.updateBlueprint(initial.id, f);
      else await api.createBlueprint({ ...f, process_id: processId });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-4 md:grid-cols-4">
        <div className="md:col-span-2">
          <Field label="Test title" required>
            <input className={inputClass} value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. SoTrue PKT - post-training" />
          </Field>
        </div>
        <Field label="Questions">
          <input type="number" min={3} max={100} className={inputClass} value={f.question_count} onChange={(e) => set("question_count", Number(e.target.value))} />
        </Field>
        <Field label="Difficulty">
          <select className={inputClass} value={f.difficulty} onChange={(e) => set("difficulty", e.target.value)}>
            {["mixed", "easy", "medium", "hard"].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </Field>
        <Field label="Duration (minutes)">
          <input type="number" min={5} max={240} className={inputClass} value={f.duration_minutes} onChange={(e) => set("duration_minutes", Number(e.target.value))} />
        </Field>
        <Field label="Passing score (%)">
          <input type="number" min={1} max={100} className={inputClass} value={f.passing_score} onChange={(e) => set("passing_score", Number(e.target.value))} />
        </Field>
        <Field label="Max proctoring violations (auto-submit)">
          <input type="number" min={1} max={50} className={inputClass} value={f.proctoring.max_violations} onChange={(e) => set("proctoring", { ...f.proctoring, max_violations: Number(e.target.value) })} />
        </Field>
        <div className="flex flex-col justify-end gap-1 text-sm text-slate-700">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.require_review} onChange={(e) => set("require_review", e.target.checked)} /> Trainer reviews each paper before start
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.mandatory} onChange={(e) => set("mandatory", e.target.checked)} /> Mandatory for certification
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.show_result_to_agent !== false} onChange={(e) => set("show_result_to_agent", e.target.checked)} /> Show score to the agent after submitting
          </label>
        </div>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-slate-700">Question types & marks</p>
        <div className="flex flex-wrap gap-3">
          {TYPES.map((t) => (
            <label key={t.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${f.question_types.includes(t.id) ? "border-brand-300 bg-brand-50" : "border-slate-200"}`}>
              <input type="checkbox" checked={f.question_types.includes(t.id)} onChange={() => toggle("question_types", t.id)} />
              {t.label}
              <input type="number" min={1} max={10} className="w-14 rounded border border-slate-300 px-1 py-0.5 text-xs" value={f.marks[t.id]} onChange={(e) => set("marks", { ...f.marks, [t.id]: Number(e.target.value) })} title="Marks" />
              <span className="text-xs text-slate-400">marks</span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-slate-700">Topics {topicsAvailable.length ? "(from knowledge-base analysis - none selected = all topics)" : "(run the knowledge-base analysis to get topic suggestions)"}</p>
        <div className="flex flex-wrap gap-2">
          {[...new Set([...topicsAvailable, ...f.topics])].map((t) => (
            <button key={t} type="button" onClick={() => toggle("topics", t)} className={`rounded-full px-3 py-1 text-xs ${f.topics.includes(t) ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600"}`}>
              {t}
            </button>
          ))}
          <input className="rounded-full border border-slate-300 px-3 py-1 text-xs" placeholder="+ custom topic, Enter" value={customTopic} onChange={(e) => setCustomTopic(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (customTopic.trim()) { set("topics", [...new Set([...f.topics, customTopic.trim()])]); setCustomTopic(""); } } }} />
        </div>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-slate-700">Proctoring (anti-cheating)</p>
        <div className="flex flex-wrap gap-4 text-sm text-slate-700">
          {[
            ["camera", "Camera on & recorded"],
            ["live_ai", "Live camera AI: phone, another person, face missing, looking away / down"],
            ["screen", "Entire screen shared & recorded"],
            ["fullscreen", "Force fullscreen"],
            ["block_copy_paste", "Block copy / paste / right-click"],
            ["ai_review", "AI reviews camera + screen for cheating (ChatGPT, phone, other person…)"],
          ].map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" checked={f.proctoring[k]} onChange={(e) => set("proctoring", { ...f.proctoring, [k]: e.target.checked })} /> {label}
            </label>
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="submit" loading={busy}>
          {initial?.id ? "Save test" : "Create test"}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function PktContent() {
  const { processes, processId, setProcessId, process } = useProcessPicker();
  const [blueprints, setBlueprints] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [agents, setAgents] = useState([]);
  const [topics, setTopics] = useState([]);
  const [editing, setEditing] = useState(null);
  const [assign, setAssign] = useState({ blueprint_id: "", agent_id: "", mode: "online" });
  const [justAssigned, setJustAssigned] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("open");
  const [kbReady, setKbReady] = useState(true);

  const load = useCallback(async () => {
    if (!processId) return;
    try {
      const [b, a, ag, an, kb] = await Promise.all([api.listBlueprints(processId), api.listPktAttempts({ process_id: processId }), api.listAgents(processId), api.getKbAnalysis(processId), api.listKbDocuments(processId)]);
      setBlueprints(b.blueprints || []);
      setAttempts(a.attempts || []);
      setAgents(ag.agents || []);
      setTopics((an.analysis?.topics || []).map((t) => t.name));
      setKbReady((kb.documents || []).some((d) => d.status === "approved"));
      setAssign((x) => ({ ...x, blueprint_id: x.blueprint_id || b.blueprints?.find((y) => y.status === "active")?.id || "" }));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [processId]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!attempts.some((a) => a.status === "generating")) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [attempts, load]);

  const doAssign = async () => {
    setBusy("assign");
    setError(null);
    try {
      const d = await api.createPktAttempt(assign);
      setJustAssigned(d.attempt);
      setAssign((x) => ({ ...x, agent_id: "" }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const action = async (a, act, payload = {}) => {
    setBusy(a.id + act);
    setError(null);
    try {
      if (act === "cancel") {
        const reason = window.prompt("Reason for cancelling this test?") ?? null;
        if (reason === null) return;
        payload = { reason };
      }
      await api.pktAction(a.id, act, payload);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const archiveBp = async (bp) => {
    await api.updateBlueprint(bp.id, { status: bp.status === "archived" ? "active" : "archived" });
    load();
  };

  const visible = useMemo(() => attempts.filter((a) => (filter === "all" ? true : filter === "open" ? ["generating", "review", "ready", "in_progress", "failed_generation"].includes(a.status) : a.status === filter)), [attempts, filter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <ProcessSelect processes={processes} value={processId} onChange={setProcessId} />
        <span className="text-sm text-slate-500">PKTs are conducted inside this panel - no test link is created. Each test or retest gets a fresh AI paper from the approved SOPs.</span>
      </div>
      {!kbReady ? (
        <Alert tone="warning" title="No approved knowledge-base documents">
          Upload and approve SOPs in the <Link className="font-semibold underline" href="/admin/knowledge">Knowledge base</Link> first - questions are generated only from approved documents.
        </Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Assign a knowledge test" subtitle="A fresh question paper is generated for this agent (previous questions are avoided)." className="xl:col-span-1">
          <div className="space-y-3">
            <Field label="Test">
              <select className={inputClass} value={assign.blueprint_id} onChange={(e) => setAssign({ ...assign, blueprint_id: e.target.value })}>
                <option value="">Select…</option>
                {blueprints.filter((b) => b.status === "active").map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title} ({b.question_count} q · {b.duration_minutes} min)
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Agent" hint={agents.length ? "" : "Add agents to this process on the Agents page."}>
              <select className={inputClass} value={assign.agent_id} onChange={(e) => setAssign({ ...assign, agent_id: e.target.value })}>
                <option value="">Select…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.employee_id ? ` · ${a.employee_id}` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Mode">
              <select className={inputClass} value={assign.mode} onChange={(e) => setAssign({ ...assign, mode: e.target.value })}>
                <option value="online">Online - work from home (share a personal link)</option>
                <option value="in_person">In person (agent uses this computer)</option>
              </select>
            </Field>
            <Button className="w-full" onClick={doAssign} loading={busy === "assign"} disabled={!assign.blueprint_id || !assign.agent_id || !kbReady}>
              Assign & generate paper
            </Button>
            {justAssigned ? (
              <div className="pt-2">
                <p className="mb-2 text-xs text-emerald-700">✓ Assigned to {justAssigned.agent?.name}. A fresh paper is being generated{justAssigned.blueprint?.require_review !== false ? " - approve it on the attempt page" : ""}.</p>
                <ShareLink attempt={justAssigned} />
              </div>
            ) : null}
          </div>
        </Card>

        <Card
          title="Knowledge tests (blueprints)"
          className="xl:col-span-2"
          actions={
            !editing ? (
              <Button size="sm" onClick={() => setEditing("new")}>
                + New test
              </Button>
            ) : null
          }
        >
          {editing ? (
            <BlueprintForm processId={processId} topicsAvailable={topics} initial={editing === "new" ? { ...EMPTY, title: `${process?.process_name || ""} PKT` } : editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
          ) : blueprints.length === 0 ? (
            <p className="text-sm text-slate-500">No tests configured yet. Click “New test”.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {blueprints.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                  <span className="font-semibold text-slate-900">{b.title}</span>
                  {b.status === "archived" ? <Pill>archived</Pill> : null}
                  {b.mandatory ? <Pill tone="red">mandatory</Pill> : null}
                  <span className="text-xs text-slate-500">
                    {b.question_count} q · {b.difficulty} · {b.duration_minutes} min · pass {b.passing_score}% · {b.question_types.join("/")} · {b.topics.length ? `${b.topics.length} topics` : "all topics"} · {b.proctoring.camera ? "camera" : "no camera"}+{b.proctoring.screen ? "screen" : "no screen"}
                  </span>
                  <div className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(b)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => archiveBp(b)}>
                      {b.status === "archived" ? "Restore" : "Archive"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title="Test attempts"
        padded={false}
        actions={
          <select className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="open">Open</option>
            <option value="scored">Scored</option>
            <option value="all">All</option>
            <option value="invalidated">Invalidated</option>
            <option value="cancelled">Cancelled</option>
          </select>
        }
      >
        {visible.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No attempts in this view.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Agent</th>
                  <th className="px-4 py-2">Test</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 text-center">Score</th>
                  <th className="px-4 py-2">Integrity</th>
                  <th className="px-4 py-2">Created</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((a) => (
                  <tr key={a.id} className="align-top hover:bg-slate-50">
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-slate-800">{a.agent?.name}</p>
                      <p className="font-mono text-[11px] text-slate-400">
                        {a.id} · attempt {a.attempt_no} · {a.mode === "online" ? "online" : "in person"}
                      </p>
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">
                      {a.blueprint?.title}
                      <span className="block text-[11px] text-slate-400">{a.question_count || a.blueprint?.question_count} questions</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <Pill tone={ATTEMPT_TONE[a.status]}>{a.status === "generating" ? "generating paper…" : a.status.replace(/_/g, " ")}</Pill>
                      {a.error ? <p className="mt-1 max-w-xs text-[11px] text-rose-600">{a.error}</p> : null}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {a.result ? (
                        <span className={`font-bold ${a.result.passed ? "text-emerald-600" : "text-rose-600"}`}>
                          {pct(a.result.percentage)}
                          <span className="block text-[11px] font-normal text-slate-400">{a.result.passed ? "pass" : "fail"}</span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {a.status === "scored" || a.status === "invalidated" ? <Pill tone={INTEGRITY_TONE[a.proctoring?.integrity?.status || "pending"]}>{a.proctoring?.integrity?.status || "pending"}</Pill> : null}
                      {a.proctoring?.violations ? <span className="block text-[11px] text-amber-600">{a.proctoring.violations} violation(s)</span> : null}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{formatDateTime(a.created_at)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="secondary" href={`/admin/pkt/attempt/${a.id}`}>
                          {a.status === "review" ? "Review paper" : a.status === "scored" ? "Result" : "Open"}
                        </Button>
                        <ShareLink attempt={a} compact />
                        {["ready", "in_progress"].includes(a.status) ? (
                          <Button size="sm" href={`/admin/pkt/take/${a.id}`} title="Run the test on this computer">
                            {a.status === "in_progress" ? "Resume here" : "Start here"}
                          </Button>
                        ) : null}
                        {a.status === "failed_generation" ? (
                          <Button size="sm" onClick={() => action(a, "regenerate")} loading={busy === a.id + "regenerate"}>
                            Retry generation
                          </Button>
                        ) : null}
                        {["scored", "invalidated"].includes(a.status) ? (
                          <Button size="sm" variant="ghost" onClick={() => action(a, "retest")} loading={busy === a.id + "retest"}>
                            Retest (fresh paper)
                          </Button>
                        ) : null}
                        {["generating", "review", "ready", "failed_generation"].includes(a.status) ? (
                          <Button size="sm" variant="ghost" onClick={() => action(a, "cancel")}>
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function PktPage() {
  return (
    <AdminShell title="Process Knowledge Tests (PKT)" subtitle="AI-generated, document-grounded knowledge tests with camera + screen proctoring - conducted in this panel." wide>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <PktContent />
      </Suspense>
    </AdminShell>
  );
}
