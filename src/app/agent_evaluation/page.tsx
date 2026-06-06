"use client";

import { AppShell, Panel, StatusPill } from "@/components/dashboard";
import { type EvalSuiteResult, runEvalSuite } from "@/lib/backend-client";
import { useEffect, useState } from "react";

export default function AgentEvaluationPage() {
  const [suite, setSuite] = useState<EvalSuiteResult | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "error">("running");
  const [error, setError] = useState<string | null>(null);

  async function loadSuite() {
    setStatus("running");
    try {
      const result = await runEvalSuite();
      setSuite(result);
      setStatus("idle");
      setError(null);
    } catch (caught) {
      setStatus("error");
      setError(
        caught instanceof Error
          ? caught.message
          : "Evaluation backend is unavailable.",
      );
    }
  }

  useEffect(() => {
    void runEvalSuite()
      .then((result) => {
        setSuite(result);
        setStatus("idle");
        setError(null);
      })
      .catch((caught) => {
        setStatus("error");
        setError(
          caught instanceof Error
            ? caught.message
            : "Evaluation backend is unavailable.",
        );
      });
  }, []);

  return (
    <AppShell
      eyebrow="Agent Evaluation"
      title="Reliability dashboard"
      description="Deterministic checks for grounding, commerce intent, pricing, promotions, missing context, and safety guardrails."
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <StatusPill
            tone={
              status === "idle" ? "good" : status === "error" ? "warning" : "neutral"
            }
          >
            {status}
          </StatusPill>
          {error ? <StatusPill tone="warning">backend unavailable</StatusPill> : null}
        </div>
        <button
          className="min-h-10 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800"
          onClick={loadSuite}
          type="button"
        >
          Run suite
        </button>
      </div>

      {error ? (
        <Panel title="Evaluation Backend" eyebrow="Unavailable">
          <p className="text-sm leading-6 text-amber-700">{error}</p>
        </Panel>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {suite?.categories.map((evaluation) => (
          <Panel
            title={evaluation.category}
            eyebrow="Category"
            key={evaluation.category}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <StatusPill tone={evaluation.pass_rate >= 90 ? "good" : "warning"}>
                {evaluation.pass_rate}% pass rate
              </StatusPill>
              <p className="text-sm font-semibold text-slate-900">
                {evaluation.passed}/{evaluation.total}
              </p>
            </div>
          </Panel>
        ))}
      </div>

      <div className="mt-4">
        <Panel title="Inspectable Result Table" eyebrow="Deterministic cases">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[58rem] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-3 font-semibold">Case</th>
                  <th className="py-2 pr-3 font-semibold">Category</th>
                  <th className="py-2 pr-3 font-semibold">Input</th>
                  <th className="py-2 pr-3 font-semibold">Expected</th>
                  <th className="py-2 pr-3 font-semibold">Actual</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {suite?.results.map((result) => (
                  <tr className="border-b border-slate-100" key={result.id}>
                    <td className="py-3 pr-3 font-medium text-slate-900">
                      {result.id}
                    </td>
                    <td className="py-3 pr-3 text-slate-700">
                      {result.category}
                    </td>
                    <td className="py-3 pr-3 text-slate-700">{result.input}</td>
                    <td className="py-3 pr-3 text-slate-700">
                      {result.expected}
                    </td>
                    <td className="py-3 pr-3 text-slate-700">{result.actual}</td>
                    <td className="py-3 pr-3">
                      <StatusPill tone={result.passed ? "good" : "warning"}>
                        {result.passed ? "pass" : "fail"}
                      </StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {suite?.results.length ? null : (
              <p className="py-4 text-sm leading-6 text-slate-600">
                Run the suite after starting the backend.
              </p>
            )}
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
