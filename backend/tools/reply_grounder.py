from typing import Optional

from backend.models import CommerceState, SKU
from backend.tools.money import cents_to_display


def get_sku(state: CommerceState, sku_id: Optional[str]) -> Optional[SKU]:
    if not sku_id:
        return None
    return next((sku for sku in state.skus if sku.id == sku_id), None)


def is_flash_sale_active_for(state: CommerceState, sku_id: str) -> bool:
    sale = state.flash_sale
    return bool(sale and sale.active and sale.sku_id == sku_id and sale.remaining_stock > 0)


def grounded_product_reply(state: CommerceState, sku_id: str) -> str:
    sku = get_sku(state, sku_id)
    if not sku:
        return "I need the host to confirm which product you mean before answering."

    facts = "; ".join(sku.facts)
    price = cents_to_display(sku.current_price_cents)
    if is_flash_sale_active_for(state, sku_id) and state.flash_sale:
        sale_price = cents_to_display(state.flash_sale.sale_price_cents)
        return (
            f"{sku.name}: {facts}. Current regular price is {price}. "
            f"There is a verified flash sale at {sale_price} with "
            f"{state.flash_sale.remaining_stock} promo units left."
        )

    return f"{sku.name}: {facts}. Current price is {price}, with {sku.stock} in stock."


def safe_promo_reply(state: CommerceState, sku_id: Optional[str]) -> str:
    sku = get_sku(state, sku_id)
    if sku and is_flash_sale_active_for(state, sku.id) and state.flash_sale:
        return (
            f"The verified promo for {sku.name} is "
            f"{cents_to_display(state.flash_sale.sale_price_cents)} while promo stock lasts."
        )
    if sku:
        return f"I cannot offer an unverified discount for {sku.name}. I will ask the host to confirm any promotion."
    return "I cannot offer an unverified discount. I will ask the host to confirm any promotion."
