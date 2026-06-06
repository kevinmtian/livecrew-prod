from collections import defaultdict
from typing import Dict, List, Set

from backend.ledger import append_ledger
from backend.models import CommerceState, ProducerReport
from backend.tools.money import cents_to_display
from backend.tools.reply_grounder import get_sku


def generate_report(state: CommerceState, *, record_ledger: bool = True) -> ProducerReport:
    listed_sku_ids: Set[str] = set()
    for entry in state.ledger:
        if entry.type in ["list_product", "create_flash_sale"] and entry.sku_id:
            listed_sku_ids.add(entry.sku_id)

    product_totals: Dict[str, Dict[str, int]] = defaultdict(lambda: {"units": 0, "gmv_cents": 0})
    for order in state.orders:
        product_totals[order.sku_id]["units"] += order.quantity
        product_totals[order.sku_id]["gmv_cents"] += order.total_price_cents

    per_product: List[Dict] = []
    for sku_id, totals in sorted(product_totals.items()):
        sku = get_sku(state, sku_id)
        per_product.append(
            {
                "sku_id": sku_id,
                "name": sku.name if sku else sku_id,
                "units_sold": totals["units"],
                "gmv_cents": totals["gmv_cents"],
                "gmv": cents_to_display(totals["gmv_cents"]),
            }
        )

    flash_sale = None
    if state.flash_sale:
        sold = state.flash_sale.starting_stock - state.flash_sale.remaining_stock
        flash_sale = {
            "sku_id": state.flash_sale.sku_id,
            "starting_stock": state.flash_sale.starting_stock,
            "remaining_stock": state.flash_sale.remaining_stock,
            "sold": sold,
            "sell_through_percent": round((sold / state.flash_sale.starting_stock) * 100, 1)
            if state.flash_sale.starting_stock
            else 0,
        }

    risk_events = [
        entry for entry in state.ledger if entry.type in ["guardrail_block", "host_confirmation_requested"]
    ]
    host_learning = [
        "Keep product mentions explicit when switching SKUs.",
        "Confirm discounts before sharing them in viewer chat.",
    ]
    if risk_events:
        host_learning.append("Risk events appeared during the stream; review pending-confirmation reasons.")

    report = ProducerReport(
        listed_sku_ids=sorted(listed_sku_ids),
        total_units_sold=state.metrics.total_units_sold,
        total_gmv_cents=state.metrics.total_gmv_cents,
        per_product=per_product,
        flash_sale=flash_sale,
        questions_handled=state.metrics.questions_handled,
        risk_events=len(risk_events),
        host_learning=host_learning,
        next_recommendations=[
            "Lead each segment with the exact product name to improve SKU precision.",
            "Use quantity and time bounds for flash-sale announcements.",
            "Escalate unsupported claims instead of improvising viewer-facing answers.",
        ],
    )

    if record_ledger:
        append_ledger(
            state,
            "report_generated",
            "producer",
            "Generated deterministic post-stream report.",
            None,
            report.model_dump(mode="json"),
        )

    return report
