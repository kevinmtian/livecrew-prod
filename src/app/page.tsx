import Link from "next/link";
import { AppShell, Panel, StatusPill } from "@/components/dashboard";

const routes = [
  {
    href: "/host",
    title: "Host Cockpit",
    description: "Operate the stream, review agent suggestions, and watch ledger events.",
  },
  {
    href: "/viewer",
    title: "Viewer Room",
    description: "Preview the customer livestream experience with chat and product context.",
  },
  {
    href: "/monitor",
    title: "Monitor Agent",
    description: "Detect livestream metric scenarios and generate host hooks.",
  },
  {
    href: "/agent_evaluation",
    title: "Agent Evaluation",
    description: "Inspect deterministic reliability checks for grounding and guardrails.",
  },
];

export default function Home() {
  return (
    <AppShell
      eyebrow="LiveCrew"
      title="Livestream commerce operations demo"
      description="A quiet operator dashboard for rehearsing the LiveCrew hackathon flow with local mock data only."
    >
      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Panel title="Demo Surfaces" eyebrow="Navigation">
          <div className="grid gap-3 md:grid-cols-3">
            {routes.map((route) => (
              <Link
                className="rounded-lg border border-slate-200 bg-slate-50 p-4 transition hover:border-teal-300 hover:bg-white"
                href={route.href}
                key={route.href}
              >
                <h2 className="text-sm font-semibold text-slate-950">
                  {route.title}
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {route.description}
                </p>
              </Link>
            ))}
          </div>
        </Panel>
        <Panel title="Scaffold Status" eyebrow="Prompt 1">
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="good">App Router</StatusPill>
            <StatusPill tone="good">TypeScript</StatusPill>
            <StatusPill tone="good">Tailwind CSS</StatusPill>
            <StatusPill>Local mock data</StatusPill>
            <StatusPill tone="warning">OpenAI not integrated</StatusPill>
          </div>
          <p className="mt-4 text-sm leading-6 text-slate-600">
            This first scaffold keeps the UI deterministic and ready for the
            later catalogue, messaging, backend, and evaluation steps.
          </p>
        </Panel>
      </div>
    </AppShell>
  );
}
