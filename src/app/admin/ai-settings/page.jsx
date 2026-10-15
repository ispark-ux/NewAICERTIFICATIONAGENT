"use client";

import { useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { Alert, Button, Card, Field, Spinner, inputClass } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const MODEL_FIELDS = [
  { key: "live_model", label: "Live voice model (AI customer)", hint: "Real-time audio model used in voice certifications." },
  { key: "evaluation_model", label: "Evaluation model", hint: "Scores calls against the scorecard." },
  { key: "generation_model", label: "Generation model", hint: "Scenarios, PKT papers, coaching, assistant (defaults to the evaluation model)." },
  { key: "screen_analysis_model", label: "Video analysis model", hint: "Watches screen / camera recordings (gemini-2.5-pro reads small text better)." },
];

export default function AiSettingsPage() {
  const [info, setInfo] = useState(null);
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [models, setModels] = useState({});
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    const d = await api.aiSettings();
    setInfo(d);
    setModels(d.model_overrides || {});
  };
  useEffect(() => {
    load().catch((err) => setMsg({ tone: "error", text: err.message }));
  }, []);

  const save = async (e) => {
    e?.preventDefault();
    setBusy("save");
    setMsg(null);
    try {
      const d = await api.saveAiSettings({ api_key: key || undefined, models });
      setInfo(d);
      setModels(d.model_overrides || {});
      setKey("");
      setShow(false);
      setMsg({ tone: d.warnings?.length ? "warning" : "success", text: `${key ? "New key verified with Gemini and saved securely (encrypted). " : "Settings saved. "}${d.warnings?.length ? d.warnings.join(" ") : "AI features use it within a few seconds."}` });
    } catch (err) {
      setMsg({ tone: "error", text: err.message });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm("Remove the key saved in the panel? The platform will fall back to GEMINI_API_KEY from the server .env (if set).")) return;
    setBusy("remove");
    try {
      setInfo(await api.removeAiKey());
      setMsg({ tone: "success", text: "Panel key removed." });
    } catch (err) {
      setMsg({ tone: "error", text: err.message });
    } finally {
      setBusy(null);
    }
  };

  const sourceText = { panel: "Key saved in this panel", env: "Key from server .env (GEMINI_API_KEY)", none: "No key configured" };

  return (
    <AdminShell title="AI / Gemini key" subtitle="Replace the Gemini API key any time - e.g. when the free limit is reached. The key is stored encrypted and is never shown again.">
      <div className="space-y-6">
        {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
        {!info ? (
          <p className="flex items-center gap-2 text-slate-500">
            <Spinner /> Loading…
          </p>
        ) : (
          <>
            <div className={`flex flex-wrap items-center gap-4 rounded-2xl p-5 text-white shadow-lg ${info.configured ? "bg-gradient-to-r from-emerald-600 to-teal-500" : "bg-gradient-to-r from-rose-600 to-orange-500"}`}>
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/20 text-2xl">{info.configured ? "✓" : "!"}</span>
              <div className="flex-1">
                <p className="text-lg font-bold">{info.configured ? "Gemini is connected" : "Gemini is not connected"}</p>
                <p className="text-sm text-white/85">
                  {sourceText[info.source]}
                  {info.key_hint ? ` · ${info.key_hint}` : ""}
                  {info.updated_at && info.source === "panel" ? ` · updated ${formatDateTime(info.updated_at)} by ${info.updated_by}` : ""}
                </p>
              </div>
              {info.source === "panel" ? (
                <Button variant="secondary" onClick={remove} loading={busy === "remove"}>
                  Remove panel key
                </Button>
              ) : null}
            </div>

            <Card title={info.source === "panel" ? "Replace API key" : "Add API key"} subtitle="Paste a key from Google AI Studio. It is tested with Gemini before saving.">
              <form onSubmit={save} className="space-y-4" autoComplete="off">
                <Field label="Gemini API key">
                  <div className="flex gap-2">
                    <input
                      type={show ? "text" : "password"}
                      value={key}
                      onChange={(e) => setKey(e.target.value.trim())}
                      placeholder={info.key_hint ? `Current: ${info.key_hint} - paste a new key to replace` : "AIza…"}
                      className={`${inputClass} font-mono`}
                      autoComplete="new-password"
                      spellCheck={false}
                      name="dd-gemini-key"
                    />
                    <Button type="button" variant="secondary" onClick={() => setShow((v) => !v)} disabled={!key}>
                      {show ? "Hide" : "Show"}
                    </Button>
                  </div>
                </Field>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
                  <li>
                    Open{" "}
                    <a className="font-semibold text-indigo-600 underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                      aistudio.google.com/apikey
                    </a>{" "}
                    and click <strong>Create API key</strong> (use another Google account/project if the current one hit its limit).
                  </li>
                  <li>Paste it above and click <strong>Test &amp; save</strong>.</li>
                  <li>Done - voice calls, evaluations, scenarios, PKTs and the assistant switch to the new key automatically.</li>
                </ol>
                <details className="rounded-xl border border-slate-200 p-4">
                  <summary className="cursor-pointer text-sm font-semibold text-slate-700">Advanced: models</summary>
                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    {MODEL_FIELDS.map((f) => (
                      <Field key={f.key} label={f.label} hint={`${f.hint} Leave blank for default: ${info.models?.[f.key] || ""}`}>
                        <input className={`${inputClass} font-mono text-xs`} value={models[f.key] || ""} onChange={(e) => setModels({ ...models, [f.key]: e.target.value.trim() })} placeholder={info.models?.[f.key]} />
                      </Field>
                    ))}
                  </div>
                </details>
                <Button type="submit" size="lg" loading={busy === "save"}>
                  {key ? "Test & save key" : "Save settings"}
                </Button>
              </form>
            </Card>

            <Card title="How the key is protected">
              <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
                <li>Stored encrypted (AES-256-GCM) in the database - never in the browser, never in page source.</li>
                <li>The panel only ever receives a masked hint (first and last 4 characters).</li>
                <li>Voice calls use short-lived single-use tokens, so agents never see the key either.</li>
                <li>Every key change is recorded in the audit trail.</li>
              </ul>
            </Card>
          </>
        )}
      </div>
    </AdminShell>
  );
}
