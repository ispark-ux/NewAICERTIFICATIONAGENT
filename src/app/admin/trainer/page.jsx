"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import AdminShell from "@/components/AdminShell";
import { Alert, Button, Card, Modal, Spinner, inputClass } from "@/components/ui";
import { Pill, pct, INTEGRITY_TONE, ATTEMPT_TONE } from "@/components/trainer/common";
import CoachingPlanView from "@/components/trainer/CoachingPlan";
import { BarList, Kpi } from "@/components/analytics/Charts";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const STATUS_TONE = { Certified: "green", "Not certified": "red", "Failed (ZTP)": "red", "In progress": "violet", "Link sent": "blue", "Not started": "slate", "PKT pending": "amber", "Voice pending": "amber", "PKT taken": "blue" };

function Todo({ href, count, label, tone = "amber" }) {
  return (
    <Link href={href} className={`flex items-center justify-between rounded-xl border px-4 py-3 text-sm transition hover:shadow-sm ${count ? (tone === "red" ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50") : "border-slate-200 bg-white"}`}>
      <span className="text-slate-700">{label}</span>
      <span className={`text-xl font-bold ${count ? (tone === "red" ? "text-rose-600" : "text-amber-600") : "text-slate-300"}`}>{count}</span>
    </Link>
  );
}

function TrainerContent() {
  const [processes, setProcesses] = useState([]);
  const [processId, setProcessId] = useState("");
  const [data, setData] = useState(null);
  const [blueprints, setBlueprints] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null);
  const [q, setQ] = useState("");
  const [planView, setPlanView] = useState(null);
  const [health, setHealth] = useState(null);
  const [allBlueprints, setAllBlueprints] = useState(0);
  const [hideGuide, setHideGuide] = useState(false);
  useEffect(() => {
    api.health().then(setHealth).catch(() => {});
    api.listBlueprints().then((d) => setAllBlueprints((d.blueprints || []).length)).catch(() => {});
    try {
      setHideGuide(window.localStorage.getItem("dd_hide_guide") === "1");
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const [d, b] = await Promise.all([api.trainerOverview(processId), api.listBlueprints(processId)]);
      setData(d);
      setBlueprints((b.blueprints || []).filter((x) => x.status === "active"));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [processId]);

  useEffect(() => {
    api.listProcesses(true).then((d) => setProcesses(d.processes || []));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const agents = useMemo(() => (data?.agents || []).filter((a) => !q || `${a.name} ${a.email || ""} ${a.employee_id || ""}`.toLowerCase().includes(q.toLowerCase())), [data, q]);

  const assignPkt = async (a) => {
    const bp = blueprints.find((b) => b.process_id === a.process_id && b.mandatory) || blueprints.find((b) => b.process_id === a.process_id);
    if (!bp) return setError(`No active PKT configured for ${a.process_name}. Create one on the PKT page.`);
    if (!a.agent_id) return setError("Only registered agents can take a PKT - add the agent on the Agents page.");
    setBusy(a.key + "pkt");
    setError(null);
    try {
      const d = await api.createPktAttempt({ blueprint_id: bp.id, agent_id: a.agent_id, mode: "in_person" });
      setNotice(`PKT “${bp.title}” assigned to ${a.name} - a fresh paper is being generated.`);
      await load();
      return d;
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const voiceLink = async (a) => {
    setBusy(a.key + "voice");
    setError(null);
    try {
      let d;
      if (a.latest_session_id && a.attempts > 0) d = await api.recertify(a.latest_session_id, { send_email: Boolean(a.email) });
      else if (a.agent_id) d = await api.inviteAgent(a.agent_id, { send_email: Boolean(a.email) });
      else throw new Error("Agent is not registered.");
      setNotice(`Voice assessment link for ${a.name}: ${window.location.origin}/certification/${d.session.session_id}${d.email?.status === "sent" ? " (emailed)" : ""} · scenario: ${d.session.scenario_title || "process default"}`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const coaching = async (a) => {
    setBusy(a.key + "coach");
    setError(null);
    try {
      if (a.coaching && !window.confirm("Open the existing plan? Cancel = generate a new one.")) {
        const d = await api.createCoaching({ process_id: a.process_id, agent_key: a.key });
        setPlanView(d.plan);
      } else if (a.coaching) {
        const d = await api.listCoaching({ process_id: a.process_id, agent_key: a.key, status: "active" });
        setPlanView(d.plans?.[0] || null);
      } else {
        const d = await api.createCoaching({ process_id: a.process_id, agent_key: a.key });
        setPlanView(d.plan);
      }
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  if (!data) {
    return error ? <Alert tone="error">{error}</Alert> : <p className="flex items-center gap-2 text-slate-500"><Spinner /> Loading…</p>;
  }
  const p = data.pending;
  const o = data.overview;
  const steps = [
    { done: Boolean(health?.gemini_configured), title: "Connect Gemini AI", text: "Save your Gemini API key", href: "/admin/ai-settings", cta: "Add key" },
    { done: processes.length > 0, title: "Set up a process", text: "Scorecard, AI customer prompt, rules", href: "/admin/processes", cta: "Open processes" },
    { done: p.docs_approved > 0, title: "Upload & approve SOPs", text: "The AI learns only from approved documents", href: "/admin/knowledge", cta: "Upload SOP" },
    { done: p.scenarios_approved > 0, title: "Publish customer scenarios", text: "AI writes realistic calls from your SOPs", href: "/admin/scenarios", cta: "Generate" },
    { done: allBlueprints > 0, title: "Create a knowledge test", text: "Questions, time, pass mark, proctoring", href: "/admin/pkt", cta: "Create PKT" },
    { done: (data.agents || []).length > 0, title: "Add your agents", text: "Name, email, process", href: "/admin/agents", cta: "Add agents" },
    { done: o.completed > 0 || data.pkt.scored > 0, title: "Run the first assessment", text: "Share a voice link or a PKT link", href: "/admin", cta: "Send link" },
  ];
  const doneCount = steps.filter((x) => x.done).length;
  const nextStep = steps.find((x) => !x.done);
  const hour = new Date().getHours();
  let actor = "";
  try {
    actor = (typeof window !== "undefined" && window.localStorage.getItem("aac_actor")) || "";
  } catch {
    actor = "";
  }

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 via-indigo-900 to-cyan-800 p-6 text-white shadow-xl">
        <div className="absolute -right-10 -top-10 h-48 w-48 rounded-full bg-cyan-400/20 blur-2xl" />
        <div className="absolute -bottom-16 left-1/3 h-48 w-48 rounded-full bg-indigo-400/20 blur-2xl" />
        <div className="relative flex flex-wrap items-center gap-6">
          <div className="flex-1">
            <p className="text-sm text-cyan-200">{hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"}{actor ? `, ${actor}` : ""} 👋</p>
            <h2 className="mt-1 text-2xl font-extrabold">Welcome to DialDesk</h2>
            <p className="mt-1 max-w-xl text-sm text-slate-200">Train agents from your SOPs, certify them with AI voice calls and proctored knowledge tests, and coach them where they need it.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {nextStep ? (
                <Link href={nextStep.href} className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow hover:bg-cyan-50">
                  Next: {nextStep.title} →
                </Link>
              ) : (
                <Link href="/admin/pkt" className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow hover:bg-cyan-50">
                  📝 Assign a knowledge test →
                </Link>
              )}
              <Link href="/admin" className="rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold ring-1 ring-white/20 hover:bg-white/20">
                🎧 Voice certification link
              </Link>
              <span className="self-center text-xs text-slate-300">Need help? Click ✨ Ask Desk AI (bottom right)</span>
            </div>
          </div>
          <div className="text-center">
            <div className="relative mx-auto h-24 w-24">
              <svg viewBox="0 0 36 36" className="h-24 w-24 -rotate-90">
                <circle cx="18" cy="18" r="15.9" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="3" />
                <circle cx="18" cy="18" r="15.9" fill="none" stroke="#67e8f9" strokeWidth="3" strokeDasharray={`${(doneCount / steps.length) * 100} 100`} strokeLinecap="round" />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-xl font-bold">
                {doneCount}/{steps.length}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-300">setup complete</p>
          </div>
        </div>
      </div>

      {doneCount < steps.length && !hideGuide ? (
        <Card
          title="Getting started"
          subtitle="Follow these steps once - after that everything runs from this page."
          actions={
            <button type="button" className="text-xs text-slate-400 hover:text-slate-600" onClick={() => { setHideGuide(true); try { window.localStorage.setItem("dd_hide_guide", "1"); } catch { /* ignore */ } }}>
              Hide
            </button>
          }
        >
          <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {steps.map((st, i) => (
              <li key={st.title} className={`rounded-xl border p-3 transition ${st.done ? "border-emerald-200 bg-emerald-50/60" : st === nextStep ? "border-indigo-300 bg-indigo-50 ring-2 ring-indigo-100" : "border-slate-200"}`}>
                <div className="flex items-center gap-2">
                  <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${st.done ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-600"}`}>{st.done ? "✓" : i + 1}</span>
                  <span className="text-sm font-semibold text-slate-900">{st.title}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">{st.text}</p>
                {!st.done ? (
                  <Link href={st.href} className="mt-2 inline-block text-xs font-semibold text-indigo-600 hover:underline">
                    {st.cta} →
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        </Card>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <select className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium" value={processId} onChange={(e) => setProcessId(e.target.value)}>
          <option value="">All processes</option>
          {processes.map((x) => (
            <option key={x.process_id} value={x.process_id}>
              {x.process_name}
            </option>
          ))}
        </select>
        <Button variant="secondary" className="ml-auto" onClick={load}>
          Refresh
        </Button>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Todo href="/admin/knowledge" count={p.docs_draft + p.docs_failed} label="Documents to approve / fix" />
        <Todo href="/admin/knowledge" count={p.kb_issues} label={`KB issues (${p.kb_issues_high} high)`} tone={p.kb_issues_high ? "red" : "amber"} />
        <Todo href="/admin/scenarios" count={p.scenarios_review} label={`Scenarios to review (${p.scenarios_flagged} flagged)`} />
        <Todo href="/admin/pkt" count={p.papers_review} label="PKT papers to approve" />
        <Todo href="/admin/pkt" count={p.pkt_ready + p.pkt_in_progress} label="PKTs ready / in progress" />
        <Todo href="/admin/analytics?tab=agents" count={o.agents_pending_recert} label="Agents eligible for retest" />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Kpi label="Agents" value={o.agents_total} hint={`${o.agents_certified} certified`} />
        <Kpi label="Voice pass rate" value={pct(o.pass_rate)} hint={`${o.completed} assessments`} />
        <Kpi label="PKT pass rate" value={pct(data.pkt.pass_rate)} hint={`${data.pkt.scored} tests · avg ${pct(data.pkt.avg_score)}`} />
        <Kpi label="Published scenarios" value={p.scenarios_approved} />
        <Kpi label="Approved documents" value={p.docs_approved} />
        <Kpi label="PKT integrity" value={`${data.pkt.integrity.violation || 0} / ${data.pkt.integrity.suspicious || 0}`} hint="violations / suspicious" tone={data.pkt.integrity.violation ? "text-rose-600" : "text-slate-900"} />
      </div>

      <Card title="Agents - assessments & certification" subtitle="Certification = all mandatory assessments passed (configured per process) without critical failures." padded={false} actions={<input className={`${inputClass} w-56 py-1 text-xs`} placeholder="Search agent…" value={q} onChange={(e) => setQ(e.target.value)} />}>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Agent</th>
                <th className="px-4 py-2">Process</th>
                <th className="px-4 py-2">Certification</th>
                <th className="px-4 py-2 text-center">Voice</th>
                <th className="px-4 py-2 text-center">PKT</th>
                <th className="px-4 py-2">Focus areas</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {agents.map((a) => (
                <tr key={a.key + a.process_id} className="align-top hover:bg-slate-50">
                  <td className="px-4 py-2.5">
                    <p className="font-semibold text-slate-800">{a.name}</p>
                    <p className="text-[11px] text-slate-500">{[a.email, a.employee_id].filter(Boolean).join(" · ") || "—"}</p>
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">{a.process_name}</td>
                  <td className="px-4 py-2.5">
                    <Pill tone={STATUS_TONE[a.status] || "slate"}>{a.status}</Pill>
                    {a.pkt_required ? <span className="block text-[10px] text-slate-400">voice + PKT required</span> : null}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    {a.latest_score !== null ? <span className={a.voice_certified ? "font-semibold text-emerald-600" : "font-semibold text-rose-600"}>{pct(a.latest_score)}</span> : <span className="text-slate-300">—</span>}
                    <span className="block text-[10px] text-slate-400">{a.attempts} attempt(s)</span>
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    {a.pkt_latest_score !== null && a.pkt_latest_score !== undefined ? <Link href={`/admin/pkt/attempt/${a.pkt_latest_id}`} className={a.pkt_passed ? "font-semibold text-emerald-600 hover:underline" : "font-semibold text-rose-600 hover:underline"}>{pct(a.pkt_latest_score)}</Link> : <span className="text-slate-300">—</span>}
                    <span className="block text-[10px] text-slate-400">{a.pkt_attempts || 0} test(s){a.pkt_open_id ? " · 1 open" : ""}</span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">
                    {(a.coaching?.areas?.length ? a.coaching.areas : a.focus_areas.map((f) => f.parameter)).slice(0, 3).map((x, i) => (
                      <span key={i} className="block">
                        • {x}
                      </span>
                    ))}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap justify-end gap-1">
                      {a.pkt_open_id ? (
                        <Button size="sm" variant="secondary" href={`/admin/pkt/attempt/${a.pkt_open_id}`}>
                          Open PKT
                        </Button>
                      ) : (
                        <Button size="sm" variant="secondary" onClick={() => assignPkt(a)} loading={busy === a.key + "pkt"} disabled={!a.agent_id}>
                          {a.pkt_attempts ? "PKT retest" : "Assign PKT"}
                        </Button>
                      )}
                      {!a.certified || !a.voice_certified ? (
                        <Button size="sm" variant="secondary" onClick={() => voiceLink(a)} loading={busy === a.key + "voice"}>
                          {a.attempts ? "Voice retest" : "Voice link"}
                        </Button>
                      ) : null}
                      {a.attempts || a.pkt_attempts ? (
                        <Button size="sm" variant={a.coaching ? "ghost" : "primary"} onClick={() => coaching(a)} loading={busy === a.key + "coach"}>
                          {a.coaching ? "Coaching plan" : "Create coaching"}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!agents.length ? <p className="px-5 py-6 text-sm text-slate-400">No agents yet - add them on the Agents page.</p> : null}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Recurring voice failures" subtitle="Parameters losing the most marks (Pareto vital few in red)">
          <BarList rows={data.voice_pareto.map((r) => ({ label: `${r.key} ${r.label}`, value: r.value, display: `${r.value} marks`, tone: r.vital ? "bg-rose-500" : "bg-slate-400", textTone: "text-slate-700" }))} max={Math.max(1, ...data.voice_pareto.map((r) => r.value))} empty="No voice results yet." />
        </Card>
        <Card title="Recurring knowledge gaps (PKT)" subtitle="Topics with the lowest correct-answer rate">
          <BarList rows={data.pkt.topic_gaps.slice(0, 8).map((t) => ({ label: t.topic, value: t.percentage, display: `${t.percentage}%`, sub: `${t.correct}/${t.questions} correct · ${t.agents_below} agent(s) below pass mark` }))} empty="No PKT results yet." />
        </Card>
        <Card title="Recurring portal / CRM failures" subtitle="From Gemini's screen-recording checks">
          <BarList rows={data.screen_pareto.map((r) => ({ label: r.label, value: r.value, display: `${r.value} fail(s)`, tone: "bg-rose-500", textTone: "text-slate-700" }))} max={Math.max(1, ...data.screen_pareto.map((r) => r.value))} empty="No screen checks yet." />
        </Card>
      </div>

      <Card title="Recent knowledge tests" padded={false}>
        <table className="min-w-full text-left text-sm">
          <tbody className="divide-y divide-slate-100">
            {data.recent_pkt.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="px-4 py-2">
                  <Link href={`/admin/pkt/attempt/${r.id}`} className="font-medium text-brand-700 hover:underline">
                    {r.agent}
                  </Link>
                  <span className="ml-2 text-xs text-slate-400">{r.title}</span>
                </td>
                <td className="px-4 py-2">
                  <Pill tone={ATTEMPT_TONE[r.status]}>{r.status.replace(/_/g, " ")}</Pill>
                </td>
                <td className="px-4 py-2">{r.percentage !== null ? <span className={r.passed ? "font-semibold text-emerald-600" : "font-semibold text-rose-600"}>{r.percentage}%</span> : "—"}</td>
                <td className="px-4 py-2">{r.integrity ? <Pill tone={INTEGRITY_TONE[r.integrity]}>{r.integrity}</Pill> : null}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{formatDateTime(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.recent_pkt.length ? <p className="px-5 py-6 text-sm text-slate-400">No knowledge tests yet.</p> : null}
      </Card>

      <Modal wide open={Boolean(planView)} title={planView ? `Coaching plan - ${planView.agent_name}` : ""} onClose={() => setPlanView(null)}>
        <div className="scroll-thin max-h-[65vh] overflow-y-auto pr-2">
          <CoachingPlanView plan={planView} />
        </div>
      </Modal>
    </div>
  );
}

export default function TrainerPage() {
  return (
    <AdminShell title="Home" subtitle="Your to-do list, every agent's status and one-click actions." wide>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <TrainerContent />
      </Suspense>
    </AdminShell>
  );
}
