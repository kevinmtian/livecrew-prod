export type SkuId =
  | "glowfix-vitamin-c-serum"
  | "hydramist-cushion-spf"
  | "bamboo-thermal-tumbler"
  | "satin-cloud-sleep-mask";

export type CommerceSku = {
  id: SkuId;
  name: string;
  aliases: string[];
  price: string;
  stock: number;
  facts: string[];
};

export type ActiveSkuDisplay = {
  id: SkuId;
  name: string;
  price: string;
  stock: number;
  stockLabel: string;
  facts: string[];
  aliases: string[];
};

export const commerceCatalogue: CommerceSku[] = [
  {
    id: "glowfix-vitamin-c-serum",
    name: "GlowFix Vitamin C Serum",
    aliases: [
      "glowfix",
      "glow fix",
      "glowfix serum",
      "vitamin c serum",
      "c serum",
      "serum",
    ],
    price: "$24.00",
    stock: 42,
    facts: [
      "Brightening serum in a 30 ml bottle",
      "Designed for morning skincare routines",
      "Use before moisturizer and sunscreen",
    ],
  },
  {
    id: "hydramist-cushion-spf",
    name: "HydraMist Cushion SPF",
    aliases: [
      "hydramist",
      "hydra mist",
      "hydramist cushion",
      "hydra mist cushion",
      "cushion spf",
      "spf cushion",
    ],
    price: "$31.00",
    stock: 28,
    facts: [
      "SPF cushion compact with a dewy finish",
      "Comes in a refillable case",
      "Built for quick touch-ups during the day",
    ],
  },
  {
    id: "bamboo-thermal-tumbler",
    name: "Bamboo Thermal Tumbler",
    aliases: [
      "bamboo tumbler",
      "thermal tumbler",
      "bamboo thermal",
      "tumbler",
      "cup",
      "bottle",
    ],
    price: "$18.00",
    stock: 55,
    facts: [
      "500 ml capacity",
      "Thermal insulation for hot or cold drinks",
      "Bamboo exterior with a reusable design",
    ],
  },
  {
    id: "satin-cloud-sleep-mask",
    name: "Satin Cloud Sleep Mask",
    aliases: [
      "satin cloud",
      "sleep mask",
      "satin sleep mask",
      "cloud mask",
      "eye mask",
      "mask",
    ],
    price: "$12.00",
    stock: 64,
    facts: [
      "Soft satin-feel sleep mask",
      "Adjustable strap for fit",
      "Blocks ambient light during rest",
    ],
  },
];

export const defaultActiveSkuId: SkuId = "glowfix-vitamin-c-serum";

export function normalizeProductText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function resolveSkuById(skuId: string | null | undefined): CommerceSku | null {
  if (!skuId) {
    return null;
  }

  return commerceCatalogue.find((sku) => sku.id === skuId) ?? null;
}

export function resolveSkuByName(name: string): CommerceSku | null {
  const normalizedName = normalizeProductText(name);

  return (
    commerceCatalogue.find(
      (sku) => normalizeProductText(sku.name) === normalizedName,
    ) ?? null
  );
}

export function resolveSkuByAlias(alias: string): CommerceSku | null {
  const normalizedAlias = normalizeProductText(alias);

  return (
    commerceCatalogue.find((sku) =>
      sku.aliases.some(
        (skuAlias) => normalizeProductText(skuAlias) === normalizedAlias,
      ),
    ) ?? null
  );
}

export function resolveSkuFromText(text: string): CommerceSku | null {
  const normalizedText = ` ${normalizeProductText(text)} `;

  if (!normalizedText.trim()) {
    return null;
  }

  const matches = commerceCatalogue
    .map((sku) => {
      const phrases = [sku.name, ...sku.aliases].map(normalizeProductText);
      const bestMatchLength = phrases.reduce((best, phrase) => {
        const paddedPhrase = ` ${phrase} `;

        if (normalizedText.includes(paddedPhrase)) {
          return Math.max(best, phrase.length);
        }

        return best;
      }, 0);

      return { sku, bestMatchLength };
    })
    .filter((match) => match.bestMatchLength > 0)
    .sort((a, b) => b.bestMatchLength - a.bestMatchLength);

  return matches[0]?.sku ?? null;
}

export function getActiveSku(activeSkuId: string | null | undefined): CommerceSku {
  return (
    resolveSkuById(activeSkuId) ??
    resolveSkuById(defaultActiveSkuId) ??
    commerceCatalogue[0]
  );
}

export function getActiveSkuDisplay(
  activeSkuId: string | null | undefined,
): ActiveSkuDisplay {
  const sku = getActiveSku(activeSkuId);

  return {
    id: sku.id,
    name: sku.name,
    price: sku.price,
    stock: sku.stock,
    stockLabel: `${sku.stock} in stock`,
    facts: sku.facts,
    aliases: sku.aliases,
  };
}
