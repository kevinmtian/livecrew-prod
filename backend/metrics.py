from __future__ import annotations

import os
import re
from collections import deque
from threading import Lock
from typing import Literal

from pydantic import BaseModel, Field

from backend.models import MonitorSignalRequest, utc_now
from backend.openai_client import get_openai_client


class ViewerSentimentAnalysis(BaseModel):
    sentiment_score: float = Field(ge=0, le=1)
    reason: str


class ViewerIntentAnalysis(BaseModel):
    intent: Literal[
        "ask_price",
        "ask_size",
        "ask_link",
        "authenticity_doubt",
        "purchase_intent",
        "ask_product",
        "other",
    ]
    high_intent: bool = False
    normalized_question: str | None = None
    reason: str


class LiveMetricsStore:
    def __init__(self) -> None:
        self._lock = Lock()
        self._viewer_seen_at: dict[str, float] = {}
        self._interaction_events: deque[float] = deque(maxlen=500)
        self._order_events: deque[float] = deque(maxlen=200)
        self._sentiment_events: deque[tuple[float, float]] = deque(maxlen=500)
        self._intent_events: deque[tuple[float, str, bool, str | None]] = deque(maxlen=500)
        self._last_online_viewers = 0
        self._last_gpm_cents = 0
        self._last_conversion_rate = 0.0

    def record_viewer_heartbeat(self, session_id: str) -> MonitorSignalRequest:
        with self._lock:
            self._viewer_seen_at[session_id] = utc_now().timestamp()
            return self.snapshot()

    def record_viewer_event(
        self,
        session_id: str,
        event_type: str,
        text: str | None = None,
    ) -> MonitorSignalRequest:
        sentiment_score = (
            self._score_sentiment_with_openai(text) if event_type == "message" and text else None
        )
        intent_analysis = (
            self._classify_viewer_intent_with_openai(text)
            if event_type == "message" and text
            else None
        )
        with self._lock:
            now = utc_now().timestamp()
            self._viewer_seen_at[session_id] = now
            if event_type in {"message", "like"}:
                self._interaction_events.append(now)
            if event_type == "message" and sentiment_score is not None:
                self._sentiment_events.append((now, sentiment_score))
            if event_type == "message" and intent_analysis is not None:
                self._intent_events.append(
                    (
                        now,
                        intent_analysis.intent,
                        intent_analysis.high_intent,
                        intent_analysis.normalized_question,
                    )
                )
            if event_type == "order":
                self._order_events.append(now)
            return self.snapshot()

    def snapshot(self) -> MonitorSignalRequest:
        now = utc_now().timestamp()
        active_cutoff = now - 15
        recent_cutoff = now - 60
        active_viewers = {
            session_id: seen_at
            for session_id, seen_at in self._viewer_seen_at.items()
            if seen_at >= active_cutoff
        }
        self._viewer_seen_at = active_viewers

        online_viewers = len(active_viewers)
        recent_interactions = len([ts for ts in self._interaction_events if ts >= recent_cutoff])
        recent_orders = len([ts for ts in self._order_events if ts >= recent_cutoff])
        recent_sentiments = [
            score for ts, score in self._sentiment_events if ts >= recent_cutoff
        ]
        recent_intents = [
            (intent, high_intent, question)
            for ts, intent, high_intent, question in self._intent_events
            if ts >= recent_cutoff
        ]
        intent_distribution = self._build_intent_distribution(recent_intents)
        high_intent_count = len(
            [intent for intent, high_intent, _question in recent_intents if high_intent]
        )
        high_intent_density = high_intent_count / 1.0
        top_question, top_question_count = self._find_top_question(recent_intents)
        interaction_rate = (
            (recent_interactions / online_viewers) * 100 if online_viewers else 0.0
        )
        conversion_rate = (recent_orders / online_viewers) * 100 if online_viewers else 0.0
        gpm_cents = int(recent_orders * 2990 + recent_interactions * 120)

        online_delta = self._delta_percent(online_viewers, self._last_online_viewers)
        gpm_delta = self._delta_percent(gpm_cents, self._last_gpm_cents)
        conversion_delta = self._delta_percent(conversion_rate, self._last_conversion_rate)

        self._last_online_viewers = online_viewers
        self._last_gpm_cents = gpm_cents
        self._last_conversion_rate = conversion_rate

        return MonitorSignalRequest(
            online_viewers=online_viewers,
            online_viewers_delta=online_delta,
            gpm_cents=gpm_cents,
            gpm_delta=gpm_delta,
            conversion_rate=conversion_rate,
            conversion_rate_delta=conversion_delta,
            comment_sentiment=(
                sum(recent_sentiments) / len(recent_sentiments)
                if recent_sentiments
                else 0.72 if recent_interactions else 0.5
            ),
            interaction_rate=interaction_rate,
            intent_distribution=intent_distribution,
            high_intent_density=high_intent_density,
            top_question=top_question,
            top_question_count=top_question_count,
        )

    def reset(self) -> None:
        with self._lock:
            self._viewer_seen_at.clear()
            self._interaction_events.clear()
            self._order_events.clear()
            self._sentiment_events.clear()
            self._intent_events.clear()
            self._last_online_viewers = 0
            self._last_gpm_cents = 0
            self._last_conversion_rate = 0.0

    @staticmethod
    def _build_intent_distribution(
        recent_intents: list[tuple[str, bool, str | None]],
    ) -> dict[str, int]:
        distribution = {
            "ask_price": 0,
            "ask_size": 0,
            "ask_link": 0,
            "authenticity_doubt": 0,
            "purchase_intent": 0,
            "ask_product": 0,
            "other": 0,
        }
        for intent, _high_intent, _question in recent_intents:
            distribution[intent] = distribution.get(intent, 0) + 1
        return distribution

    @staticmethod
    def _find_top_question(
        recent_intents: list[tuple[str, bool, str | None]],
    ) -> tuple[str | None, int]:
        counts: dict[str, int] = {}
        for intent, _high_intent, question in recent_intents:
            if intent == "other" or not question:
                continue
            counts[question] = counts.get(question, 0) + 1
        if not counts:
            return None, 0
        question, count = max(counts.items(), key=lambda item: item[1])
        return question, count

    @staticmethod
    def _classify_viewer_intent_with_openai(text: str) -> ViewerIntentAnalysis:
        client = get_openai_client()
        if client is None:
            return LiveMetricsStore._classify_viewer_intent_with_rules(text)

        try:
            completion = client.beta.chat.completions.parse(
                model=os.getenv("OPENAI_INTENT_MODEL", "gpt-4o-mini"),
                temperature=0,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Classify one livestream commerce chat message. "
                            "Intent definitions: ask_price asks price, discounts, coupons, offers; "
                            "ask_size asks size, fit, dimensions, shade, model compatibility; "
                            "ask_link asks where to buy, link, cart, how to place order; "
                            "authenticity_doubt questions fake/real/authentic/origin/trust; "
                            "purchase_intent expresses wanting to buy, add to cart, take one, order now; "
                            "ask_product asks whether a specific product, ingredient, variant, or category is available; "
                            "other is everything else. high_intent is true for messages like how to buy, "
                            "where to order, link please, any discount, I want one, add to cart, ready to pay. "
                            "normalized_question should be a short canonical Chinese or English question if repeated "
                            "questions should be grouped; otherwise null."
                        ),
                    },
                    {"role": "user", "content": text},
                ],
                response_format=ViewerIntentAnalysis,
            )
        except Exception:
            return LiveMetricsStore._classify_viewer_intent_with_rules(text)

        parsed = completion.choices[0].message.parsed
        if parsed is None:
            return LiveMetricsStore._classify_viewer_intent_with_rules(text)
        return parsed

    @staticmethod
    def _classify_viewer_intent_with_rules(text: str) -> ViewerIntentAnalysis:
        normalized = text.lower()
        high_intent_terms = [
            "how to buy",
            "where to buy",
            "where can i buy",
            "link",
            "cart",
            "order",
            "buy",
            "take one",
            "do you have",
            "do u have",
            "vitamin",
            "vitamin d",
            "vitamin c",
            "vd",
            "vc",
            "discount",
            "coupon",
            "怎么买",
            "哪里拍",
            "上链接",
            "链接",
            "下单",
            "优惠",
            "拍哪里",
            "想买",
        ]
        high_intent = any(term in normalized for term in high_intent_terms)
        if any(term in normalized for term in ["price", "discount", "coupon", "how much", "优惠", "多少钱", "价格"]):
            intent = "ask_price"
        elif any(term in normalized for term in ["size", "fit", "shade", "尺码", "大小", "色号"]):
            intent = "ask_size"
        elif any(term in normalized for term in ["link", "cart", "where to buy", "怎么买", "上链接", "链接", "哪里拍"]):
            intent = "ask_link"
        elif any(term in normalized for term in ["fake", "real", "authentic", "真假", "正品", "靠谱吗"]):
            intent = "authenticity_doubt"
        elif any(term in normalized for term in ["buy", "order", "take one", "want one", "下单", "想买", "来一个"]):
            intent = "purchase_intent"
        elif any(
            term in normalized
            for term in [
                "do you have",
                "do u have",
                "have vitamin",
                "vitamin",
                "vitamin d",
                "vitamin c",
                "vd",
                "vc",
                "available",
                "有维生素",
                "有vd",
            ]
        ):
            intent = "ask_product"
        else:
            intent = "other"
        return ViewerIntentAnalysis(
            intent=intent,
            high_intent=high_intent,
            normalized_question=LiveMetricsStore._normalize_question(text) if intent != "other" else None,
            reason="Fallback lexical intent classifier.",
        )

    @staticmethod
    def _normalize_question(text: str) -> str:
        normalized = re.sub(r"[^\w\s\u4e00-\u9fff]", " ", text.lower())
        normalized = re.sub(r"\s+", " ", normalized).strip()
        replacements = {
            "where can i buy": "where to buy",
            "how do i buy": "how to buy",
            "where to order": "where to buy",
            "上链接": "link please",
            "链接": "link please",
            "怎么买": "how to buy",
            "哪里拍": "where to buy",
        }
        for source, target in replacements.items():
            if source in normalized:
                return target
        return normalized[:80]

    @staticmethod
    def _score_sentiment_with_openai(text: str) -> float:
        client = get_openai_client()
        if client is None:
            return LiveMetricsStore._score_sentiment_with_rules(text)

        try:
            completion = client.beta.chat.completions.parse(
                model=os.getenv("OPENAI_SENTIMENT_MODEL", "gpt-4o-mini"),
                temperature=0,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Score the sentiment of one livestream commerce chat message. "
                            "Return 0 for very negative, 0.5 for neutral/mixed, and 1 for very positive. "
                            "Understand negation and comparisons. For example, 'better than other live streams' "
                            "is positive, while 'not as good as other live streams' is negative."
                        ),
                    },
                    {"role": "user", "content": text},
                ],
                response_format=ViewerSentimentAnalysis,
            )
        except Exception:
            return LiveMetricsStore._score_sentiment_with_rules(text)

        parsed = completion.choices[0].message.parsed
        if parsed is None:
            return LiveMetricsStore._score_sentiment_with_rules(text)
        return parsed.sentiment_score

    @staticmethod
    def _score_sentiment_with_rules(text: str) -> float:
        normalized = text.lower()
        negative_terms = [
            "not as good",
            "bad",
            "worse",
            "expensive",
            "too high",
            "discount",
            "discounts",
            "cheaper",
            "other live",
            "not worth",
            "scam",
            "fake",
            "不划算",
            "太贵",
            "便宜",
            "别家",
            "不好",
            "骗人",
        ]
        positive_terms = [
            "good",
            "great",
            "love",
            "worth",
            "deal",
            "buy",
            "漂亮",
            "喜欢",
            "划算",
            "想要",
        ]
        negative_hits = sum(1 for term in negative_terms if term in normalized)
        positive_hits = sum(1 for term in positive_terms if term in normalized)
        score = 0.62 + positive_hits * 0.12 - negative_hits * 0.18
        return max(0.05, min(0.95, score))

    @staticmethod
    def _delta_percent(current: float, previous: float) -> float:
        if previous <= 0:
            return 100.0 if current > 0 else 0.0
        return ((current - previous) / previous) * 100


live_metrics_store = LiveMetricsStore()
