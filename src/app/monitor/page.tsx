"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell, Panel, StatusPill } from "@/components/dashboard";
import {
  fetchLiveMetrics,
  sendMonitorSignal,
  type MonitorResponse,
  type MonitorSignalPayload,
} from "@/lib/livecrew-api";
import { setMonitorSignal } from "@/lib/local-room";

const scenarios: Array<{
  label: string;
  payload: Omit<MonitorSignalPayload, "online_viewers" | "online_viewers_delta">;
}> = [
  {
    label: "Value hesitation",
    payload: {
      gpm_cents: 31200,
      gpm_delta: -12.4,
      conversion_rate: 0.7,
      conversion_rate_delta: -0.4,
      comment_sentiment: 0.81,
      interaction_rate: 1.2,
      intent_distribution: { ask_link: 8, ask_price: 5, purchase_intent: 4 },
      high_intent_density: 11,
      top_question: "where to buy",
      top_question_count: 6,
    },
  },
  {
    label: "Hero SKU push",
    payload: {
      gpm_cents: 52800,
      gpm_delta: 26.8,
      conversion_rate: 2.8,
      conversion_rate_delta: 0.9,
      comment_sentiment: 0.76,
      interaction_rate: 4.8,
      intent_distribution: { purchase_intent: 12, ask_link: 7, ask_price: 3 },
      high_intent_density: 16,
      top_question: "how to checkout",
      top_question_count: 5,
    },
  },
  {
    label: "Warm retention",
    payload: {
      gpm_cents: 18800,
      gpm_delta: -4.1,
      conversion_rate: 1.4,
      conversion_rate_delta: -0.1,
      comment_sentiment: 0.62,
      interaction_rate: 1.9,
      intent_distribution: { ask_price: 4, ask_size: 3, other: 8 },
      high_intent_density: 3,
      top_question: "what is the price",
      top_question_count: 3,
    },
  },
  {
    label: "Cold-room alert",
    payload: {
      gpm_cents: 21600,
      gpm_delta: -7.8,
      conversion_rate: 1.1,
      conversion_rate_delta: -0.2,
      comment_sentiment: 0.38,
      interaction_rate: 0.6,
      intent_distribution: { authenticity_doubt: 6, ask_price: 4, other: 5 },
      high_intent_density: 2,
      top_question: "is this authentic",
      top_question_count: 6,
    },
  },
];

const signalInputFields: Array<{
  key: keyof Pick<
    MonitorSignalPayload,
    | "online_viewers"
    | "online_viewers_delta"
    | "gpm_cents"
    | "gpm_delta"
    | "conversion_rate"
    | "conversion_rate_delta"
    | "high_intent_density"
    | "top_question_count"
    | "interaction_rate"
  >;
  label: string;
}> = [
  { key: "online_viewers", label: "Online viewers" },
  { key: "online_viewers_delta", label: "Viewer delta %" },
  { key: "gpm_cents", label: "GPM cents" },
  { key: "gpm_delta", label: "GPM delta %" },
  { key: "conversion_rate", label: "Conversion rate %" },
  { key: "conversion_rate_delta", label: "Conversion delta %" },
  { key: "high_intent_density", label: "High-intent / min" },
  { key: "top_question_count", label: "Repeated question count" },
  { key: "interaction_rate", label: "Interaction rate %" },
];

function formatSigned(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatMoney(cents: number) {
  return `$${Math.round(cents / 100)}`;
}

function metricTone(value: number, positiveGood = true) {
  const isGood = positiveGood ? value >= 0 : value <= 0;
  return isGood ? "text-emerald-700" : "text-rose-700";
}

export default function MonitorPage() {
  const [payload, setPayload] = useState<MonitorSignalPayload>({
    online_viewers: 0,
    online_viewers_delta: 0,
    ...scenarios[0].payload,
  });
  const [response, setResponse] = useState<MonitorResponse | null>(null);
  const [history, setHistory] = useState<MonitorResponse[]>([]);
  const [status, setStatus] = useState("idle");
  const monitorRunningRef = useRef(false);
  const latestPayloadRef = useRef(payload);

  useEffect(() => {
    async function syncLiveMetrics() {
      try {
        const metrics = await fetchLiveMetrics();
        setPayload((current) => ({
          ...current,
          online_viewers: metrics.online_viewers,
          online_viewers_delta: metrics.online_viewers_delta,
          gpm_cents: metrics.gpm_cents,
          gpm_delta: metrics.gpm_delta,
          conversion_rate: metrics.conversion_rate,
          conversion_rate_delta: metrics.conversion_rate_delta,
          comment_sentiment: metrics.comment_sentiment,
          interaction_rate: metrics.interaction_rate,
          intent_distribution: metrics.intent_distribution,
          high_intent_density: metrics.high_intent_density,
          top_question: metrics.top_question,
          top_question_count: metrics.top_question_count,
        }));
      } catch {
        setStatus("metrics offline");
      }
    }

    void syncLiveMetrics();
    const intervalId = window.setInterval(syncLiveMetrics, 3000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    latestPayloadRef.current = payload;
  }, [payload]);

  useEffect(() => {
    void runMonitor(latestPayloadRef.current, { recordHistory: false });
    const intervalId = window.setInterval(() => {
      void runMonitor(latestPayloadRef.current, { recordHistory: false });
    }, 5000);
    return () => window.clearInterval(intervalId);
    // latestPayloadRef keeps this interval on fresh metrics without rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const metricCards = useMemo(
    () => [
      {
        label: "Online viewers",
        value: payload.online_viewers.toLocaleString(),
        delta: formatSigned(payload.online_viewers_delta),
        tone: metricTone(payload.online_viewers_delta),
      },
      {
        label: "GPM",
        value: formatMoney(payload.gpm_cents),
        delta: formatSigned(payload.gpm_delta),
        tone: metricTone(payload.gpm_delta),
      },
      {
        label: "Conversion rate",
        value: `${payload.conversion_rate.toFixed(1)}%`,
        delta: formatSigned(payload.conversion_rate_delta),
        tone: metricTone(payload.conversion_rate_delta),
      },
      {
        label: "High-intent density",
        value: `${payload.high_intent_density.toFixed(0)}/min`,
        delta: payload.high_intent_density >= 3 ? "rising" : "normal",
        tone: payload.high_intent_density >= 3 ? "text-rose-700" : "text-emerald-700",
      },
    ],
    [payload],
  );

  const topIntentEntries = useMemo(
    () =>
      Object.entries(payload.intent_distribution)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3),
    [payload.intent_distribution],
  );

  async function getPayloadWithLiveViewers(nextPayload = payload) {
    const liveMetrics = await fetchLiveMetrics();
    return {
      ...nextPayload,
      online_viewers: liveMetrics.online_viewers,
      online_viewers_delta: liveMetrics.online_viewers_delta,
      gpm_cents: liveMetrics.gpm_cents,
      gpm_delta: liveMetrics.gpm_delta,
      conversion_rate: liveMetrics.conversion_rate,
      conversion_rate_delta: liveMetrics.conversion_rate_delta,
      comment_sentiment: liveMetrics.comment_sentiment,
      interaction_rate: Math.max(nextPayload.interaction_rate, liveMetrics.interaction_rate),
      intent_distribution: liveMetrics.intent_distribution,
      high_intent_density: liveMetrics.high_intent_density,
      top_question: liveMetrics.top_question,
      top_question_count: liveMetrics.top_question_count,
    };
  }

  async function runMonitor(
    nextPayload = payload,
    options: { recordHistory?: boolean } = {},
  ) {
    if (monitorRunningRef.current) {
      return;
    }
    monitorRunningRef.current = true;
    setStatus("running");
    try {
      const livePayload = await getPayloadWithLiveViewers(nextPayload);
      setPayload(livePayload);
      const result = await sendMonitorSignal(livePayload);
      setResponse(result);
      setMonitorSignal({
        scenarioLabel: result.scenario.label,
        scenarioReason: result.scenario.reason,
        urgency: result.scenario.urgency,
        hookLabel: result.hook.label,
        hostCue: result.hook.host_cue,
        script: result.hook.script,
        signals: result.signals,
      });
      if (options.recordHistory ?? true) {
        setHistory((current) => [result, ...current].slice(0, 8));
      }
      setStatus("idle");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Monitor request failed");
    } finally {
      monitorRunningRef.current = false;
    }
  }

  function applyScenario(
    nextPayload: Omit<MonitorSignalPayload, "online_viewers" | "online_viewers_delta">,
  ) {
    const mergedPayload = {
      ...payload,
      ...nextPayload,
    };
    setPayload(mergedPayload);
    void runMonitor(mergedPayload);
  }

  return (
    <AppShell
      eyebrow="Monitor"
      title="Monitor Agent"
      description="Monitor real viewer count, chat intent, high-intent density, and repeated unanswered questions."
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <StatusPill tone="good">Live</StatusPill>
          <StatusPill>Live viewers {payload.online_viewers}</StatusPill>
          <StatusPill>{status === "running" ? "MonitorAgent running" : "MonitorAgent ready"}</StatusPill>
        </div>
        <button
          className="min-h-10 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800"
          onClick={() => void runMonitor()}
          type="button"
        >
          Run Monitor Now
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {metricCards.map((metric) => (
          <Panel key={metric.label} title={metric.label}>
            <p className="text-3xl font-semibold text-slate-950">{metric.value}</p>
            <p className={`mt-2 text-sm font-semibold ${metric.tone}`}>{metric.delta}</p>
          </Panel>
        ))}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_0.95fr]">
        <Panel title="Live Signals" eyebrow="agent input">
          <div className="grid gap-3 md:grid-cols-2">
            {signalInputFields.map(({ key, label }) => (
              <label className="text-sm font-medium text-slate-700" key={key}>
                {label}
                <input
                  className="mt-1 h-10 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-teal-500 focus:bg-white"
                  disabled={
                    key === "online_viewers" ||
                    key === "online_viewers_delta" ||
                    key === "high_intent_density" ||
                    key === "top_question_count"
                  }
                  onChange={(event) =>
                    setPayload((current) => ({
                      ...current,
                      [key]: Number(event.target.value),
                    }))
                  }
                  type="number"
                  value={payload[key]}
                />
              </label>
            ))}
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-md border border-teal-100 bg-teal-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Top chat intents
              </p>
              <div className="mt-3 space-y-2">
                {topIntentEntries.map(([intent], index) => (
                  <div
                    className="rounded-md bg-white px-3 py-2"
                    key={intent}
                  >
                    <span className="text-sm font-semibold text-slate-950">
                      Top{index + 1} {intent.replaceAll("_", " ")}
                    </span>
                  </div>
                ))}
                {topIntentEntries.length === 0 ? (
                  <p className="rounded-md bg-white px-3 py-2 text-sm text-slate-500">
                    No intent messages yet.
                  </p>
                ) : null}
              </div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Question backlog
              </p>
              <p className="mt-2 text-sm font-semibold text-slate-950">
                {payload.top_question ?? "none"}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                {payload.top_question_count} repeated messages
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-500">Demo scenarios:</span>
            {scenarios.map((scenario) => (
              <button
                className="min-h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:text-teal-800"
                key={scenario.label}
                onClick={() => applyScenario(scenario.payload)}
                type="button"
              >
                {scenario.label}
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="Agent Judgment" eyebrow="scene and hook">
          {response ? (
            <div className="rounded-md border border-rose-100 bg-rose-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-rose-700">{response.scenario.label}</p>
                  <h2 className="mt-2 text-xl font-semibold text-slate-950">{response.hook.label}</h2>
                </div>
                <StatusPill tone={response.scenario.urgency === "high" ? "warning" : "neutral"}>
                  {response.scenario.urgency}
                </StatusPill>
              </div>
              {response.hook.host_cue ? (
                <div className="mt-4 rounded-md border border-amber-100 bg-amber-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                    Host Cue
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-800">
                    {response.hook.host_cue}
                  </p>
                </div>
              ) : null}
              <div className="mt-3 rounded-md bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Suggested Line
                </p>
                <p className="mt-2 text-base leading-7 text-slate-950">
                  {response.hook.script}
                </p>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-600">{response.scenario.reason}</p>
            </div>
          ) : (
            <p className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              Run the monitor judgment or choose a demo scenario.
            </p>
          )}
        </Panel>
      </div>

      <Panel title="Agent Trigger History" eyebrow="history">
        <div className="grid gap-3">
          {history.map((item) => (
            <article
              className="grid gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 md:grid-cols-[0.7fr_1fr]"
              key={item.created_at}
            >
              <div>
                <p className="text-sm font-semibold text-slate-950">{item.scenario.label}</p>
                <p className="mt-1 text-xs text-slate-500">{new Date(item.created_at).toLocaleTimeString()}</p>
              </div>
              <div className="grid gap-2">
                {item.hook.host_cue ? (
                  <p className="text-xs leading-5 text-amber-700">
                    Host Cue: {item.hook.host_cue}
                  </p>
                ) : null}
                <p className="text-sm leading-6 text-slate-700">
                  Suggested Line: {item.hook.script}
                </p>
              </div>
            </article>
          ))}
          {history.length === 0 ? (
            <p className="text-sm text-slate-500">No trigger history yet.</p>
          ) : null}
        </div>
      </Panel>
    </AppShell>
  );
}
