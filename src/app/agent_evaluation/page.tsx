import { CheckCircle2, ClipboardCheck, TriangleAlert } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { MetricCard } from "@/components/MetricCard";
import { Panel } from "@/components/Panel";
import { StatusPill } from "@/components/StatusPill";
import { getActiveSkuDisplay } from "@/lib/catalogue";
import { agentEvaluations } from "@/lib/mockData";

export default function AgentEvaluationPage() {
  const activeSku = getActiveSkuDisplay();
  const averageScore = Math.round(
    agentEvaluations.reduce((total, item) => total + item.score, 0) /
      agentEvaluations.length,
  );
  const reviewCount = agentEvaluations.filter((item) => item.result === "Review").length;

  return (
    <AppShell
      active="agent"
      title="Agent Evaluation"
      subtitle="Local mock scorecards for assistant behavior, guardrails, and commerce workflow accuracy."
    >
      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard label="Average score" value={`${averageScore}%`} detail="Across mock checks" />
        <MetricCard label="Active SKU" value={activeSku.aliasLabel} detail={activeSku.name} />
        <MetricCard label="Needs review" value={String(reviewCount)} detail="Manual follow-up queue" />
      </div>

      <Panel title="Evaluation Runs">
        <div className="space-y-3">
          {agentEvaluations.map((evaluation) => {
            const passed = evaluation.result === "Pass";
            const Icon = passed ? CheckCircle2 : TriangleAlert;

            return (
              <article
                key={evaluation.id}
                className="grid gap-4 rounded-md border border-line bg-panel p-4 md:grid-cols-[1fr_120px_120px]"
              >
                <div className="flex items-start gap-3">
                  <Icon
                    className={`mt-0.5 h-5 w-5 shrink-0 ${
                      passed ? "text-emerald-700" : "text-amber-700"
                    }`}
                    aria-hidden="true"
                  />
                  <div>
                    <h2 className="text-sm font-semibold text-ink">
                      {evaluation.agent}
                    </h2>
                    <p className="mt-1 text-sm text-slate-600">
                      {evaluation.note}
                    </p>
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase text-slate-500">
                    Score
                  </p>
                  <p className="mt-1 text-lg font-semibold text-ink">
                    {evaluation.score}%
                  </p>
                </div>
                <div className="flex items-start justify-start md:justify-end">
                  <StatusPill tone={passed ? "good" : "warn"}>
                    {evaluation.result}
                  </StatusPill>
                </div>
              </article>
            );
          })}
        </div>
      </Panel>

      <Panel title="Mock Criteria">
        <div className="grid gap-3 md:grid-cols-3">
          {["Answer relevance", "Offer policy", activeSku.facts[0]].map((criterion) => (
            <div
              key={criterion}
              className="flex items-center gap-3 rounded-md border border-line bg-panel p-4"
            >
              <ClipboardCheck className="h-5 w-5 text-slate-600" aria-hidden="true" />
              <span className="text-sm font-medium text-ink">{criterion}</span>
            </div>
          ))}
        </div>
      </Panel>
    </AppShell>
  );
}
