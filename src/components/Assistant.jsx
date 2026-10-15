"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { QUICK_QUESTIONS } from "@/lib/assistant-guide";

/** Minimal safe Markdown: **bold**, [label](/internal-path), numbered / bullet lines. */
function Inline({ text }) {
  const parts = [];
  const re = /\[([^\]]+)\]\((\/[^)\s]*)\)|\*\*([^*]+)\*\*|_([^_]+)_/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) parts.push(<Link key={m.index} href={m[2]} className="font-semibold text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-800">{m[1]}</Link>);
    else if (m[3]) parts.push(<strong key={m.index} className="font-semibold text-slate-900">{m[3]}</strong>);
    else if (m[4]) parts.push(<em key={m.index} className="text-slate-500">{m[4]}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.map((p, i) => <Fragment key={i}>{p}</Fragment>);
}

function Markdown({ text }) {
  const lines = String(text || "").split("\n");
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        const num = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
        const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
        if (num)
          return (
            <div key={i} className="flex gap-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-bold text-indigo-700">{num[1]}</span>
              <span><Inline text={num[2]} /></span>
            </div>
          );
        if (bullet)
          return (
            <div key={i} className="flex gap-2 pl-1">
              <span className="text-indigo-400">•</span>
              <span><Inline text={bullet[1]} /></span>
            </div>
          );
        if (!line.trim()) return <div key={i} className="h-1" />;
        return <p key={i}><Inline text={line.replace(/^#+\s*/, "")} /></p>;
      })}
    </div>
  );
}

const WELCOME = { role: "assistant", text: "Namaste! 👋 I'm **Desk AI**. Ask me anything in Hindi, Hinglish or English - for example “PKT ka link kaise bheju?” - and I'll guide you step by step." };

export default function Assistant() {
  const pathname = usePathname() || "/admin";
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([WELCOME]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem("dd_assistant") || "null");
      if (Array.isArray(saved) && saved.length) setMessages(saved);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem("dd_assistant", JSON.stringify(messages.slice(-30)));
    } catch {
      /* ignore */
    }
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, open]);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ask = async (text) => {
    const q = String(text || input).trim();
    if (!q || busy) return;
    const next = [...messages, { role: "user", text: q }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const d = await api.askAssistant({ messages: next.filter((m) => m !== WELCOME).slice(-12), path: pathname });
      setMessages((m) => [...m, { role: "assistant", text: d.answer, offline: d.offline }]);
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", text: `Sorry, I could not answer right now (${err.message}).` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-gradient-to-r from-indigo-600 to-cyan-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:scale-105" title="Ask Desk AI (Ctrl+K)">
          <span className="text-lg">✨</span> Ask Desk AI
        </button>
      ) : null}
      {open ? (
        <div className="pop-in fixed bottom-5 right-5 z-50 flex h-[min(640px,calc(100vh-40px))] w-[min(420px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200">
          <div className="flex items-center gap-3 bg-gradient-to-r from-indigo-600 to-cyan-500 px-4 py-3 text-white">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-lg">✨</span>
            <div className="flex-1">
              <p className="text-sm font-bold">Desk AI assistant</p>
              <p className="text-[11px] text-indigo-100">Ask in simple words · Ctrl+K</p>
            </div>
            <button type="button" className="rounded-lg px-2 py-1 text-xs text-white/80 hover:bg-white/10" onClick={() => setMessages([WELCOME])} title="New chat">
              New
            </button>
            <button type="button" className="rounded-lg px-2 py-1 text-lg leading-none hover:bg-white/10" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </div>
          <div className="scroll-thin flex-1 space-y-3 overflow-y-auto bg-slate-50 p-4">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${m.role === "user" ? "rounded-br-sm bg-indigo-600 text-white" : "rounded-bl-sm bg-white text-slate-700 shadow-sm ring-1 ring-slate-200"}`}>
                  {m.role === "user" ? m.text : <Markdown text={m.text} />}
                </div>
              </div>
            ))}
            {busy ? (
              <div className="typing flex w-16 gap-1 rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-slate-200">
                <span className="h-2 w-2 rounded-full bg-indigo-400" />
                <span className="h-2 w-2 rounded-full bg-indigo-400" />
                <span className="h-2 w-2 rounded-full bg-indigo-400" />
              </div>
            ) : null}
            {messages.length <= 1 ? (
              <div className="flex flex-wrap gap-2 pt-1">
                {QUICK_QUESTIONS.map((q) => (
                  <button key={q} type="button" onClick={() => ask(q)} className="rounded-full border border-indigo-200 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 transition hover:bg-indigo-50">
                    {q}
                  </button>
                ))}
              </div>
            ) : null}
            <div ref={endRef} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask();
            }}
            className="flex gap-2 border-t border-slate-200 bg-white p-3"
          >
            <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type your question…" className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200" />
            <button type="submit" disabled={busy || !input.trim()} className="rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white disabled:opacity-40">
              Send
            </button>
          </form>
        </div>
      ) : null}
    </>
  );
}
