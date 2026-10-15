"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";

/** Copy / email the agent's personal proctored test link (work-from-home). */
export default function ShareLink({ attempt, compact = false, onDone }) {
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const shareable = ["generating", "review", "ready", "in_progress", "failed_generation"].includes(attempt.status);
  if (!shareable) return null;

  const run = async (kind) => {
    setBusy(kind);
    setNote(null);
    try {
      const d = await api.pktAction(attempt.id, "share", { send_email: kind === "email", rotate: kind === "rotate" });
      setUrl(d.url);
      if (kind === "email") setNote(`Emailed to ${attempt.agent?.email} ✓`);
      else {
        try {
          await navigator.clipboard.writeText(d.url);
          setNote(kind === "rotate" ? "New link copied - the old link no longer works ✓" : "Link copied ✓");
        } catch {
          setNote("Copy the link below");
        }
      }
      onDone?.();
    } catch (err) {
      setNote(err.message);
    } finally {
      setBusy(null);
    }
  };

  if (compact) {
    return (
      <span className="inline-flex flex-col items-end gap-0.5">
        <span className="inline-flex gap-1">
          <Button size="sm" variant="secondary" onClick={() => run("copy")} loading={busy === "copy"} title="Copy the agent's personal test link">
            🔗 Copy link
          </Button>
          {attempt.agent?.email ? (
            <Button size="sm" variant="ghost" onClick={() => run("email")} loading={busy === "email"} title={`Email to ${attempt.agent.email}`}>
              ✉️
            </Button>
          ) : null}
        </span>
        {note ? <span className="max-w-[16rem] text-right text-[11px] text-slate-500">{note}</span> : null}
      </span>
    );
  }

  return (
    <div className="rounded-2xl border border-indigo-200 bg-gradient-to-r from-indigo-50 to-cyan-50 p-4">
      <p className="text-sm font-semibold text-slate-900">🏠 Work from home? Share the agent's personal test link</p>
      <p className="mt-0.5 text-xs text-slate-600">The agent opens it on their own laptop (Chrome/Edge + webcam). Camera, microphone and screen are recorded and live camera AI flags phone use, another person or looking away.{attempt.status === "review" ? " The test unlocks for the agent as soon as you approve the paper." : ""}</p>
      {url ? <input readOnly value={url} onFocus={(e) => e.target.select()} className="mt-3 w-full rounded-lg border border-indigo-200 bg-white px-3 py-2 font-mono text-xs" /> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => run("copy")} loading={busy === "copy"}>
          🔗 Copy link
        </Button>
        {attempt.agent?.email ? (
          <Button size="sm" variant="secondary" onClick={() => run("email")} loading={busy === "email"}>
            ✉️ Email to {attempt.agent.email}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => window.confirm("Create a new link? The previous link stops working immediately.") && run("rotate")} loading={busy === "rotate"}>
          ♻️ New link
        </Button>
        {note ? <span className="text-xs font-medium text-slate-600">{note}</span> : null}
      </div>
    </div>
  );
}
