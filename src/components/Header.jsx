"use client";

import { BrandLogo } from "@/components/Brand";

export default function Header({ subtitle = "", right = null }) {
  return (
    <header className="border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <BrandLogo subtitle={subtitle || "AI Agent Certification"} />
        {right}
      </div>
    </header>
  );
}
