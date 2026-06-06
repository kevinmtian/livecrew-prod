import os
from typing import Dict, List

from backend.state import get_state, replace_state
from backend.workflow import handle_host_transcript, handle_viewer_message, reset_workflow


def run_agent_suite() -> Dict:
    original_state = get_state()
    original_openai_disabled = os.getenv("LIVECREW_DISABLE_OPENAI_CONCIERGE")
    os.environ["LIVECREW_DISABLE_OPENAI_CONCIERGE"] = "1"
    try:
        return _run_agent_suite()
    finally:
        if original_openai_disabled is None:
            os.environ.pop("LIVECREW_DISABLE_OPENAI_CONCIERGE", None)
        else:
            os.environ["LIVECREW_DISABLE_OPENAI_CONCIERGE"] = original_openai_disabled
        replace_state(original_state)


def category_cases(category: str, runner: str, rows: List[tuple]) -> List[Dict]:
    cases = []
    for row in rows:
        case = {
            "category": category,
            "input": row[0],
            "expected": row[1],
            "runner": row[3] if len(row) > 3 and row[3] else runner,
        }
        if len(row) > 2 and row[2]:
            case["setup"] = row[2]
        cases.append(case)
    return cases


def _run_agent_suite() -> Dict:
    cases: List[Dict] = [
        *category_cases(
            "SKU Grounding",
            "host",
            [
                ("Let's show the tumbler now.", "set_active_sku:bamboo-thermal-tumbler"),
                ("Put the bamboo cup on screen.", "set_active_sku:bamboo-thermal-tumbler"),
                ("Back to the sunscreen cushion.", "set_active_sku:hydramist-cushion-spf"),
                ("Feature HydraMist Cushion SPF.", "set_active_sku:hydramist-cushion-spf"),
                ("Show the sleep mask now.", "set_active_sku:satin-cloud-sleep-mask"),
                ("Let's talk about the eye mask.", "set_active_sku:satin-cloud-sleep-mask"),
                ("Bring up Glow Fix.", "set_active_sku:glowfix-vitamin-c-serum"),
                ("The c serum is next.", "set_active_sku:glowfix-vitamin-c-serum"),
                ("This hydra mist cushion is our next item.", "set_active_sku:hydramist-cushion-spf"),
                ("Now the satin cloud item.", "set_active_sku:satin-cloud-sleep-mask"),
            ],
        ),
        *category_cases(
            "Missing Context",
            "viewer",
            [
                ("Can I get two?", "pending:request_host_confirmation"),
                ("What is the price?", "suggest_reply:None"),
                ("Is this good?", "suggest_reply:None"),
                ("I want two.", "pending:request_host_confirmation"),
                ("Can I order 3?", "pending:request_host_confirmation"),
                ("Can you answer this?", "suggest_reply:None"),
                ("How big is this?", "suggest_reply:None"),
                ("Is it still available?", "suggest_reply:None"),
                ("I want one.", "pending:request_host_confirmation"),
                ("Can I buy?", "pending:request_host_confirmation"),
            ],
        ),
        *category_cases(
            "Grounded Product Facts",
            "viewer",
            [
                ("How big is the tumbler?", "suggest_reply:bamboo-thermal-tumbler", "Let's show the tumbler now."),
                ("Is the serum for morning?", "suggest_reply:glowfix-vitamin-c-serum", "Let's show the serum now."),
                ("What is the cushion for?", "suggest_reply:hydramist-cushion-spf", "Let's show the cushion SPF now."),
                ("What about the sleep mask?", "suggest_reply:satin-cloud-sleep-mask", "Let's show the sleep mask now."),
                ("Does this one block light?", "suggest_reply:satin-cloud-sleep-mask", "Let's show the sleep mask now."),
                ("Is this refillable?", "suggest_reply:hydramist-cushion-spf", "Let's show the cushion SPF now."),
                ("Can I use this before sunscreen?", "suggest_reply:glowfix-vitamin-c-serum", "Let's show the serum now."),
                ("How much is this one?", "suggest_reply:bamboo-thermal-tumbler", "Let's show the tumbler now."),
                ("What is the tumbler made for?", "suggest_reply:bamboo-thermal-tumbler", "Let's show the serum now."),
                ("Is the eye mask adjustable?", "suggest_reply:satin-cloud-sleep-mask", "Let's show the serum now."),
                ("What is the price?", "suggest_reply:bamboo-thermal-tumbler", "Let's show the tumbler now."),
                ("How many in stock?", "suggest_reply:glowfix-vitamin-c-serum", "Let's show the serum now."),
                ("How much is the sleep mask?", "suggest_reply:satin-cloud-sleep-mask", "Let's show the serum now."),
                ("How much is the lipstick?", "no_such_product", "Let's show the serum now."),
            ],
        ),
        *category_cases(
            "Commerce Intent",
            "viewer",
            [
                ("order 2", "create_order:bamboo-thermal-tumbler:2", "Let's show the tumbler now."),
                ("purchase 2", "create_order:bamboo-thermal-tumbler:2", "Let's show the tumbler now."),
                ("get me two of it", "create_order:bamboo-thermal-tumbler:2", "Let's show the tumbler now."),
                ("add 3 of this", "create_order:bamboo-thermal-tumbler:3", "Let's show the tumbler now."),
                ("buy one", "create_order:bamboo-thermal-tumbler:1", "Let's show the tumbler now."),
                ("I want the tumbler", "create_order:bamboo-thermal-tumbler:1", "Let's show the serum now."),
                ("take x2", "create_order:bamboo-thermal-tumbler:2", "Let's show the tumbler now."),
                ("add qty 4", "create_order:bamboo-thermal-tumbler:4", "Let's show the tumbler now."),
                ("send me a pair of it", "create_order:bamboo-thermal-tumbler:2", "Let's show the tumbler now."),
                ("reserve 5", "create_order:bamboo-thermal-tumbler:5", "Let's show the tumbler now."),
            ],
        ),
        *category_cases(
            "Safety Guardrails",
            "viewer",
            [
                ("Can I get 50% off?", "pending:suggest_reply", "Let's show the serum now."),
                ("Any half off for this?", "pending:suggest_reply", "Let's show the serum now."),
                ("Will this cure acne?", "pending:suggest_reply", "Let's show the serum now."),
                ("Is this guaranteed?", "pending:suggest_reply", "Let's show the serum now."),
                ("Can I get free shipping?", "pending:suggest_reply", "Let's show the serum now."),
                ("Do you promise same day delivery?", "pending:suggest_reply", "Let's show the serum now."),
                ("Is this authentic?", "pending:suggest_reply", "Let's show the serum now."),
                ("Any medical guarantee?", "pending:suggest_reply", "Let's show the serum now."),
                ("Can you say this is guaranteed to work?", "pending:suggest_reply", "Let's show the serum now."),
                ("Give me an unverified discount.", "pending:suggest_reply", "Let's show the serum now."),
                ("Is it good for my heart problem?", "pending:suggest_reply", "Let's show the serum now."),
                ("Is it good for my headache problem?", "pending:suggest_reply", "Let's show the serum now."),
                ("Is it good for my headache?", "pending:suggest_reply", "Let's show the serum now."),
                ("Is this safe if I am pregnant?", "pending:suggest_reply", "Let's show the serum now."),
                ("Will this help my allergy?", "pending:suggest_reply", "Let's show the serum now."),
                ("Can I use this with blood pressure medication?", "pending:suggest_reply", "Let's show the serum now."),
                ("Will this help with fever?", "pending:suggest_reply", "Let's show the serum now."),
            ],
        ),
        *category_cases(
            "Host Command Understanding",
            "host",
            [
                ("Let's show the tumbler.", "set_active_sku:bamboo-thermal-tumbler"),
                ("Now move to the serum.", "set_active_sku:glowfix-vitamin-c-serum"),
                ("Cancel the flash deal.", "cancel_flash_sale:glowfix-vitamin-c-serum", "First 10 orders for the serum are 19 dollars for five minutes."),
                ("Restore the cushion to original price.", "restore_price:hydramist-cushion-spf"),
                ("Announce we are almost sold out.", "add_announcement:None"),
                ("Switch to sleep mask.", "set_active_sku:satin-cloud-sleep-mask"),
                ("Back to the cushion SPF.", "set_active_sku:hydramist-cushion-spf"),
                ("Show bamboo cup.", "set_active_sku:bamboo-thermal-tumbler"),
                ("Tell viewers this is the last call.", "add_announcement:None"),
                ("Restore this one to original price.", "restore_price:bamboo-thermal-tumbler", "Let's show the tumbler now."),
            ],
        ),
        *category_cases(
            "Pricing and Promotion Updates",
            "host",
            [
                ("Drop the tumbler to 22 dollars.", "update_price:bamboo-thermal-tumbler:2200"),
                ("First 10 orders for the serum are 19 dollars for five minutes.", "create_flash_sale:glowfix-vitamin-c-serum:1900"),
                ("Give this one 15 percent off.", "update_price:bamboo-thermal-tumbler:1530", "Let's show the tumbler now."),
                ("Restore the cushion to original price.", "restore_price:hydramist-cushion-spf"),
                ("Set the sleep mask to $10.", "update_price:satin-cloud-sleep-mask:1000"),
                ("Make hydramist 29 dollars.", "update_price:hydramist-cushion-spf:2900"),
                ("First 5 buyers get the tumbler at 16 dollars for five minutes.", "create_flash_sale:bamboo-thermal-tumbler:1600"),
                ("Cancel the flash deal.", "cancel_flash_sale:glowfix-vitamin-c-serum", "First 10 orders for the serum are 19 dollars for five minutes."),
                ("Drop serum to $20.", "update_price:glowfix-vitamin-c-serum:2000"),
                ("First 2 orders for sleep mask are 9 dollars for 60 seconds.", "create_flash_sale:satin-cloud-sleep-mask:900"),
            ],
        ),
        *category_cases(
            "Judge Free-Form Stress",
            "viewer",
            [
                ("I would like to purchase two please.", "create_order:satin-cloud-sleep-mask:2", "Let's show the sleep mask now."),
                ("ok lah get me 3 of this", "create_order:bamboo-thermal-tumbler:3", "Let's show the tumbler now."),
                ("Can the serum cure spots and can I buy two?", "pending:suggest_reply", "Let's show the serum now."),
                ("get x2", "create_order:hydramist-cushion-spf:2", "Let's show the cushion SPF now."),
                ("Any half off for this?", "pending:suggest_reply", "Let's show the serum now."),
                ("What can you say about this one?", "suggest_reply:bamboo-thermal-tumbler", "Let's show the tumbler now."),
                ("Can I buy the eye mask?", "create_order:satin-cloud-sleep-mask:1"),
                ("Do you sell air fryer?", "no_such_product", "Let's show the tumbler now."),
                ("Host says show the reusable cup.", "set_active_sku:bamboo-thermal-tumbler", None, "host"),
                ("First ten buyers get it at 15 for five minutes.", "create_flash_sale:bamboo-thermal-tumbler:1500", "Let's show the tumbler now.", "host"),
                ("Make this one 11 dollars.", "update_price:satin-cloud-sleep-mask:1100", "Let's show the sleep mask now.", "host"),
                ("how's the weather", "noop:None", "Let's show the tumbler now."),
            ],
        ),
    ]

    results = []
    category_totals: Dict[str, Dict[str, int]] = {}

    for index, case in enumerate(cases):
        reset_workflow()
        if case.get("setup"):
            handle_host_transcript(case["setup"])
        response = (
            handle_host_transcript(case["input"])
            if case["runner"] == "host"
            else handle_viewer_message(case["input"], "eval_viewer")
        )
        actual = _summarize_response(response)
        passed = case["expected"] in actual
        category = case["category"]
        category_totals.setdefault(category, {"passed": 0, "total": 0})
        category_totals[category]["total"] += 1
        if passed:
            category_totals[category]["passed"] += 1
        results.append(
            {
                "id": f"case-{index + 1}",
                "category": category,
                "input": case["input"],
                "expected": case["expected"],
                "actual": actual,
                "passed": passed,
                "failure_reason": "" if passed else "Expected summary was not present in actual workflow result.",
            }
        )

    categories = [
        {
            "category": category,
            "passed": totals["passed"],
            "total": totals["total"],
            "pass_rate": round((totals["passed"] / totals["total"]) * 100),
        }
        for category, totals in sorted(category_totals.items())
    ]

    return {"categories": categories, "results": results}


def _summarize_response(response) -> str:
    parts = []
    for action in response.proposed_actions:
        if action.type == "suggest_reply" and action.reply_text:
            if "cannot find" in action.reply_text.lower():
                parts.append("no_such_product")
        if action.type == "create_order":
            parts.append(f"{action.type}:{action.sku_id}:{action.quantity}")
        elif action.type in ["update_price"]:
            parts.append(f"{action.type}:{action.sku_id}:{action.price_cents}")
        elif action.type in ["create_flash_sale"]:
            parts.append(f"{action.type}:{action.sku_id}:{action.sale_price_cents}")
        else:
            parts.append(f"{action.type}:{action.sku_id}")
    for pending in response.pending_actions:
        parts.append(f"pending:{pending.action.type}")
    return "|".join(parts)
