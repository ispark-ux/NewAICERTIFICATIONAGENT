"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { Alert, Button, Card, inputClass } from "@/components/ui";
import { Pill } from "@/components/trainer/common";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const AREA_TONE = { kb: "blue", scenario: "violet", pkt: "amber", voice: "green", certification: "red", coaching: "slate" };

export default function AuditPage() {
  const [processes, setProcesses] = useState([]);
  const [processId, setProcessId] = useState("");
  const [entries, setEntries] = useState([]);
  const [area, setArea] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api.listAudit({ process_id: processId, limit: 1000 });
      setEntries(d.entries || []);
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

  const visible = useMemo(() => entries.filter((e) => (area === "all" || e.action.startsWith(area + ".")) && (!q || `${e.summary} ${e.actor} ${e.entity_id} ${e.action}`.toLowerCase().includes(q.toLowerCase()))), [entries, area, q]);

  const exportCsv = () => {
    const rows = [["time", "action", "actor", "process", "agent", "entity", "summary"], ...visible.map((e) => [e.created_at, e.action, e.actor, e.process_id || "", e.agent_key || "", `${e.entity_type || ""}:${e.entity_id || ""}`, e.summary])];
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "audit-trail.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <AdminShell title="Audit trail" subtitle="Every document version, generated scenario / question paper and answer key, evaluation result and certification decision." wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <select className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={processId} onChange={(e) => setProcessId(e.target.value)}>
            <option value="">All processes</option>
            {processes.map((p) => (
              <option key={p.process_id} value={p.process_id}>
                {p.process_name}
              </option>
            ))}
          </select>
          <select className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="all">All events</option>
            <option value="kb">Knowledge base</option>
            <option value="scenario">Scenarios</option>
            <option value="pkt">Knowledge tests</option>
            <option value="voice">Voice assessments</option>
            <option value="certification">Certification decisions</option>
            <option value="coaching">Coaching</option>
          </select>
          <input className={`${inputClass} max-w-xs`} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button variant="secondary" className="ml-auto" onClick={exportCsv} disabled={!visible.length}>
            Export CSV
          </Button>
          <Button variant="secondary" onClick={load}>
            Refresh
          </Button>
        </div>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Card padded={false}>
          <ul className="divide-y divide-slate-100">
            {visible.map((e) => (
              <li key={e.id} className="px-5 py-2.5">
                <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <span className="w-36 font-mono text-[11px] text-slate-400">{formatDateTime(e.created_at)}</span>
                  <Pill tone={AREA_TONE[e.action.split(".")[0]] || "slate"}>{e.action}</Pill>
                  <span className="flex-1 text-sm text-slate-800">{e.summary}</span>
                  <span className="text-xs text-slate-500">{e.actor}</span>
                </button>
                {open === e.id ? (
                  <pre className="scroll-thin mt-2 max-h-80 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] text-slate-100">{JSON.stringify({ id: e.id, entity_type: e.entity_type, entity_id: e.entity_id, process_id: e.process_id, agent_key: e.agent_key, details: e.details }, null, 2)}</pre>
                ) : null}
              </li>
            ))}
          </ul>
          {!visible.length ? <p className="px-5 py-6 text-sm text-slate-400">No audit entries.</p> : null}
        </Card>
      </div>
    </AdminShell>
  );
}
