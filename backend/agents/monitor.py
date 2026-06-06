from __future__ import annotations

import os
from typing import Literal

from pydantic import BaseModel, Field

from backend.models import MonitorHook, MonitorResponse, MonitorScenario, MonitorSignalRequest
from backend.openai_client import get_openai_client


class MonitorOpenAIAnalysis(BaseModel):
    scenario_id: Literal["hesitation", "spike_push", "warm_retention", "cold_warning", "steady"]
    scenario_label: str
    scenario_reason: str
    urgency: Literal["low", "medium", "high"]
    hook_id: Literal["suspense", "order_push", "benefit", "interaction"]
    hook_label: str
    script: str = Field(min_length=1)


def _percent(value: float) -> str:
    return f"{value:.1f}%"


def _currency(cents: int) -> str:
    return f"${cents / 100:.0f}"


def _format_signals(signal: MonitorSignalRequest) -> dict[str, str]:
    return {
        "online_viewers": f"{signal.online_viewers:,} ({_percent(signal.online_viewers_delta)})",
        "gpm": f"{_currency(signal.gpm_cents)} ({_percent(signal.gpm_delta)})",
        "conversion_rate": f"{_percent(signal.conversion_rate)} ({_percent(signal.conversion_rate_delta)})",
        "comment_sentiment": _percent(signal.comment_sentiment * 100),
        "interaction_rate": _percent(signal.interaction_rate),
    }


def _analyze_with_rules(signal: MonitorSignalRequest) -> tuple[MonitorScenario, MonitorHook]:
    if signal.online_viewers_delta >= 12 and signal.conversion_rate < 1:
        scenario = MonitorScenario(
            id="hesitation",
            label="憋单场景",
            reason="人数高峰叠加转化率低，适合制造稀缺预期。",
            urgency="high",
        )
        hook = MonitorHook(
            id="suspense",
            label="悬念钩",
            script="姐妹们，这个价格我们今天只有直播间才有，外面旗舰店现在还是原价。不用想太多，犹豫的先把购物车加上，一会儿我给你们一个理由马上拍。",
        )
    elif signal.gpm_delta >= 15:
        scenario = MonitorScenario(
            id="spike_push",
            label="爆款冲刺",
            reason="GPM 突然拉升，适合倒计时配合库存推进。",
            urgency="high",
        )
        hook = MonitorHook(
            id="order_push",
            label="逼单钩",
            script="现在这波已经开始冲了，库存我盯着，想要的直接拍。倒计时结束后我就切下一个福利，不要等到补不到单。",
        )
    elif signal.online_viewers_delta < -8:
        scenario = MonitorScenario(
            id="warm_retention",
            label="暖场留人",
            reason="在线人数下滑，需要先稳住停留再承接成交。",
            urgency="medium",
        )
        hook = MonitorHook(
            id="benefit",
            label="福利钩",
            script="先别划走，下一轮我会放一个更适合新进直播间的福利。想看价格的扣 1，我先把重点讲清楚。",
        )
    elif signal.comment_sentiment < 0.45 or signal.interaction_rate < 1:
        scenario = MonitorScenario(
            id="cold_warning",
            label="冷场预警",
            reason="弹幕情绪或互动率偏低，需要用数字和提问拉回注意力。",
            urgency="medium",
        )
        hook = MonitorHook(
            id="interaction",
            label="互动钩",
            script="我看弹幕有点安静，想要我直接报到手价的扣 1，想看上脸/上手效果的扣 2，我按你们的节奏来。",
        )
    else:
        scenario = MonitorScenario(
            id="steady",
            label="稳定观察",
            reason="核心指标没有明显异常，继续监控趋势。",
            urgency="low",
        )
        hook = MonitorHook(
            id="benefit",
            label="福利钩",
            script="现在节奏是稳的，我先把当前福利和库存再过一遍，新进来的朋友可以直接跟这一波。",
        )

    return scenario, hook


def _analyze_with_openai(
    signal: MonitorSignalRequest,
    rule_scenario: MonitorScenario,
    rule_hook: MonitorHook,
) -> tuple[MonitorScenario, MonitorHook] | None:
    client = get_openai_client()
    if client is None:
        return None

    model = os.getenv("OPENAI_MONITOR_MODEL", "gpt-4o-mini")
    system_prompt = (
        "You are LiveCrew's MonitorAgent for livestream commerce operations. "
        "Use real-time metrics and the deterministic candidate scenario to select "
        "the best scene judgment and generate one concise host script in Chinese. "
        "Keep the output practical for a live host. Do not invent coupons, stock, "
        "medical claims, delivery promises, or external prices. The script should "
        "sound natural, urgent when appropriate, and be 1-3 sentences."
    )
    user_prompt = (
        "Allowed scenario ids: hesitation, spike_push, warm_retention, cold_warning, steady.\n"
        "Allowed hook ids: suspense, order_push, benefit, interaction.\n\n"
        f"Metrics:\n"
        f"- online_viewers={signal.online_viewers}, delta={signal.online_viewers_delta}%\n"
        f"- gpm_cents={signal.gpm_cents}, gpm_delta={signal.gpm_delta}%\n"
        f"- conversion_rate={signal.conversion_rate}%, conversion_rate_delta={signal.conversion_rate_delta}%\n"
        f"- comment_sentiment={signal.comment_sentiment} from 0 to 1\n"
        f"- interaction_rate={signal.interaction_rate}%\n\n"
        f"Deterministic candidate scenario: {rule_scenario.id} / {rule_scenario.label}\n"
        f"Candidate reason: {rule_scenario.reason}\n"
        f"Candidate hook: {rule_hook.id} / {rule_hook.label}\n"
        f"Candidate script: {rule_hook.script}"
    )

    try:
        completion = client.beta.chat.completions.parse(
            model=model,
            temperature=0.4,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format=MonitorOpenAIAnalysis,
        )
    except Exception:
        return None

    parsed = completion.choices[0].message.parsed
    if parsed is None:
        return None

    return (
        MonitorScenario(
            id=parsed.scenario_id,
            label=parsed.scenario_label,
            reason=parsed.scenario_reason,
            urgency=parsed.urgency,
        ),
        MonitorHook(
            id=parsed.hook_id,
            label=parsed.hook_label,
            script=parsed.script,
        ),
    )


def analyze_monitor_signals(signal: MonitorSignalRequest) -> MonitorResponse:
    rule_scenario, rule_hook = _analyze_with_rules(signal)
    openai_result = _analyze_with_openai(signal, rule_scenario, rule_hook)
    scenario, hook = openai_result if openai_result else (rule_scenario, rule_hook)
    signals = _format_signals(signal)
    signals["analysis_source"] = "openai" if openai_result else "rules"

    return MonitorResponse(
        scenario=scenario,
        hook=hook,
        signals=signals,
    )
