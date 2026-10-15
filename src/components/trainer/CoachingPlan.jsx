"use client";

import { Refs } from "@/components/trainer/common";
import { formatDateTime } from "@/lib/format";

export default function CoachingPlanView({ plan }) {
  if (!plan) return null;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-700">{plan.summary}</p>
      {plan.priority_areas.map((p, i) => (
        <div key={i} className="rounded-xl border border-slate-200 p-4">
          <p className="font-semibold text-slate-900">
            {i + 1}. {p.area}
          </p>
          <p className="mt-1 text-sm text-slate-600">{p.why}</p>
          {p.evidence?.length ? (
            <ul className="mt-2 list-disc pl-5 text-xs text-slate-500">
              {p.evidence.map((e, k) => (
                <li key={k}>{e}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 text-xs font-semibold uppercase text-slate-500">Actions</p>
          <ul className="list-disc pl-5 text-sm text-slate-800">
            {p.actions.map((a, k) => (
              <li key={k}>{a}</li>
            ))}
          </ul>
          {p.practice_drill ? <p className="mt-2 text-sm text-brand-800">Drill: {p.practice_drill}</p> : null}
          <Refs refs={p.source_refs} />
        </div>
      ))}
      {plan.next_assessment ? (
        <p className="text-sm text-slate-700">
          <span className="font-semibold">Next assessment:</span> {plan.next_assessment.type} after {plan.next_assessment.recommended_after_days} day(s) · focus {plan.next_assessment.focus_topics?.join(", ") || "—"}
          {plan.next_assessment.scenario_categories?.length ? ` · scenarios: ${plan.next_assessment.scenario_categories.join(", ")}` : ""}
        </p>
      ) : null}
      <p className="text-[11px] text-slate-400">
        Plan {plan.id} · {formatDateTime(plan.created_at)} · {plan.trigger} · {plan.model}
      </p>
    </div>
  );
}

