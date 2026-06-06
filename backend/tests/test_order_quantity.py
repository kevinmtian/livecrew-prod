from __future__ import annotations

import unittest
from copy import deepcopy

from backend.agents.concierge import ExtractedViewerMessage, _build_actions
from backend.commerce import apply_action
from backend.data.catalogue import SEED_CATALOGUE
from backend.metrics import LiveMetricsStore
from backend.models import CommerceState
from backend.policies.guardrails import validate_action
from backend.tools.quantity_extractor import (
    extract_explicit_order_quantity,
    extract_order_quantity,
)


def bamboo_state() -> CommerceState:
    return CommerceState(
        active_sku_id="bamboo-thermal-tumbler",
        skus=deepcopy(SEED_CATALOGUE),
    )


class OrderQuantityTests(unittest.TestCase):
    def test_explicit_quantity_overrides_llm_quantity(self) -> None:
        state = bamboo_state()
        extracted = ExtractedViewerMessage(
            intent="order",
            sku_id=None,
            quantity=1,
            confidence=0.9,
            reason="Simulated LLM quantity mismatch.",
            evidence=["order 55"],
        )

        actions = _build_actions("order 55", "viewer", state, extracted)
        order_action = next(action for action in actions if action.type == "create_order")

        self.assertEqual(order_action.quantity, 55)

    def test_cart_checkout_text_preserves_quantity(self) -> None:
        self.assertEqual(
            extract_explicit_order_quantity(
                "I want to order 55 x Bamboo Thermal Tumbler.",
            ),
            55,
        )

    def test_order_without_explicit_quantity_defaults_to_one(self) -> None:
        self.assertEqual(extract_order_quantity("order Bamboo Thermal Tumbler"), 1)

    def test_order_quantity_drives_stock_and_metrics(self) -> None:
        state = bamboo_state()
        extracted = ExtractedViewerMessage(
            intent="order",
            sku_id=None,
            quantity=1,
            confidence=0.9,
            reason="Simulated LLM quantity mismatch.",
            evidence=["order 55"],
        )
        order_action = next(
            action
            for action in _build_actions("order 55", "viewer", state, extracted)
            if action.type == "create_order"
        )
        guardrail = validate_action(order_action, state)
        applied, _ledger = apply_action(order_action, guardrail, state)

        bamboo = next(sku for sku in state.skus if sku.id == "bamboo-thermal-tumbler")
        metrics = LiveMetricsStore().snapshot(state.orders)

        self.assertIsNotNone(applied)
        self.assertEqual(state.orders[0].quantity, 55)
        self.assertEqual(bamboo.stock, 0)
        self.assertEqual(metrics.gpm_cents, 55 * 1800)

    def test_over_stock_order_is_not_partially_applied(self) -> None:
        state = bamboo_state()
        extracted = ExtractedViewerMessage(
            intent="order",
            sku_id=None,
            quantity=1,
            confidence=0.9,
            reason="Simulated LLM quantity mismatch.",
            evidence=["order 56"],
        )
        actions = _build_actions("order 56", "viewer", state, extracted)

        self.assertEqual(actions[0].type, "request_host_confirmation")
        self.assertEqual(actions[0].quantity, None)
        self.assertEqual(state.orders, [])
        self.assertEqual(
            next(sku for sku in state.skus if sku.id == "bamboo-thermal-tumbler").stock,
            55,
        )


if __name__ == "__main__":
    unittest.main()
