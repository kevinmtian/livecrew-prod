from __future__ import annotations

import re

from backend.models import SKU


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", value.lower())).strip()


def resolve_sku_from_text(text: str, skus: list[SKU]) -> SKU | None:
    normalized_text = f" {normalize_text(text)} "
    if not normalized_text.strip():
        return None

    matches: list[tuple[int, SKU]] = []
    for sku in skus:
        phrases = [sku.name, *sku.aliases]
        best = 0
        for phrase in phrases:
            normalized_phrase = normalize_text(phrase)
            if f" {normalized_phrase} " in normalized_text:
                best = max(best, len(normalized_phrase))
        if best:
            matches.append((best, sku))

    matches.sort(key=lambda item: item[0], reverse=True)
    return matches[0][1] if matches else None


def get_sku_by_id(sku_id: str | None, skus: list[SKU]) -> SKU | None:
    if not sku_id:
        return None
    return next((sku for sku in skus if sku.id == sku_id), None)
