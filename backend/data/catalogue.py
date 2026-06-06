from copy import deepcopy
from typing import List

from backend.models import SKU


SEED_CATALOGUE: List[SKU] = [
    SKU(
        id="glowfix-vitamin-c-serum",
        name="GlowFix Vitamin C Serum",
        aliases=[
            "glowfix",
            "glow fix",
            "glowfix serum",
            "vitamin c serum",
            "c serum",
            "serum",
        ],
        base_price_cents=2400,
        current_price_cents=2400,
        stock=42,
        facts=[
            "Brightening serum in a 30 ml bottle",
            "Designed for morning skincare routines",
            "Use before moisturizer and sunscreen",
        ],
    ),
    SKU(
        id="hydramist-cushion-spf",
        name="HydraMist Cushion SPF",
        aliases=[
            "hydramist",
            "hydra mist",
            "hydramist cushion",
            "hydra mist cushion",
            "cushion spf",
            "spf cushion",
            "sunscreen cushion",
            "cushion",
        ],
        base_price_cents=3100,
        current_price_cents=3100,
        stock=28,
        facts=[
            "SPF cushion compact with a dewy finish",
            "Comes in a refillable case",
            "Built for quick touch-ups during the day",
        ],
    ),
    SKU(
        id="bamboo-thermal-tumbler",
        name="Bamboo Thermal Tumbler",
        aliases=[
            "bamboo tumbler",
            "thermal tumbler",
            "bamboo thermal",
            "tumbler",
            "cup",
            "bottle",
        ],
        base_price_cents=1800,
        current_price_cents=1800,
        stock=55,
        facts=[
            "500 ml capacity",
            "Thermal insulation for hot or cold drinks",
            "Bamboo exterior with a reusable design",
        ],
    ),
    SKU(
        id="satin-cloud-sleep-mask",
        name="Satin Cloud Sleep Mask",
        aliases=[
            "satin cloud",
            "sleep mask",
            "satin sleep mask",
            "cloud mask",
            "eye mask",
            "mask",
        ],
        base_price_cents=1200,
        current_price_cents=1200,
        stock=64,
        facts=[
            "Soft satin-feel sleep mask",
            "Adjustable strap for fit",
            "Blocks ambient light during rest",
        ],
    ),
]


def fresh_catalogue() -> List[SKU]:
    return deepcopy(SEED_CATALOGUE)
