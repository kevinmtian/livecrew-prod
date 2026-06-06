import Link from "next/link";
import { ArrowRight, Eye, MonitorPlay, ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { MetricCard } from "@/components/MetricCard";
import { Panel } from "@/components/Panel";
import { liveSession } from "@/lib/mockData";

const destinations = [
  {
    href: "/host",
    label: "Host Console",
    description: "Manage run of show, products, and viewer questions.",
    icon: MonitorPlay,
  },
  {
    href: "/viewer",
    label: "Viewer Room",
    description: "Preview the shopping surface and live engagement stream.",
    icon: Eye,
  },
  {
    href: "/agent_evaluation",
    label: "Agent Evaluation",
    description: "Review mock agent outcomes before any AI integration.",
    icon: ShieldCheck,
  },
];

export default function Home() {
  return (
    <AppShell
      title="Operations Overview"
      subtitle="A local mock dashboard for the LiveCrew livestream commerce demo."
    >
      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard label="Session" value={liveSession.status} detail={liveSession.title} />
        <MetricCard label="Audience" value={liveSession.audience.toLocaleString()} detail="Current viewers" />
        <MetricCard label="Orders" value={String(liveSession.orders)} detail="Since stream start" />
        <MetricCard label="Revenue" value={liveSession.revenue} detail="Mock gross sales" />
      </div>

      <Panel title="Workspaces">
        <div className="grid gap-3 md:grid-cols-3">
          {destinations.map((destination) => {
            const Icon = destination.icon;

            return (
              <Link
                key={destination.href}
                href={destination.href}
                className="group rounded-md border border-line bg-panel p-4 transition hover:border-slate-400 hover:bg-white"
              >
                <div className="flex items-start justify-between gap-3">
                  <Icon className="h-5 w-5 text-slate-600" aria-hidden="true" />
                  <ArrowRight
                    className="h-4 w-4 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-ink"
                    aria-hidden="true"
                  />
                </div>
                <h2 className="mt-4 text-base font-semibold text-ink">
                  {destination.label}
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {destination.description}
                </p>
              </Link>
            );
          })}
        </div>
      </Panel>
    </AppShell>
  );
}
