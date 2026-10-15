"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";

export function useProcessPicker() {
  const params = useSearchParams();
  const [processes, setProcesses] = useState([]);
  const [processId, setProcessId] = useState(params.get("process") || "");
  useEffect(() => {
    api.listProcesses(true).then((d) => {
      const list = d.processes || [];
      setProcesses(list);
      setProcessId((cur) => cur || list[0]?.process_id || "");
    });
  }, []);
  return { processes, processId, setProcessId, process: processes.find((p) => p.process_id === processId) || null };
}

export function ProcessSelect({ processes, value, onChange }) {
  return (
    <select className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium" value={value} onChange={(e) => onChange(e.target.value)}>
      {processes.map((p) => (
        <option key={p.process_id} value={p.process_id}>
          {p.process_name}
        </option>
      ))}
    </select>
  );
}

export function Refs({ refs }) {
  if (!refs?.length) return null;
  return (
    <ul className="mt-1 space-y-1">
      {refs.map((r, i) => (
        <li key={i} className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
          <span className="font-semibold text-slate-700">
            {r.doc_title}
            {r.version ? ` v${r.version}` : ""} §{r.section ?? "?"}
          </span>{" "}
          {r.verified ? <span className="text-emerald-600">✓ verified</span> : <span className="text-amber-600">⚠ not found verbatim</span>}
          <span className="block italic">“{r.quote}”</span>
        </li>
      ))}
    </ul>
  );
}


export const pct = (v) => (v === null || v === undefined ? "—" : `${v}%`);

export function Pill({ children, tone = "slate" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-600",
    green: "bg-emerald-50 text-emerald-700",
    red: "bg-rose-50 text-rose-700",
    amber: "bg-amber-50 text-amber-700",
    blue: "bg-sky-50 text-sky-700",
    violet: "bg-violet-50 text-violet-700",
    dark: "bg-slate-900 text-white",
  };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${tones[tone] || tones.slate}`}>{children}</span>;
}

export const ATTEMPT_TONE = { generating: "violet", review: "amber", ready: "blue", in_progress: "violet", scored: "green", failed_generation: "red", cancelled: "slate", invalidated: "red" };
export const INTEGRITY_TONE = { clean: "green", suspicious: "amber", violation: "red", pending: "slate" };
