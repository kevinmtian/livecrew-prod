import Link from "next/link";
import { BarChart3, Eye, Home, MonitorPlay, ShieldCheck } from "lucide-react";
import type { RouteKey } from "@/lib/mockData";

type AppShellProps = {
  active?: RouteKey;
  title: string;
  subtitle: string;
  children: React.ReactNode;
};

const navItems = [
  { href: "/", label: "Home", icon: Home },
  { href: "/host", label: "Host", icon: MonitorPlay, key: "host" },
  { href: "/viewer", label: "Viewer", icon: Eye, key: "viewer" },
  {
    href: "/agent_evaluation",
    label: "Agent Eval",
    icon: ShieldCheck,
    key: "agent",
  },
] as const;

export function AppShell({ active, title, subtitle, children }: AppShellProps) {
  return (
    <main className="min-h-screen px-4 py-5 text-ink sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <header className="flex flex-col gap-4 border-b border-line pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <Link
              href="/"
              className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-slate-600"
            >
              <BarChart3 className="h-4 w-4" aria-hidden="true" />
              LiveCrew
            </Link>
            <h1 className="text-2xl font-semibold tracking-normal text-ink">
              {title}
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">{subtitle}</p>
          </div>
          <nav className="flex flex-wrap gap-2" aria-label="Primary">
            {navItems.map((item) => {
              const Icon = item.icon;
              const selected = "key" in item && item.key === active;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-medium transition ${
                    selected
                      ? "border-ink bg-ink text-white"
                      : "border-line bg-white text-slate-700 hover:border-slate-400"
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </header>
        {children}
      </div>
    </main>
  );
}
