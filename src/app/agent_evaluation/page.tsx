import { AppShell, Panel, StatusPill } from "@/components/dashboard";
import { mockEvaluations } from "@/lib/mock-data";

export default function AgentEvaluationPage() {
  return (
    <AppShell
      eyebrow="Agent Evaluation"
      title="Reliability dashboard"
      description="A deterministic evaluation surface for SKU grounding, commerce intent, and guardrail behavior."
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {mockEvaluations.map((evaluation) => {
          const passRate = Math.round((evaluation.passed / evaluation.total) * 100);

          return (
            <Panel title={evaluation.category} eyebrow="Category" key={evaluation.category}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <StatusPill tone={passRate >= 90 ? "good" : "warning"}>
                  {passRate}% pass rate
                </StatusPill>
                <p className="text-sm font-semibold text-slate-900">
                  {evaluation.passed}/{evaluation.total}
                </p>
              </div>
              <p className="mt-4 text-sm leading-6 text-slate-600">
                {evaluation.summary}
              </p>
            </Panel>
          );
        })}
      </div>
      <div className="mt-4">
        <Panel title="Evaluation Suite Placeholder" eyebrow="Prompt 1">
          <p className="text-sm leading-6 text-slate-600">
            The full deterministic suite and expandable case table will be added
            in the dedicated evaluation prompts. This page renders now so the
            scaffold has a stable route for later work.
          </p>
        </Panel>
      </div>
    </AppShell>
  );
}
