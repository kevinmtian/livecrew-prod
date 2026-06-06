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


def get_product_price(state: CommerceState, sku_id: str) -> str:
    sku = get_sku(state, sku_id)
    if not sku:
        return "Price is unavailable because the product is not in the LiveCrew catalogue."
    if is_flash_sale_active_for(state, sku_id) and state.flash_sale:
        return (
            f"{sku.name} regular price is {cents_to_display(sku.current_price_cents)}. "
            f"The verified flash-sale price is {cents_to_display(state.flash_sale.sale_price_cents)} "
            f"while promo stock lasts."
        )
    return f"{sku.name} price is {cents_to_display(sku.current_price_cents)}."


def get_product_stock(state: CommerceState, sku_id: str) -> str:
    sku = get_sku(state, sku_id)
    if not sku:
        return "Stock is unavailable because the product is not in the LiveCrew catalogue."
    if is_flash_sale_active_for(state, sku_id) and state.flash_sale:
        return (
            f"{sku.name} has {sku.stock} units in stock, including "
            f"{state.flash_sale.remaining_stock} flash-sale units left."
        )
    return f"{sku.name} has {sku.stock} units in stock."


def no_such_product_reply(product_name: str) -> str:
    return (
        f"I cannot find {product_name} in the LiveCrew product catalogue. "
        "Please ask about GlowFix Vitamin C Serum, HydraMist Cushion SPF, "
        "Bamboo Thermal Tumbler, or Satin Cloud Sleep Mask."
    )


def basic_product_info_reply(state: CommerceState, sku_id: str, text: str) -> str:
    lowered = text.lower()
    wants_price = any(term in lowered for term in ["price", "cost", "how much", "$"])
    wants_stock = any(term in lowered for term in ["stock", "left", "available", "how many"])

    if wants_price and wants_stock:
        return f"{get_product_price(state, sku_id)} {get_product_stock(state, sku_id)}"
    if wants_price:
        return get_product_price(state, sku_id)
    if wants_stock:
        return get_product_stock(state, sku_id)
    return grounded_product_reply(state, sku_id)


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
