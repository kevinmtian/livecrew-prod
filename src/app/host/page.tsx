"use client";

import { AppShell, Panel, StatusPill } from "@/components/dashboard";
import {
  type BackendCommerceState,
  type BackendReport,
  type BackendWorkflowResponse,
  approvePendingAction,
  backendBaseUrl,
  cents,
  generateReport,
  getBackendState,
  rejectPendingAction,
  resetBackend,
  sendHostTranscript,
  sendViewerMessage,
} from "@/lib/backend-client";
import { type FormEvent, useEffect, useMemo, useState } from "react";

const demoTranscript =
  "Switch to the tumbler, make it 22, and first 20 orders get 18.8 for five minutes.";

function latest<T>(items: T[], count: number) {
  return [...items].reverse().slice(0, count);
}

function findSku(state: BackendCommerceState | null, skuId: string | null) {
  return state?.skus.find((sku) => sku.id === skuId) ?? null;
}

export default function HostPage() {
  const [state, setState] = useState<BackendCommerceState | null>(null);
  const [lastResponse, setLastResponse] =
    useState<BackendWorkflowResponse | null>(null);
  const [report, setReport] = useState<BackendReport | null>(null);
  const [transcript, setTranscript] = useState(demoTranscript);
  const [viewerMessage, setViewerMessage] = useState(
    "Can I get two of it and 50% off?",
  );
  const [status, setStatus] = useState<"connected" | "offline" | "working">(
    "working",
  );
  const [error, setError] = useState<string | null>(null);

  const activeSku = useMemo(
    () => findSku(state, state?.active_sku_id ?? null),
    [state],
  );

  async function loadState() {
    try {
      const nextState = await getBackendState();
      setState(nextState);
      setStatus("connected");
      setError(null);
    } catch (caught) {
      setStatus("offline");
      setError(caught instanceof Error ? caught.message : "Backend unavailable");
    }
  }

  useEffect(() => {
    void getBackendState()
      .then((nextState) => {
        setState(nextState);
        setStatus("connected");
        setError(null);
      })
      .catch((caught) => {
        setStatus("offline");
        setError(caught instanceof Error ? caught.message : "Backend unavailable");
      });
    const events = new EventSource(`${backendBaseUrl}/events/stream`);
    events.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { state: BackendCommerceState };
      setState(payload.state);
      setStatus("connected");
    };
    events.onerror = () => {
      events.close();
    };
    return () => events.close();
  }, []);

  async function runWorkflow(workflow: () => Promise<BackendWorkflowResponse>) {
    setStatus("working");
    try {
      const response = await workflow();
      setLastResponse(response);
      setState(response.state);
      if (response.report) {
        setReport(response.report);
      }
      setStatus("connected");
      setError(null);
    } catch (caught) {
      setStatus("offline");
      setError(caught instanceof Error ? caught.message : "Backend unavailable");
    }
  }

  function handleTranscriptSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = transcript.trim();
    if (text) {
      runWorkflow(() => sendHostTranscript(text));
    }
  }

  function handleViewerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = viewerMessage.trim();
    if (text) {
      runWorkflow(() => sendViewerMessage(text, "demo_viewer"));
    }
  }

  return (
    <AppShell
      eyebrow="Host"
      title="Operator cockpit"
      description="Drive product listing, pricing, promotion, viewer support, confirmations, and reporting from backend commerce state."
    >
      <div className="mb-4 flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Backend
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <StatusPill
              tone={
                status === "connected"
                  ? "good"
                  : status === "working"
                    ? "neutral"
                    : "warning"
              }
            >
              {status}
            </StatusPill>
            <StatusPill>{backendBaseUrl}</StatusPill>
          </div>
          {error ? (
            <p className="mt-2 text-sm leading-6 text-amber-700">{error}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="min-h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:text-teal-800"
            onClick={loadState}
            type="button"
          >
            Refresh
          </button>
          <button
            className="min-h-10 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700 transition hover:bg-white"
            onClick={() => runWorkflow(resetBackend)}
            type="button"
          >
            Reset backend
          </button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr_0.9fr]">
        <div className="grid gap-4">
          <Panel title="Host Transcript" eyebrow="Co-Host Agent">
            <form onSubmit={handleTranscriptSubmit}>
              <label className="sr-only" htmlFor="transcript">
                Host transcript
              </label>
              <textarea
                className="min-h-36 w-full resize-y rounded-md border border-slate-200 bg-slate-50 p-3 text-sm leading-6 outline-none transition focus:border-teal-500 focus:bg-white"
                id="transcript"
                onChange={(event) => setTranscript(event.target.value)}
                value={transcript}
              />
              <button
                className="mt-3 min-h-10 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800"
                type="submit"
              >
                Process transcript
              </button>
            </form>
          </Panel>

          <Panel title="Viewer Message" eyebrow="Concierge Agent">
            <form onSubmit={handleViewerSubmit}>
              <label className="sr-only" htmlFor="viewer-message">
                Viewer message
              </label>
              <textarea
                className="min-h-24 w-full resize-y rounded-md border border-slate-200 bg-slate-50 p-3 text-sm leading-6 outline-none transition focus:border-teal-500 focus:bg-white"
                id="viewer-message"
                onChange={(event) => setViewerMessage(event.target.value)}
                value={viewerMessage}
              />
              <button
                className="mt-3 min-h-10 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800"
                type="submit"
              >
                Process viewer message
              </button>
            </form>
            {lastResponse?.suggested_reply ? (
              <div className="mt-3 rounded-md border border-teal-200 bg-teal-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">
                  Suggested reply
                </p>
                <p className="mt-1 text-sm leading-6 text-slate-800">
                  {lastResponse.suggested_reply}
                </p>
              </div>
            ) : null}
          </Panel>

          <Panel title="Pending Host Confirmations" eyebrow="Agent queue">
            <div className="space-y-3">
              {state?.pending_actions.filter((item) => item.status === "pending")
                .length ? (
                state.pending_actions
                  .filter((item) => item.status === "pending")
                  .map((item) => (
                    <div
                      className="rounded-md border border-amber-200 bg-amber-50 p-3"
                      key={item.id}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-slate-900">
                          {item.action.type}
                        </p>
                        <StatusPill tone="warning">
                          {item.guardrail_result.risk_level}
                        </StatusPill>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-slate-700">
                        {item.guardrail_result.message}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {item.action.source_text}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          className="min-h-9 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white"
                          onClick={() =>
                            runWorkflow(() => approvePendingAction(item.id))
                          }
                          type="button"
                        >
                          Approve
                        </button>
                        <button
                          className="min-h-9 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700"
                          onClick={() =>
                            runWorkflow(() => rejectPendingAction(item.id))
                          }
                          type="button"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))
              ) : (
                <p className="text-sm leading-6 text-slate-600">
                  No pending confirmations.
                </p>
              )}
            </div>
          </Panel>
        </div>

        <div className="grid gap-4">
          <Panel title="Product Shelf" eyebrow="Backend source of truth">
            {activeSku ? (
              <div className="rounded-md border border-teal-200 bg-teal-50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-950">
                      {activeSku.name}
                    </h2>
                    <p className="mt-1 text-sm text-slate-600">
                      {cents(activeSku.current_price_cents)} · {activeSku.stock} in
                      stock
                    </p>
                  </div>
                  <StatusPill tone="good">Active</StatusPill>
                </div>
                <ul className="mt-4 space-y-2 text-sm leading-6 text-slate-700">
                  {activeSku.facts.map((fact) => (
                    <li key={fact}>- {fact}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm leading-6 text-slate-600">
                No active SKU yet. Submit a transcript that mentions a seeded SKU.
              </p>
            )}
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {state?.skus.map((sku) => (
                <button
                  className={`rounded-md border p-3 text-left text-sm transition ${
                    sku.id === state.active_sku_id
                      ? "border-teal-300 bg-teal-50 text-teal-900"
                      : "border-slate-200 bg-slate-50 text-slate-700 hover:border-teal-300 hover:bg-white"
                  }`}
                  key={sku.id}
                  onClick={() => runWorkflow(() => sendHostTranscript(`Switch to ${sku.name}`))}
                  type="button"
                >
                  <span className="block font-semibold">{sku.name}</span>
                  <span className="mt-1 block text-xs">
                    {cents(sku.current_price_cents)} · {sku.stock} left
                  </span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="Commerce State" eyebrow="Orders and flash sale">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Units
                </p>
                <p className="mt-1 text-xl font-semibold text-slate-950">
                  {state?.metrics.total_units_sold ?? 0}
                </p>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  GMV
                </p>
                <p className="mt-1 text-xl font-semibold text-slate-950">
                  {cents(state?.metrics.total_gmv_cents ?? 0)}
                </p>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Risks
                </p>
                <p className="mt-1 text-xl font-semibold text-slate-950">
                  {state?.metrics.risk_events ?? 0}
                </p>
              </div>
            </div>
            {state?.flash_sale ? (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-amber-900">
                    Flash sale
                  </p>
                  <StatusPill tone={state.flash_sale.active ? "warning" : "neutral"}>
                    {state.flash_sale.active ? "active" : "inactive"}
                  </StatusPill>
                </div>
                <p className="mt-2 text-sm leading-6 text-amber-800">
                  {cents(state.flash_sale.sale_price_cents)} ·{" "}
                  {state.flash_sale.remaining_stock}/
                  {state.flash_sale.starting_stock} promo units left
                </p>
              </div>
            ) : null}
            <div className="mt-3 space-y-2">
              {latest(state?.orders ?? [], 4).map((order) => {
                const sku = findSku(state, order.sku_id);
                return (
                  <div
                    className="rounded-md border border-slate-200 bg-white p-3 text-sm"
                    key={order.id}
                  >
                    <p className="font-semibold text-slate-900">
                      {order.quantity} x {sku?.name ?? order.sku_id}
                    </p>
                    <p className="mt-1 text-slate-600">
                      {cents(order.total_price_cents)} · {order.viewer}
                    </p>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>

        <div className="grid gap-4">
          <Panel title="Event Ledger" eyebrow="Evidence">
            <div className="max-h-[35rem] space-y-3 overflow-y-auto pr-1">
              {latest(state?.ledger ?? [], 20).map((entry) => (
                <div className="border-l-2 border-teal-500 pl-3" key={entry.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900">
                      {entry.type}
                    </p>
                    <StatusPill>{entry.actor}</StatusPill>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {entry.message}
                  </p>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Producer Report" eyebrow="Post-stream">
            <button
              className="min-h-10 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800"
              onClick={() => runWorkflow(generateReport)}
              type="button"
            >
              Generate report
            </button>
            {report ? (
              <div className="mt-4 space-y-3 text-sm leading-6 text-slate-700">
                <p>
                  Units sold: {report.total_units_sold}. GMV:{" "}
                  {cents(report.total_gmv_cents)}.
                </p>
                <p>Listed SKUs: {report.listed_sku_ids.join(", ") || "None"}</p>
                <div>
                  <p className="font-semibold text-slate-900">Recommendations</p>
                  <ul className="mt-1 space-y-1">
                    {report.next_recommendations.map((item) => (
                      <li key={item}>- {item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm leading-6 text-slate-600">
                Generate after the demo flow to cite backend numbers.
              </p>
            )}
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
