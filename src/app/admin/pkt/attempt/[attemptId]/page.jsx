"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import AdminShell from "@/components/AdminShell";
import { Alert, Button, Card, Spinner } from "@/components/ui";
import { Refs, Pill, pct, ATTEMPT_TONE, INTEGRITY_TONE } from "@/components/trainer/common";
import { BarList } from "@/components/analytics/Charts";
import { api } from "@/lib/api";
import { formatDateTime, formatBytes } from "@/lib/format";
import CoachingPlanView from "@/components/trainer/CoachingPlan";
import ShareLink from "@/components/pkt/ShareLink";

const TYPE_LABEL = { mcq: "MCQ", multi: "Multiple select", tf: "True/False", scenario: "Scenario" };

export default function AttemptDetailPage() {
  const { attemptId } = useParams();
  const [a, setA] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [plan, setPlan] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api.getPktAttempt(attemptId);
      setA(d.attempt);
      setError(null);
      if (d.attempt.status === "scored") {
        const c = await api.listCoaching({ process_id: d.attempt.process_id, agent_key: d.attempt.agent_key });
        setPlan((c.plans || []).find((p) => p.status === "active") || null);
      }
    } catch (err) {
      setError(err.message);
    }
  }, [attemptId]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!a) return undefined;
    const waiting = a.status === "generating" || (a.status === "scored" && a.blueprint?.proctoring?.ai_review !== false && !a.proctoring?.ai_review && !a.proctoring?.ai_review_error);
    if (!waiting) return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [a, load]);

  const act = async (action, payload = {}) => {
    setBusy(action);
    setError(null);
    try {
      if (action === "invalidate") {
        const reason = window.prompt("Reason for invalidating this test (recorded in the audit trail):");
        if (!reason) return;
        payload = { reason };
      }
      if (action === "remove-question" && !window.confirm(`Remove ${payload.question_id} from this paper?`)) return;
      const r = await api.pktAction(attemptId, action, payload);
      if (action === "retest" && r.attempt) {
        window.location.href = `/admin/pkt/attempt/${r.attempt.id}`;
        return;
      }
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const coaching = async () => {
    setBusy("coaching");
    setError(null);
    try {
      const d = await api.createCoaching({ process_id: a.process_id, agent_key: a.agent_key });
      setPlan(d.plan);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  if (!a) {
    return (
      <AdminShell title="Knowledge test">
        {error ? <Alert tone="error">{error}</Alert> : <Spinner />}
      </AdminShell>
    );
  }

  const res = a.result;
  const per = new Map((res?.per_question || []).map((p) => [p.id, p]));
  const pr = a.proctoring || {};
  const showKey = true;

  return (
    <AdminShell
      title={`${a.agent?.name} · ${a.blueprint?.title}`}
      subtitle={`${a.id} · attempt ${a.attempt_no} · ${a.mode === "online" ? "online" : "in person"} · created ${formatDateTime(a.created_at)} by ${a.created_by}`}
      wide
      actions={
        <>
          <Button variant="secondary" href="/admin/pkt">
            All tests
          </Button>
          {a.status === "review" ? (
            <>
              <Button variant="secondary" onClick={() => act("regenerate")} loading={busy === "regenerate"}>
                Regenerate paper
              </Button>
              <Button onClick={() => act("approve")} loading={busy === "approve"}>
                Approve paper
              </Button>
            </>
          ) : null}
          {["ready", "in_progress"].includes(a.status) ? <Button href={`/admin/pkt/take/${a.id}`}>{a.status === "in_progress" ? "Resume on this computer" : "Start on this computer"}</Button> : null}
          {a.status === "failed_generation" ? (
            <Button onClick={() => act("regenerate")} loading={busy === "regenerate"}>
              Retry generation
            </Button>
          ) : null}
          {["scored", "invalidated"].includes(a.status) ? (
            <Button variant="secondary" onClick={() => act("retest")} loading={busy === "retest"}>
              Retest (fresh paper)
            </Button>
          ) : null}
          {["scored", "in_progress"].includes(a.status) ? (
            <Button variant="ghost" className="text-rose-600" onClick={() => act("invalidate")}>
              Invalidate
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={ATTEMPT_TONE[a.status]}>{a.status.replace(/_/g, " ")}</Pill>
          {a.approved_by ? <span className="text-xs text-slate-500">Paper approved by {a.approved_by} {formatDateTime(a.approved_at)}</span> : null}
          {a.invalidation_reason ? <Pill tone="red">Invalidated: {a.invalidation_reason}</Pill> : null}
        </div>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <ShareLink attempt={a} />
        {a.status === "generating" ? (
          <Alert tone="info" title="Generating a fresh question paper">
            Gemini is writing {a.blueprint.question_count} new questions from the approved SOPs and excluding questions this agent has seen before (30-120 s). This page refreshes automatically.
          </Alert>
        ) : null}
        {a.error ? <Alert tone="error" title="Generation failed">{a.error}</Alert> : null}

        {res ? (
          <div className="grid gap-6 lg:grid-cols-3">
            <Card>
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Score</p>
              <p className={`text-5xl font-extrabold ${res.passed ? "text-emerald-600" : "text-rose-600"}`}>{res.percentage}%</p>
              <p className="text-sm text-slate-700">
                {res.passed ? "PASSED" : "NOT PASSED"} · {res.score}/{res.max} marks · {res.correct}/{res.total} correct · pass {res.passing_score}%
              </p>
              <p className="mt-2 text-xs text-slate-500">
                Started {formatDateTime(a.started_at)} · submitted {formatDateTime(a.submitted_at)} ({a.submit_reason?.replace(/_/g, " ")}) · {res.answered}/{res.total} answered
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Pill tone={INTEGRITY_TONE[pr.integrity?.status || "pending"]}>Integrity: {pr.integrity?.status || "pending"}</Pill>
                {pr.violations ? <Pill tone="amber">{pr.violations} violation(s)</Pill> : null}
              </div>
              {pr.integrity?.reasons?.length ? <p className="mt-2 text-xs text-slate-600">{pr.integrity.reasons.join(" · ")}</p> : null}
            </Card>
            <Card title="Topic-wise performance" className="lg:col-span-2">
              <BarList passing={res.passing_score} rows={res.by_topic.map((t) => ({ label: t.topic, value: t.percentage, display: `${t.percentage}% (${t.correct}/${t.total})` }))} />
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase text-slate-500">By type</p>
                  {res.by_type.map((t) => (
                    <p key={t.type} className="text-xs text-slate-700">
                      {TYPE_LABEL[t.type] || t.type}: {t.percentage}% ({t.correct}/{t.total})
                    </p>
                  ))}
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase text-slate-500">By difficulty</p>
                  {res.by_difficulty.map((t) => (
                    <p key={t.difficulty} className="text-xs text-slate-700">
                      {t.difficulty}: {t.percentage}% ({t.correct}/{t.total})
                    </p>
                  ))}
                </div>
              </div>
              {res.gaps?.length ? (
                <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3">
                  <p className="text-sm font-semibold text-rose-800">Knowledge gaps (below {res.passing_score}%)</p>
                  <p className="text-sm text-rose-900">{res.gaps.map((g) => `${g.topic} (${g.percentage}%, ${g.missed} missed)`).join(" · ")}</p>
                </div>
              ) : null}
            </Card>
          </div>
        ) : null}

        {res ? (
          <Card
            title="Coaching plan"
            subtitle="Targeted recommendations from this test (and the latest voice assessment), citing the SOP sections to revise."
            actions={
              <Button size="sm" onClick={coaching} loading={busy === "coaching"}>
                {plan ? "Regenerate plan" : "Generate coaching plan"}
              </Button>
            }
          >
            {plan ? <CoachingPlanView plan={plan} /> : <p className="text-sm text-slate-500">{res.passed ? "Agent passed - a plan is optional." : "A plan is created automatically for failed tests; it appears here shortly."}</p>}
          </Card>
        ) : null}

        {a.generation ? (
          <Card title="Paper generation" subtitle={`${a.generation.model} · ${formatDateTime(a.generation.at)} · from ${a.generation.kb_documents?.map((d) => `${d.title} v${d.version}`).join(", ")}`}>
            <p className="text-sm text-slate-700">
              {a.questions.length} questions in paper · {a.generation.generated} generated · {a.generation.duplicates_removed} repeats removed · {a.generation.invalid_removed} invalid removed · {a.generation.avoided_previous} previous questions avoided ({a.generation.agent_previous_questions} seen by this agent)
            </p>
            {a.generation.warnings?.length ? <Alert tone="warning" className="mt-3">{a.generation.warnings.join(" ")}</Alert> : null}
            {a.generation.flagged_ambiguous?.length ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-semibold text-amber-700">{a.generation.flagged_ambiguous.length} question(s) excluded because the documents are ambiguous</summary>
                <ul className="mt-2 space-y-2">
                  {a.generation.flagged_ambiguous.map((f, i) => (
                    <li key={i} className="rounded border border-amber-200 bg-amber-50 p-2 text-xs">
                      <p className="font-medium text-slate-800">{f.stem}</p>
                      <p className="text-amber-800">{f.note}</p>
                      <Refs refs={f.source_refs} />
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {a.generation.kb_issues?.length ? <p className="mt-2 text-xs text-slate-600">Knowledge-base issues noticed: {a.generation.kb_issues.join(" | ")}</p> : null}
          </Card>
        ) : null}

        {a.questions?.length ? (
          <Card title={a.status === "review" ? "Review the paper (answer key visible to trainers only)" : "Questions & answers"} padded={false}>
            <ol className="divide-y divide-slate-100">
              {a.questions.map((q) => {
                const p = per.get(q.id);
                return (
                  <li key={q.id} className="px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="font-mono font-semibold text-slate-700">{q.id}</span>
                      <Pill tone="violet">{TYPE_LABEL[q.type]}</Pill>
                      <Pill>{q.topic}</Pill>
                      <Pill tone={q.difficulty === "hard" ? "red" : q.difficulty === "easy" ? "green" : "blue"}>{q.difficulty}</Pill>
                      <span>{q.marks} mark(s)</span>
                      {q.unverified_source ? <Pill tone="amber">citation not verified</Pill> : null}
                      {p ? <span className={`ml-auto font-semibold ${p.correct ? "text-emerald-600" : "text-rose-600"}`}>{p.correct ? `✓ ${p.marks}/${p.max}` : p.answered ? `✕ 0/${p.max}` : `— not answered`}</span> : null}
                      {a.status === "review" ? (
                        <Button size="sm" variant="ghost" className="ml-auto text-rose-600" onClick={() => act("remove-question", { question_id: q.id })}>
                          Remove
                        </Button>
                      ) : null}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap font-medium text-slate-900">{q.stem}</p>
                    <ul className="mt-2 space-y-1">
                      {q.options.map((o) => {
                        const correct = q.correct.includes(o.id);
                        const chosen = p?.given?.includes(o.id);
                        return (
                          <li key={o.id} className={`rounded-lg border px-3 py-1.5 text-sm ${showKey && correct ? "border-emerald-300 bg-emerald-50" : chosen ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}>
                            <span className="mr-2 font-mono text-xs font-bold">{o.id}</span>
                            {o.text}
                            {showKey && correct ? <span className="ml-2 text-xs font-semibold text-emerald-700">correct</span> : null}
                            {chosen ? <span className="ml-2 text-xs font-semibold text-slate-600">← agent's answer</span> : null}
                          </li>
                        );
                      })}
                    </ul>
                    {q.explanation ? <p className="mt-2 text-xs text-slate-600">💡 {q.explanation}</p> : null}
                    <Refs refs={q.source_refs} />
                  </li>
                );
              })}
            </ol>
          </Card>
        ) : null}

        {a.status === "scored" || a.status === "invalidated" ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="AI proctoring review" subtitle="Gemini reviewed the camera and screen recordings for cheating.">
              {pr.ai_review ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Pill tone={INTEGRITY_TONE[pr.ai_review.verdict]}>{pr.ai_review.verdict}</Pill>
                    <span className="text-sm font-semibold text-slate-800">Integrity {pr.ai_review.integrity_score}/100</span>
                  </div>
                  <p className="text-sm text-slate-700">{pr.ai_review.summary}</p>
                  <ul className="space-y-1">
                    {pr.ai_review.flags.map((f, i) => (
                      <li key={i} className="text-xs text-slate-700">
                        <span className={`mr-1 rounded px-1 font-bold uppercase text-white ${f.severity === "high" ? "bg-rose-600" : f.severity === "medium" ? "bg-amber-500" : "bg-slate-400"}`}>{f.severity}</span>
                        <span className="font-mono text-slate-400">{f.source} {f.timestamp}</span> {f.type.replace(/_/g, " ")} - {f.description}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : pr.ai_review_error ? (
                <p className="text-sm text-rose-600">{pr.ai_review_error}</p>
              ) : a.blueprint?.proctoring?.ai_review === false ? (
                <p className="text-sm text-slate-500">AI review disabled for this test.</p>
              ) : (
                <p className="flex items-center gap-2 text-sm text-slate-500">
                  <Spinner className="h-4 w-4" /> Waiting for recordings / review…
                </p>
              )}
              {a.status === "scored" ? (
                <Button size="sm" variant="ghost" className="mt-3" onClick={() => act("proctoring-review")} loading={busy === "proctoring-review"}>
                  Re-run AI review
                </Button>
              ) : null}
            </Card>
            <Card title={`Proctoring events (${(pr.events || []).length})`}>
              <ol className="scroll-thin max-h-72 space-y-1 overflow-y-auto text-xs">
                {(pr.events || []).map((e, i) => (
                  <li key={i} className={["face_not_visible", "multiple_faces", "looking_away", "looking_down", "phone_detected"].includes(e.type) ? "font-semibold text-violet-700" : ["tab_hidden", "window_blur", "fullscreen_exit", "copy_attempt", "paste_attempt", "devtools_key", "print_screen", "context_menu", "camera_stopped", "screen_stopped", "max_violations"].includes(e.type) ? "text-rose-700" : "text-slate-600"}>
                    {["face_not_visible", "multiple_faces", "looking_away", "looking_down", "phone_detected"].includes(e.type) ? "📷 " : ""}
                    <span className="font-mono text-slate-400">{new Date(e.t).toLocaleTimeString()}</span> {e.type.replace(/_/g, " ")} {e.detail ? `- ${e.detail}` : ""}
                  </li>
                ))}
              </ol>
            </Card>
            {["camera", "screen"].map((k) =>
              pr[k] ? (
                <Card key={k} title={`${k === "camera" ? "Camera" : "Screen"} recording`} subtitle={`${formatBytes(pr[k].size_bytes)} · ${pr[k].duration_seconds || "?"} s`}>
                  <video controls preload="metadata" className="aspect-video w-full rounded-lg bg-black" src={api.pktRecordingUrl(a.id, k)} />
                </Card>
              ) : null
            )}
          </div>
        ) : null}
      </div>
    </AdminShell>
  );
}
