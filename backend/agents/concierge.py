import re
from typing import List, Optional

from backend.agents.openai_concierge import analyze_viewer_message_with_openai
from backend.models import AgentDecision, CommerceState, ProposedAction
from backend.tools.quantity_extractor import (
    extract_quantity,
    has_order_intent,
    order_quantity_or_default,
)
from backend.tools.reply_grounder import (
    basic_product_info_reply,
    no_such_product_reply,
    safe_promo_reply,
)
from backend.tools.sku_resolver import normalize_text, resolve_sku_from_text, resolve_with_context


PROMO_TERMS = ["discount", "promo", "promotion", "deal", "cheaper", "50%", "half off"]
REQUESTED_DISCOUNT_RE = re.compile(
    r"\b(?:[1-9]\d?)\s?%\s*(?:off|discount)?\b"
    r"|\bhalf\s+off\b"
    r"|\b(?:give|get|have|offer|make|do|can i|could i|may i)\b.{0,32}\b(?:discount|off|cheaper)\b"
)
HEALTH_RISK_RE = re.compile(
    r"\b(?:heart|cardiac|blood pressure|diabetes|diabetic|pregnant|pregnancy|"
    r"allergy|allergic|rash|eczema|headache|migraine|fever|cough|cold|flu|"
    r"nausea|dizzy|dizziness|asthma|skin problem|health problem|medical condition|"
    r"condition|medication|medicine|treatment|disease|illness|pain|infection)\b"
    r"|\b(?:good|safe|okay|ok|suitable|help|work)\b.{0,40}\b(?:problem|condition)\b"
    r"|\b(?:problem|condition)\b.{0,40}\b(?:good|safe|okay|ok|suitable|help|work)\b"
)
SAFETY_TERMS = [
    "cure",
    "acne",
    "allergic",
    "allergy",
    "blood pressure",
    "diabetes",
    "diabetic",
    "disease",
    "eczema",
    "heart",
    "headache",
    "health problem",
    "illness",
    "infection",
    "medical",
    "medication",
    "medicine",
    "pain",
    "pregnancy",
    "pregnant",
    "rash",
    "migraine",
    "fever",
    "cough",
    "cold",
    "flu",
    "nausea",
    "dizzy",
    "dizziness",
    "asthma",
    "treatment",
    "condition",
    "skin problem",
    "guarantee",
    "authentic",
    "delivery",
    "free shipping",
]
QUESTION_TERMS = ["?", "is", "how", "what", "can", "will", "do", "does", "size", "big", "morning", "night"]
IRRELEVANT_TERMS = ["weather", "sad", "football", "movie", "politics", "homework"]
UNKNOWN_PRODUCT_TERMS = [
    "air fryer",
    "camera",
    "cleanser",
    "dress",
    "foundation",
    "headphones",
    "iphone",
    "laptop",
    "lipstick",
    "perfume",
    "phone",
    "shampoo",
    "watch",
]
UNKNOWN_PRODUCT_PATTERNS = [
    r"\b(?:do you have|do you sell|carry|stock|show me|what about|how much is|price of|is the|can i buy)\s+(?:the\s+)?([a-z0-9][a-z0-9 ]{1,40})",
]
GENERIC_PRODUCT_REFERENCES = {
    "it",
    "this",
    "this one",
    "that one",
    "one",
    "price",
    "stock",
    "available",
    "good",
    "still available",
}


def _policy_review_reply() -> str:
    return (
        "Based on our policy, I can only share verified product facts and approved "
        "promos. I will ask the host to review this before replying."
    )


def _is_requested_discount(text: str) -> bool:
    return bool(REQUESTED_DISCOUNT_RE.search(normalize_text(text)))


def _is_health_risk_question(text: str) -> bool:
    return bool(HEALTH_RISK_RE.search(normalize_text(text)))


def _safety_evidence(text: str) -> List[str]:
    normalized = normalize_text(text)
    evidence = [term for term in SAFETY_TERMS if term in normalized]
    if _is_health_risk_question(text) and "health-risk phrasing" not in evidence:
        evidence.append("health-risk phrasing")
    return evidence


def _explicit_unknown_product(text: str, has_catalogue_match: bool) -> Optional[str]:
    if has_catalogue_match:
        return None

    normalized = normalize_text(text)
    for term in UNKNOWN_PRODUCT_TERMS:
        if f" {term} " in f" {normalized} ":
            return term

    for pattern in UNKNOWN_PRODUCT_PATTERNS:
        match = re.search(pattern, normalized)
        if not match:
            continue
        candidate = normalize_text(match.group(1))
        candidate = re.split(
            r"\b(?:and|or|for|with|today|now|please|in stock|available)\b",
            candidate,
        )[0].strip()
        if candidate and candidate not in GENERIC_PRODUCT_REFERENCES:
            return candidate

    return None


def analyze_viewer_message(
    state: CommerceState,
    text: str,
    viewer: str,
) -> tuple[List[AgentDecision], List[ProposedAction]]:
    rule_decisions, rule_actions = analyze_viewer_message_rules(state, text, viewer)
    openai_result = analyze_viewer_message_with_openai(state, text, viewer)
    if not openai_result:
        return rule_decisions, rule_actions

    openai_decisions, openai_actions = openai_result
    return _merge_concierge_results(
        rule_decisions,
        rule_actions,
        openai_decisions,
        openai_actions,
    )


def _merge_concierge_results(
    rule_decisions: List[AgentDecision],
    rule_actions: List[ProposedAction],
    openai_decisions: List[AgentDecision],
    openai_actions: List[ProposedAction],
) -> tuple[List[AgentDecision], List[ProposedAction]]:
    decisions = rule_decisions + openai_decisions
    actions = rule_actions + openai_actions

    priority_checks = [
        _is_risky_reply_action,
        _is_unknown_product_action,
        _is_confirmation_action,
        lambda action: action.type == "create_order",
        _is_promo_reply_action,
        _is_product_reply_action,
        lambda action: action.type == "noop",
    ]
    for check in priority_checks:
        selected = [action for action in actions if check(action)]
        if selected:
            return decisions, [_prefer_rule_action(selected)]

    return decisions, actions[:1]


def _prefer_rule_action(actions: List[ProposedAction]) -> ProposedAction:
    return next(
        (
            action
            for action in actions
            if not any(str(item).startswith("openai") for item in action.evidence)
        ),
        actions[0],
    )


def _is_risky_reply_action(action: ProposedAction) -> bool:
    if action.type != "suggest_reply":
        return False
    reason = (action.reason or "").lower()
    return action.requires_host_confirmation or any(
        term in reason for term in ["risky", "safety", "health", "medical", "unsupported", "discount"]
    )


def _is_unknown_product_action(action: ProposedAction) -> bool:
    return action.type == "suggest_reply" and "cannot find" in (action.reply_text or "").lower()


def _is_confirmation_action(action: ProposedAction) -> bool:
    return action.type == "request_host_confirmation" or action.requires_host_confirmation


def _is_promo_reply_action(action: ProposedAction) -> bool:
    reason = (action.reason or "").lower()
    return action.type == "suggest_reply" and "promotion" in reason


def _is_product_reply_action(action: ProposedAction) -> bool:
    return action.type == "suggest_reply"


def analyze_viewer_message_rules(
    state: CommerceState,
    text: str,
    viewer: str,
) -> tuple[List[AgentDecision], List[ProposedAction]]:
    lowered = text.lower()
    explicit_resolution = resolve_sku_from_text(text, state.skus)
    resolution = resolve_with_context(text, state.skus, state.active_sku_id)
    raw_quantity = extract_quantity(text)
    quantity = order_quantity_or_default(text)
    promo_request = any(term in lowered for term in PROMO_TERMS)
    safety_evidence = _safety_evidence(text)
    safety_request = bool(safety_evidence)
    is_question = any(term in lowered for term in QUESTION_TERMS)
    unknown_product = _explicit_unknown_product(text, explicit_resolution.sku_id is not None)
    resolved_sku_id = resolution.sku_id
    resolution_evidence = list(resolution.evidence)
    decisions: List[AgentDecision] = []
    actions: List[ProposedAction] = []

    if any(term in lowered for term in IRRELEVANT_TERMS):
        return [
            AgentDecision(
                agent="concierge",
                intent="irrelevant",
                confidence=0.8,
                reason="Viewer message is unrelated to the livestream commerce flow.",
                evidence=[term for term in IRRELEVANT_TERMS if term in lowered],
            )
        ], [
            ProposedAction(
                type="noop",
                source_text=text,
                confidence=0.8,
                reason="No viewer reply should be sent for irrelevant messages.",
                evidence=[term for term in IRRELEVANT_TERMS if term in lowered],
            )
        ]

    if unknown_product and is_question:
        actions.append(
            ProposedAction(
                type="suggest_reply",
                sku_id=None,
                reply_text=no_such_product_reply(unknown_product),
                source_text=text,
                confidence=0.82,
                reason="Viewer explicitly mentioned a product that is not in the seeded SKU catalogue.",
                evidence=[unknown_product],
            )
        )
        decisions.append(
            AgentDecision(
                agent="concierge",
                intent="unknown_product",
                confidence=0.82,
                reason="No seeded SKU matched the explicit product mention.",
                evidence=[unknown_product],
            )
        )
        return decisions, actions

    if _is_requested_discount(text):
        discount_evidence = [match.group(0) for match in REQUESTED_DISCOUNT_RE.finditer(normalize_text(text))]
        sku_id = explicit_resolution.sku_id or resolution.sku_id or state.active_sku_id
        evidence = (
            explicit_resolution.evidence
            or resolution.evidence
            or (["pinned SKU context"] if state.active_sku_id else [])
        )
        actions.append(
            ProposedAction(
                type="suggest_reply",
                sku_id=sku_id,
                reply_text=_policy_review_reply(),
                source_text=text,
                confidence=0.8,
                reason="Viewer requested an unverified discount that needs host review.",
                evidence=evidence + discount_evidence,
                requires_host_confirmation=True,
            )
        )
        decisions.append(
            AgentDecision(
                agent="concierge",
                intent="risky_discount_request",
                confidence=0.8,
                reason="Detected a viewer-requested discount rather than a factual promo question.",
                evidence=evidence + discount_evidence,
            )
        )
        return decisions, actions

    if safety_request:
        actions.append(
            ProposedAction(
                type="suggest_reply",
                sku_id=resolution.sku_id or state.active_sku_id,
                reply_text=_policy_review_reply(),
                source_text=text,
                confidence=0.7,
                reason="Viewer asked for an unsupported safety, authenticity, delivery, or medical claim.",
                evidence=safety_evidence,
                requires_host_confirmation=True,
            )
        )
        decisions.append(
            AgentDecision(
                agent="concierge",
                intent="risky_safety_question",
                confidence=0.7,
                reason="Detected a viewer safety or health question that needs host review.",
                evidence=safety_evidence,
            )
        )
        return decisions, actions

    if has_order_intent(text) and not (
        (promo_request or safety_request) and raw_quantity is None
    ):
        if not resolved_sku_id and state.active_sku_id:
            resolved_sku_id = state.active_sku_id
            resolution_evidence.append("active SKU context")

        if resolved_sku_id and quantity:
            actions.append(
                ProposedAction(
                    type="create_order",
                    sku_id=resolved_sku_id,
                    quantity=quantity,
                    source_text=text,
                    confidence=0.86 if not resolution.used_active_context else 0.76,
                    reason=f"{viewer} used clear order language and quantity was resolved.",
                    evidence=resolution_evidence + [str(quantity)],
                )
            )
            decisions.append(
                AgentDecision(
                    agent="concierge",
                    intent="create_order",
                    confidence=0.86,
                    reason="Detected viewer order intent with quantity.",
                    evidence=resolution_evidence + [str(quantity)],
                )
            )
        else:
            actions.append(
                ProposedAction(
                    type="request_host_confirmation",
                    sku_id=resolution.sku_id,
                    quantity=quantity,
                    source_text=text,
                    confidence=0.52,
                    reason="Viewer order is missing SKU context or quantity.",
                    evidence=resolution.evidence,
                    requires_host_confirmation=True,
                )
            )

    if promo_request:
        promo_sku_id = explicit_resolution.sku_id or state.active_sku_id
        actions.append(
            ProposedAction(
                type="suggest_reply",
                sku_id=promo_sku_id,
                reply_text=safe_promo_reply(state, promo_sku_id),
                source_text=text,
                confidence=0.78,
                reason="Viewer asked about a promotion; reply cites only verified backend promo state.",
                evidence=explicit_resolution.evidence or ["pinned SKU context"],
                requires_host_confirmation=state.flash_sale is None,
            )
        )
        decisions.append(
            AgentDecision(
                agent="concierge",
                intent="promo_request",
                confidence=0.78,
                reason="Detected promotion request and avoided inventing a discount.",
                evidence=explicit_resolution.evidence or ["pinned SKU context"],
            )
        )

    if is_question and not (promo_request or safety_request):
        if has_order_intent(text):
            pass
        else:
            question_sku_id = explicit_resolution.sku_id or resolution.sku_id or state.active_sku_id
            question_evidence = (
                explicit_resolution.evidence
                or resolution.evidence
                or (["pinned SKU context"] if state.active_sku_id else [])
            )
        if has_order_intent(text):
            pass
        elif question_sku_id:
            actions.append(
                ProposedAction(
                    type="suggest_reply",
                    sku_id=question_sku_id,
                    reply_text=basic_product_info_reply(state, question_sku_id, text),
                    source_text=text,
                    confidence=0.84 if explicit_resolution.sku_id else 0.76,
                    reason=(
                        "Viewer asked a product question; explicit SKU mention wins, "
                        "otherwise the pinned SKU is used without changing it."
                    ),
                    evidence=question_evidence,
                )
            )
            decisions.append(
                AgentDecision(
                    agent="concierge",
                    intent="product_fact",
                    confidence=0.84 if explicit_resolution.sku_id else 0.76,
                    reason="Resolved viewer question to grounded catalogue and backend commerce state.",
                    evidence=question_evidence,
                )
            )
        else:
            actions.append(
                ProposedAction(
                    type="suggest_reply",
                    sku_id=None,
                    reply_text="Which product are you referring to?",
                    source_text=text,
                    confidence=0.5,
                    reason="Viewer question is missing product context.",
                    evidence=[],
                )
            )

    if not actions:
        actions.append(
            ProposedAction(
                type="noop",
                source_text=text,
                confidence=0.65,
                reason="Viewer message did not match a supported commerce or product-help intent.",
            )
        )
        decisions.append(
            AgentDecision(
                agent="concierge",
                intent="noop",
                confidence=0.65,
                reason="No supported viewer action was detected.",
                evidence=[],
            )
        )

    return decisions, actions
