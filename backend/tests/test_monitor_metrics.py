from __future__ import annotations

import unittest

from backend.agents.monitor import analyze_monitor_signals
from backend.metrics import LiveMetricsStore
from backend.models import MonitorSignalRequest


class MonitorMetricsTests(unittest.TestCase):
    def test_order_event_contributes_purchase_intent(self) -> None:
        store = LiveMetricsStore()
        metrics = store.record_viewer_event(
            "viewer-1",
            "order",
            "I want to order 3 x Bamboo Thermal Tumbler.",
        )

        self.assertEqual(metrics.intent_distribution["purchase_intent"], 1)
        self.assertGreaterEqual(metrics.high_intent_density, 1)
        self.assertEqual(metrics.top_question, "checkout order")

    def test_order_activity_beats_hesitation_scenario(self) -> None:
        signal = MonitorSignalRequest(
            online_viewers=12,
            online_viewers_delta=20,
            gpm_cents=9900,
            gpm_delta=10,
            conversion_rate=8.3,
            conversion_rate_delta=8.3,
            comment_sentiment=0.75,
            interaction_rate=12,
            intent_distribution={"purchase_intent": 1},
            high_intent_density=1,
            top_question="checkout order",
            top_question_count=1,
        )
        response = analyze_monitor_signals(signal)

        self.assertEqual(response.scenario.id, "spike_push")
        self.assertEqual(response.scenario.label, "Order momentum")
        self.assertEqual(response.hook.id, "order_push")


if __name__ == "__main__":
    unittest.main()
