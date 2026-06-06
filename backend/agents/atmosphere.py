from __future__ import annotations

import json
import os
import re
from datetime import timedelta

from pydantic import BaseModel, Field

from backend.models import AtmosphereCue, CommerceState, utc_now
from backend.openai_client import generate_speech_base64, get_openai_client
from backend.tools.sku_resolver import get_sku_by_id


ATMOSPHERE_RE = re.compile(
    r"(还剩|剩下|剩多少|多少单|几单|几个名额|库存|余量|名额|抢完|卖了多少|"
    r"left|remaining|how many|how much stock|orders left|units left|sold|"
    r"countdown|秒杀|flash)",
    re.IGNORECASE,
)
QUESTION_RE = re.compile(r"(\?|？|多少|几|how many|how much|left|remaining)", re.IGNORECASE)


class AtmosphereCueIntent(BaseModel):
    should_answer: bool
    confidence: float = Field(ge=0, le=1)
    reason: str


def _flash_sale_seconds_left(state: CommerceState) -> int | None:
    if not state.flash_sale:
        return None

    ends_at = state.flash_sale.created_at + timedelta(
        seconds=state.flash_sale.duration_seconds
    )
    remaining = int((ends_at - utc_now()).total_seconds())
    return max(0, remaining)


def _deterministic_should_answer(text: str, state: CommerceState) -> AtmosphereCueIntent:
    if not state.flash_sale:
        return AtmosphereCueIntent(
            should_answer=False,
            confidence=1,
            reason="No active flash sale exists.",
        )

    normalized = text.strip()
    if not normalized:
        return AtmosphereCueIntent(
            should_answer=False,
            confidence=1,
            reason="Transcript is empty.",
        )

    if ATMOSPHERE_RE.search(normalized) and QUESTION_RE.search(normalized):
        return AtmosphereCueIntent(
            should_answer=True,
            confidence=0.78,
            reason="Transcript asks for flash-sale remaining quantity or urgency.",
        )

    return AtmosphereCueIntent(
        should_answer=False,
        confidence=0.72,
        reason="Transcript is not a flash-sale atmosphere question.",
    )


def _classify_with_openai(text: str, state: CommerceState) -> AtmosphereCueIntent | None:
    client = get_openai_client()
    if client is None or not state.flash_sale:
        return None

    sku = get_sku_by_id(state.flash_sale.sku_id, state.skus)
    facts = {
        "active_sku_id": state.active_sku_id,
        "flash_sale_sku_id": state.flash_sale.sku_id,
        "flash_sale_sku_name": sku.name if sku else state.flash_sale.sku_id,
        "remaining_stock": state.flash_sale.remaining_stock,
        "stock_limit": state.flash_sale.stock_limit,
        "seconds_left": _flash_sale_seconds_left(state),
    }
    messages = [
        {
            "role": "system",
            "content": (
                "Classify whether a livestream host transcript is asking an "
                "assistant-style atmosphere question during a flash sale. Return "
                "should_answer=true only for questions or prompts about remaining "
                "sale stock, remaining orders, sold count, countdown, or flash-sale "
                "urgency. Do not answer ordinary product description, price setup, "
                "viewer Q&A, or unsupported promotion requests."
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {"transcript": text, "current_facts": facts},
                ensure_ascii=False,
            ),
        },
    ]

    try:
        completion = client.beta.chat.completions.parse(
            model=os.getenv("OPENAI_ATMOSPHERE_MODEL", "gpt-5.4-mini"),
            temperature=0,
            messages=messages,
            response_format=AtmosphereCueIntent,
        )
    except Exception:
        return None

    return completion.choices[0].message.parsed


def _format_seconds(seconds: int | None) -> str:
    if seconds is None:
        return ""
    if seconds >= 60:
        minutes = seconds // 60
        extra_seconds = seconds % 60
        if extra_seconds:
            return f"，倒计时还有{minutes}分{extra_seconds}秒"
        return f"，倒计时还有{minutes}分钟"
    return f"，倒计时还有{seconds}秒"


def _cue_text(state: CommerceState) -> str:
    sale = state.flash_sale
    if not sale:
        return ""

    sku = get_sku_by_id(sale.sku_id, state.skus)
    sku_name = sku.name if sku else "当前商品"
    seconds_text = _format_seconds(_flash_sale_seconds_left(state))
    if sale.remaining_stock <= 0:
        return f"{sku_name}这一轮秒杀名额已经抢完了，主播可以准备切下一轮节奏。"

    return (
        f"现在还剩{sale.remaining_stock}单{seconds_text}。"
        "想要的朋友可以直接拍，手慢这一轮就没有了。"
    )


def generate_atmosphere_cue(
    text: str,
    state: CommerceState,
) -> tuple[AtmosphereCue | None, str | None, str | None]:
    intent = _classify_with_openai(text, state) or _deterministic_should_answer(text, state)
    seconds_left = _flash_sale_seconds_left(state)
    if not state.flash_sale or not intent.should_answer or seconds_left == 0:
        return None, None, None

    answer_text = _cue_text(state)
    cue = AtmosphereCue(
        source_text=text,
        answer_text=answer_text,
        sku_id=state.flash_sale.sku_id,
        remaining_stock=state.flash_sale.remaining_stock,
        stock_limit=state.flash_sale.stock_limit,
        seconds_left=seconds_left,
        confidence=intent.confidence,
        reason=intent.reason,
    )

    try:
        audio_base64, audio_mime_type = generate_speech_base64(
            answer_text,
            instructions=(
                "Speak in energetic Mandarin Chinese for a livestream commerce "
                "flash-sale assistant. Keep it punchy, warm, and clear."
            ),
        )
        cue.audio_status = "generated"
        return cue, audio_base64, audio_mime_type
    except Exception:
        cue.audio_status = "unavailable"
        return cue, None, None
