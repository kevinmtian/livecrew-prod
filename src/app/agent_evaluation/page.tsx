"use client";

import { useEffect, useMemo, useState } from "react";

import { AppShell, Panel } from "@/components/dashboard";
import type {
  AgentEvalCategory,
  AgentEvalResult,
  AgentEvalSuiteResponse,
} from "@/lib/agent-eval-runner";

function passRateTone(passRate: number) {
  if (passRate >= 95) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }

  if (passRate >= 80) {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }

  return "border-rose-200 bg-rose-50 text-rose-800";
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function activeSkuLabel(activeSkuId: string | null) {
  return activeSkuId ?? "No active SKU";
}

function ResultTable({
  category,
  results,
}: {
  category: AgentEvalCategory;
  results: AgentEvalResult[];
}) {
  const scopedResults = results.filter((result) =>
    category.resultIds.includes(result.id),
  );

  return (
    <div className="overflow-x-auto">
      <table className="min-w-[1120px] table-fixed border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <th className="w-44 px-3 py-2 font-semibold">Case</th>
            <th className="w-64 px-3 py-2 font-semibold">Viewer message</th>
            <th className="w-40 px-3 py-2 font-semibold">Active context/SKU</th>
            <th className="w-56 px-3 py-2 font-semibold">Ground truth</th>
            <th className="w-56 px-3 py-2 font-semibold">Model result</th>
            <th className="w-72 px-3 py-2 font-semibold">Reply / evidence</th>
            <th className="w-32 px-3 py-2 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {scopedResults.map((result) => (
            <tr className="border-b border-slate-100 align-top" key={result.id}>
              <td className="px-3 py-3 font-semibold text-slate-900">
                <span className="block truncate" title={result.id}>
                  {result.id}
                </span>
              </td>
              <td className="px-3 py-3 text-slate-700">
                <p className="line-clamp-4 leading-5">{result.viewerMessage}</p>
              </td>
              <td className="px-3 py-3 text-slate-700">
                {activeSkuLabel(result.activeSkuId)}
              </td>
              <td className="px-3 py-3">
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-[11px] leading-4 text-slate-700">
                  {formatJson(result.expected)}
                </pre>
              </td>
              <td className="px-3 py-3">
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-[11px] leading-4 text-slate-700">
                  {formatJson({
                    resolvedSkuId: result.actual.resolvedSkuId,
                    intent: result.actual.intent,
                    decision: result.actual.decision,
                    riskLevel: result.actual.riskLevel,
                    orderQuantity: result.actual.orderQuantity,
                  })}
                </pre>
              </td>
              <td className="px-3 py-3 text-slate-700">
                <p className="line-clamp-5 leading-5">
                  {result.actual.safeReply || "No reply"}
                </p>
                <p className="mt-2 line-clamp-3 text-[11px] leading-4 text-slate-500">
                  Evidence: {result.actual.evidence.join("; ") || "-"}
                </p>
              </td>
              <td className="px-3 py-3">
                <span
                  className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${
                    result.passed
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-rose-200 bg-rose-50 text-rose-700"
                  }`}
                >
                  {result.passed ? "Passed" : "Failed"}
                </span>
                {result.failures.length > 0 ? (
                  <ul className="mt-2 space-y-1 text-[11px] leading-4 text-rose-700">
                    {result.failures.map((failure) => (
                      <li key={failure}>{failure}</li>
                    ))}
                  </ul>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AgentEvaluationPage() {
  const [suite, setSuite] = useState<AgentEvalSuiteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    async function runSuite() {
      setError(null);
      try {
        const response = await fetch("/api/eval/run-agent-suite", {
          method: "POST",
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`Evaluation request failed with ${response.status}`);
        }

        const payload = (await response.json()) as AgentEvalSuiteResponse;
        if (!cancelled) {
          setSuite(payload);
          setExpanded(new Set(payload.categories.map((category) => category.id)));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Evaluation request failed");
        }
      }
    }

    void runSuite();

    return () => {
      cancelled = true;
    };
  }, []);

  const resultById = useMemo(() => {
    return new Map(suite?.results.map((result) => [result.id, result]) ?? []);
  }, [suite]);

  function toggleCategory(categoryId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }

      return next;
    });
  }

  return (
    <AppShell
      eyebrow="Agent Evaluation"
      title="Reliability dashboard"
      description="Runs a read-only deterministic suite for SKU grounding, commerce intent, safe replies, and guardrail behavior."
      contentMaxWidthClass="max-w-[1500px]"
    >
      {error ? (
        <Panel title="Evaluation Error">
          <p className="text-sm leading-6 text-rose-700">{error}</p>
        </Panel>
      ) : null}

      {!suite && !error ? (
        <Panel title="Running Suite">
          <p className="text-sm leading-6 text-slate-600">
            Running isolated deterministic cases with no writes to live state.
          </p>
        </Panel>
      ) : null}

      {suite ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Total cases", suite.total],
              ["Passed", suite.passed],
              ["Failed", suite.failed],
              ["Overall pass rate", `${suite.passRate}%`],
            ].map(([label, value]) => (
              <div
                className={`rounded-lg border p-4 shadow-sm ${
                  label === "Overall pass rate"
                    ? passRateTone(suite.passRate)
                    : "border-slate-200 bg-white text-slate-900"
                }`}
                key={label}
              >
                <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
                  {label}
                </p>
                <p className="mt-2 text-2xl font-semibold">{value}</p>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            {suite.categories.map((category) => {
              const isExpanded = expanded.has(category.id);
              const categoryResults = category.resultIds
                .map((resultId) => resultById.get(resultId))
                .filter((result): result is AgentEvalResult => Boolean(result));

              return (
                <Panel
                  className="overflow-hidden"
                  contentClassName="mt-0"
                  key={category.id}
                  title={category.title}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="max-w-3xl text-sm leading-6 text-slate-600">
                        {category.explanation}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                        <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-slate-700">
                          {category.total} samples
                        </span>
                        <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700">
                          {category.passed} passed
                        </span>
                        <span className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-rose-700">
                          {category.total - category.passed} failed
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-md border px-2 py-1 text-xs font-semibold ${passRateTone(
                          category.passRate,
                        )}`}
                      >
                        {category.passRate}% pass rate
                      </span>
                      <button
                        className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:text-teal-800"
                        aria-expanded={isExpanded}
                        onClick={() => toggleCategory(category.id)}
                        type="button"
                      >
                        {isExpanded ? "Collapse samples" : "Expand samples"}
                      </button>
                    </div>
                  </div>

                  {isExpanded ? (
                    <div className="mt-4">
                      <ResultTable
                        category={category}
                        results={categoryResults}
                      />
                    </div>
                  ) : null}
                </Panel>
              );
            })}
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
