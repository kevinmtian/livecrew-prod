type StatusPillProps = {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "warn" | "live";
};

const toneClass = {
  neutral: "border-slate-200 bg-slate-50 text-slate-700",
  good: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
  live: "border-rose-200 bg-rose-50 text-rose-800",
};

export function StatusPill({ children, tone = "neutral" }: StatusPillProps) {
  return (
    <span
      className={`inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-semibold ${toneClass[tone]}`}
    >
      {children}
    </span>
  );
}
