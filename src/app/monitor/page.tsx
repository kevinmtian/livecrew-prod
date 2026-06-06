"use client";

import { useMemo, useState } from "react";
import { AppShell, Panel, StatusPill } from "@/components/dashboard";
import {
  sendMonitorSignal,
  type MonitorResponse,
  type MonitorSignalPayload,
} from "@/lib/livecrew-api";
import { setMonitorSignal } from "@/lib/local-room";

const scenarios: Array<{
  label: string;
  payload: MonitorSignalPayload;
}> = [
  {
    label: "憋单场景",
    payload: {
      online_viewers: 2341,
      online_viewers_delta: 18.2,
      gpm_cents: 31200,
      gpm_delta: -12.4,
      conversion_rate: 0.7,
      conversion_rate_delta: -0.4,
      comment_sentiment: 0.81,
      interaction_rate: 1.2,
    },
  },
  {
    label: "爆款冲刺",
    payload: {
      online_viewers: 1980,
      online_viewers_delta: 6.4,
      gpm_cents: 52800,
      gpm_delta: 26.8,
      conversion_rate: 2.8,
      conversion_rate_delta: 0.9,
      comment_sentiment: 0.76,
      interaction_rate: 4.8,
    },
  },
  {
    label: "暖场留人",
    payload: {
      online_viewers: 1088,
      online_viewers_delta: -13.6,
      gpm_cents: 18800,
      gpm_delta: -4.1,
      conversion_rate: 1.4,
      conversion_rate_delta: -0.1,
      comment_sentiment: 0.62,
      interaction_rate: 1.9,
    },
  },
  {
    label: "冷场预警",
    payload: {
      online_viewers: 1260,
      online_viewers_delta: -2.1,
      gpm_cents: 21600,
      gpm_delta: -7.8,
      conversion_rate: 1.1,
      conversion_rate_delta: -0.2,
      comment_sentiment: 0.38,
      interaction_rate: 0.6,
    },
  },
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
  const [payload, setPayload] = useState<MonitorSignalPayload>(scenarios[0].payload);
  const [response, setResponse] = useState<MonitorResponse | null>(null);
  const [history, setHistory] = useState<MonitorResponse[]>([]);
  const [status, setStatus] = useState("idle");

  const metricCards = useMemo(
    () => [
      {
        label: "在线人数",
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
        label: "转化率",
        value: `${payload.conversion_rate.toFixed(1)}%`,
        delta: formatSigned(payload.conversion_rate_delta),
        tone: metricTone(payload.conversion_rate_delta),
      },
      {
        label: "弹幕情绪",
        value: `${Math.round(payload.comment_sentiment * 100)}%`,
        delta: payload.comment_sentiment >= 0.55 ? "正向" : "偏冷",
        tone: payload.comment_sentiment >= 0.55 ? "text-emerald-700" : "text-rose-700",
      },
    ],
    [payload],
  );

  async function runMonitor(nextPayload = payload) {
    setStatus("running");
    try {
      const result = await sendMonitorSignal(nextPayload);
      setResponse(result);
      setMonitorSignal({
        scenarioLabel: result.scenario.label,
        scenarioReason: result.scenario.reason,
        urgency: result.scenario.urgency,
        hookLabel: result.hook.label,
        script: result.hook.script,
        signals: result.signals,
      });
      setHistory((current) => [result, ...current].slice(0, 8));
      setStatus("idle");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Monitor request failed");
    }
  }

  function applyScenario(nextPayload: MonitorSignalPayload) {
    setPayload(nextPayload);
    void runMonitor(nextPayload);
  }

  return (
    <AppShell
      eyebrow="Monitor"
      title="监控 agent"
      description="监测在线人数、GPM、弹幕情绪和互动率，识别直播场景并输出主播话术。"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <StatusPill tone="good">直播中</StatusPill>
          <StatusPill>{status === "running" ? "MonitorAgent running" : "MonitorAgent ready"}</StatusPill>
        </div>
        <button
          className="min-h-10 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800"
          onClick={() => void runMonitor()}
          type="button"
        >
          运行监控判断
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
        <Panel title="实时信号" eyebrow="agent input">
          <div className="grid gap-3 md:grid-cols-2">
            {[
              ["online_viewers", "在线人数"],
              ["online_viewers_delta", "在线人数波动 %"],
              ["gpm_cents", "GPM cents"],
              ["gpm_delta", "GPM 波动 %"],
              ["conversion_rate", "转化率 %"],
              ["conversion_rate_delta", "转化率波动 %"],
              ["comment_sentiment", "弹幕情绪 0-1"],
              ["interaction_rate", "互动率 %"],
            ].map(([key, label]) => (
              <label className="text-sm font-medium text-slate-700" key={key}>
                {label}
                <input
                  className="mt-1 h-10 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-teal-500 focus:bg-white"
                  onChange={(event) =>
                    setPayload((current) => ({
                      ...current,
                      [key]: Number(event.target.value),
                    }))
                  }
                  type="number"
                  value={payload[key as keyof MonitorSignalPayload]}
                />
              </label>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-500">模拟场景：</span>
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

        <Panel title="Agent 判断" eyebrow="scene and hook">
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
              <p className="mt-4 rounded-md bg-white p-4 text-base leading-7 text-slate-950">
                {response.hook.script}
              </p>
              <p className="mt-3 text-sm leading-6 text-slate-600">{response.scenario.reason}</p>
            </div>
          ) : (
            <p className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              点击运行监控判断，或选择一个模拟场景。
            </p>
          )}
        </Panel>
      </div>

      <Panel title="Agent 触发记录" eyebrow="history">
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
              <p className="text-sm leading-6 text-slate-700">{item.hook.script}</p>
            </article>
          ))}
          {history.length === 0 ? (
            <p className="text-sm text-slate-500">暂无触发记录。</p>
          ) : null}
        </div>
      </Panel>
    </AppShell>
  );
}
