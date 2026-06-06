import Link from "next/link";
import type { ReactNode } from "react";

type ShellProps = {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  contentMaxWidthClass?: string;
};

type PanelProps = {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
};

const navItems = [
  { href: "/", label: "Home" },
  { href: "/host", label: "Host" },
  { href: "/viewer", label: "Viewer" },
  { href: "/monitor", label: "Monitor" },
  { href: "/agent_evaluation", label: "Agent Evaluation" },
];

export function AppShell({
  eyebrow,
  title,
  description,
  children,
  contentMaxWidthClass = "max-w-7xl",
}: ShellProps) {
  return (
    <main className="min-h-screen bg-[#f7f8fa] text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-5 py-5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">
              {eyebrow}
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-950 md:text-3xl">
              {title}
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              {description}
            </p>
          </div>
          <nav className="flex flex-wrap gap-2 text-sm">
            {navItems.map((item) => (
              <Link
                className="rounded-md border border-slate-200 bg-white px-3 py-2 font-medium text-slate-700 shadow-sm transition hover:border-teal-300 hover:text-teal-800"
                href={item.href}
                key={item.href}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <section className={`mx-auto w-full ${contentMaxWidthClass} px-5 py-6`}>
        {children}
      </section>
    </main>
  );
}

export function Panel({
  title,
  children,
  className = "",
  contentClassName = "",
}: PanelProps) {
  return (
    <section
      className={`rounded-lg border border-slate-200 bg-white p-4 shadow-sm ${className}`}
    >
      <h2 className="text-base font-semibold text-slate-950">{title}</h2>
      <div className={`mt-4 ${contentClassName}`}>{children}</div>
    </section>
  );
}

export function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warning";
}) {
  const toneClass = {
    neutral: "border-slate-200 bg-slate-50 text-slate-700",
    good: "border-emerald-200 bg-emerald-50 text-emerald-700",
    warning: "border-amber-200 bg-amber-50 text-amber-700",
  }[tone];

  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium ${toneClass}`}
    >
      {children}
    </span>
  );
}
