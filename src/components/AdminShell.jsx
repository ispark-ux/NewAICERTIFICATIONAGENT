"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { BrandLogo } from "@/components/Brand";
import Assistant from "@/components/Assistant";

const NAV = [
  { section: "Overview", items: [
    { href: "/admin/trainer", label: "Home", icon: "🏠", hint: "Your to-do list and every agent's status" },
    { href: "/admin/analytics", label: "Analytics", icon: "📊", hint: "Scores, Pareto, process & agent reports" },
  ] },
  { section: "Assessments", items: [
    { href: "/admin", label: "Voice certification", icon: "🎧", hint: "AI customer calls - create & share links" },
    { href: "/admin/pkt", label: "Knowledge tests (PKT)", icon: "📝", hint: "AI question papers with camera proctoring" },
  ] },
  { section: "Training content", items: [
    { href: "/admin/knowledge", label: "Knowledge base", icon: "📚", hint: "Upload & approve SOPs, FAQs, scripts" },
    { href: "/admin/scenarios", label: "Scenarios", icon: "🎭", hint: "AI-generated customer situations" },
    { href: "/admin/processes", label: "Processes", icon: "⚙️", hint: "Scorecard, AI prompt, rules" },
  ] },
  { section: "People", items: [{ href: "/admin/agents", label: "Agents", icon: "👥", hint: "Add agents and send links" }] },
  { section: "Settings", items: [
    { href: "/admin/ai-settings", label: "AI / Gemini key", icon: "🔑", hint: "Replace the Gemini key when the limit is reached" },
    { href: "/admin/settings", label: "Email", icon: "✉️", hint: "SMTP, recipients, CC" },
    { href: "/admin/audit", label: "Audit trail", icon: "🧾", hint: "Who did what, when" },
  ] },
];

function isActive(pathname, href) {
  if (href === "/admin") return pathname === "/admin" || pathname.startsWith("/admin/certification");
  return pathname === href || pathname.startsWith(`${href}/`);
}

function ActorBox() {
  const [name, setName] = useState("");
  useEffect(() => {
    try {
      setName(window.localStorage.getItem("aac_actor") || "");
    } catch {
      /* ignore */
    }
  }, []);
  return (
    <label className="block text-[11px] text-slate-400">
      Your name (shown in the audit trail)
      <input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          try {
            window.localStorage.setItem("aac_actor", e.target.value.slice(0, 80));
          } catch {
            /* ignore */
          }
        }}
        placeholder="e.g. Neha (Trainer)"
        className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none"
      />
    </label>
  );
}

function StatusDot({ ok, warn }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-emerald-400" : warn ? "bg-amber-400" : "bg-rose-400"} ${ok ? "" : "animate-pulse"}`} />;
}

export default function AdminShell({ title, subtitle, actions, children, wide = false }) {
  const pathname = usePathname() || "";
  const [health, setHealth] = useState(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ ok: false }));
    setMobileOpen(false);
  }, [pathname]);

  const current = NAV.flatMap((g) => g.items).find((i) => isActive(pathname, i.href));
  const problems = [];
  if (health && !health.gemini_configured) problems.push({ text: "Gemini API key missing - AI features are off.", href: "/admin/ai-settings", cta: "Add key" });
  if (health?.storage_warning) problems.push({ text: health.storage_warning, href: null });
  if (health && health.database_ok === false) problems.push({ text: `Database problem: ${health.database_error}`, href: null });

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="px-5 py-5">
        <BrandLogo href="/admin/trainer" dark />
      </div>
      <nav className="scroll-thin flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {NAV.map((g) => (
          <div key={g.section}>
            <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">{g.section}</p>
            <div className="space-y-0.5">
              {g.items.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <Link key={item.href} href={item.href} title={item.hint} className={`group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition ${active ? "bg-gradient-to-r from-indigo-500/30 to-cyan-500/10 text-white ring-1 ring-indigo-400/30" : "text-slate-300 hover:bg-white/5 hover:text-white"}`}>
                    <span className="text-base">{item.icon}</span>
                    <span className="flex-1">{item.label}</span>
                    {active ? <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" /> : null}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="space-y-3 border-t border-white/10 px-5 py-4">
        <ActorBox />
        {health ? (
          <ul className="space-y-1.5 text-xs text-slate-300">
            <li className="flex items-center gap-2">
              <StatusDot ok={health.database_ok !== false && health.storage_persistent !== false} /> Storage: <span className="font-semibold text-white">{health.database === "supabase" ? "Supabase" : "Local files"}</span>
            </li>
            <li className="flex items-center gap-2">
              <StatusDot ok={Boolean(health.gemini_configured)} />
              <Link href="/admin/ai-settings" className="hover:text-white">
                Gemini {health.gemini_configured ? `ready (${health.gemini_key_source === "panel" ? "panel key" : ".env key"})` : "key missing"}
              </Link>
            </li>
            <li className="flex items-center gap-2">
              <StatusDot ok={Boolean(health.email_configured)} warn />
              <Link href="/admin/settings" className="hover:text-white">
                Email {health.email_configured ? "on" : "not set up"}
              </Link>
            </li>
          </ul>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-100 lg:flex">
      <aside className="hidden w-72 shrink-0 bg-slate-950 lg:sticky lg:top-0 lg:block lg:h-screen">{sidebar}</aside>
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/60" onClick={() => setMobileOpen(false)} />
          <aside className="pop-in absolute left-0 top-0 h-full w-72 bg-slate-950">{sidebar}</aside>
        </div>
      ) : null}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 px-4 py-3 backdrop-blur sm:px-6">
          <div className={`mx-auto flex flex-wrap items-center gap-3 ${wide ? "" : "max-w-6xl"}`}>
            <button type="button" className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Menu">
              ☰
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-indigo-600">{current ? `${current.icon} ${current.label}` : "DialDesk"}</p>
              <h1 className="truncate text-xl font-bold text-slate-900">{title}</h1>
              {subtitle ? <p className="text-sm text-slate-500">{subtitle}</p> : null}
            </div>
            {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
          </div>
        </header>
        {problems.length ? (
          <div className="space-y-1 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900">
            {problems.map((p, i) => (
              <p key={i} className="flex flex-wrap items-center gap-2">
                ⚠️ {p.text}
                {p.href ? (
                  <Link href={p.href} className="rounded-md bg-amber-600 px-2 py-0.5 text-xs font-semibold text-white hover:bg-amber-700">
                    {p.cta}
                  </Link>
                ) : null}
              </p>
            ))}
          </div>
        ) : null}
        <main className={`page-in mx-auto px-4 py-6 sm:px-6 ${wide ? "" : "max-w-6xl"}`}>{children}</main>
      </div>
      <Assistant />
    </div>
  );
}
