import re
from dataclasses import dataclass
from typing import List, Optional

from backend.models import SKU


CONTEXT_TERMS = [
    "it",
    "this",
    "this one",
    "current product",
    "active product",
    "that one",
]


@dataclass
class SkuResolution:
    sku_id: Optional[str]
    confidence: float
    evidence: List[str]
    ambiguous: bool = False
    used_active_context: bool = False


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", value.lower())).strip()


def resolve_sku_from_text(text: str, skus: List[SKU]) -> SkuResolution:
    normalized = " " + normalize_text(text) + " "
    matches = []

    if not normalized.strip():
        return SkuResolution(None, 0.0, [])

    for sku in skus:
        phrases = [sku.name] + sku.aliases
        best_phrase = ""
        for phrase in phrases:
            normalized_phrase = normalize_text(phrase)
            if normalized_phrase and " " + normalized_phrase + " " in normalized:
                if len(normalized_phrase) > len(best_phrase):
                    best_phrase = normalized_phrase
        if best_phrase:
            matches.append((sku, best_phrase))

    matches.sort(key=lambda item: len(item[1]), reverse=True)

    if len(matches) >= 2 and len(matches[0][1]) == len(matches[1][1]):
        return SkuResolution(
            None,
            0.45,
            [matches[0][1], matches[1][1]],
            ambiguous=True,
        )

    if matches:
        return SkuResolution(matches[0][0].id, 0.94, [matches[0][1]])

    return SkuResolution(None, 0.0, [])


def resolve_with_context(
    text: str,
    skus: List[SKU],
    active_sku_id: Optional[str],
) -> SkuResolution:
    explicit = resolve_sku_from_text(text, skus)
    if explicit.sku_id or explicit.ambiguous:
        return explicit

    normalized = " " + normalize_text(text) + " "
    context_hit = next(
        (term for term in CONTEXT_TERMS if " " + normalize_text(term) + " " in normalized),
        None,
    )
    if context_hit and active_sku_id:
        return SkuResolution(
            active_sku_id,
            0.72,
            [context_hit],
            used_active_context=True,
        )

    return explicit
