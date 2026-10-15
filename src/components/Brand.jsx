import Link from "next/link";

/** DialDesk brand mark: headset + signal waves in a gradient tile. */
export function BrandMark({ size = 36 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <defs>
        <linearGradient id="dd-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#dd-g)" />
      <path d="M14 26v-3a10 10 0 0 1 20 0v3" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <rect x="11" y="25" width="6" height="9" rx="2.5" fill="#fff" />
      <rect x="31" y="25" width="6" height="9" rx="2.5" fill="#fff" />
      <path d="M34 34c0 3-3 5-7 5h-2" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="24" cy="39" r="2" fill="#fff" />
    </svg>
  );
}

export function BrandLogo({ subtitle = "AI Training & Certification", href = null, dark = false }) {
  const body = (
    <span className="flex items-center gap-3">
      <BrandMark />
      <span className="leading-tight">
        <span className={`block text-lg font-extrabold tracking-tight ${dark ? "text-white" : "text-slate-900"}`}>
          Dial<span className="bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">Desk</span>
        </span>
        {subtitle ? <span className={`block text-[11px] font-medium ${dark ? "text-slate-400" : "text-slate-500"}`}>{subtitle}</span> : null}
      </span>
    </span>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}
