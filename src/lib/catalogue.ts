export type ProductSku = {
  id: string;
  name: string;
  aliases: string[];
  price: string;
  stock: number;
  facts: string[];
};

export const productCatalogue: ProductSku[] = [
  {
    id: "sku-glowfix-vitamin-c-serum",
    name: "GlowFix Vitamin C Serum",
    aliases: ["glowfix", "vitamin c serum", "vit c serum", "glow serum"],
    price: "$42",
    stock: 118,
    facts: [
      "15% vitamin C brightening serum",
      "Fragrance-free lightweight gel texture",
      "Recommended for morning use before sunscreen",
    ],
  },
  {
    id: "sku-hydramist-cushion-spf",
    name: "HydraMist Cushion SPF",
    aliases: ["hydramist", "cushion spf", "spf cushion", "mist cushion"],
    price: "$36",
    stock: 92,
    facts: [
      "SPF 50 cushion compact with dewy finish",
      "Refillable case with mirror and puff",
      "Best for quick touch-ups during the day",
    ],
  },
  {
    id: "sku-bamboo-thermal-tumbler",
    name: "Bamboo Thermal Tumbler",
    aliases: ["bamboo tumbler", "thermal tumbler", "tumbler", "bamboo cup"],
    price: "$28",
    stock: 164,
    facts: [
      "Double-wall insulated stainless steel core",
      "Bamboo-look exterior sleeve",
      "Keeps drinks hot or cold for daily carry",
    ],
  },
  {
    id: "sku-satin-cloud-sleep-mask",
    name: "Satin Cloud Sleep Mask",
    aliases: ["satin mask", "sleep mask", "cloud mask", "satin cloud"],
    price: "$19",
    stock: 246,
    facts: [
      "Soft satin sleep mask with cushioned fill",
      "Adjustable elastic strap",
      "Designed to block light without pressure on eyes",
    ],
  },
];

export const activeSkuId = "sku-glowfix-vitamin-c-serum";

function normalizeSkuText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function getProductBySkuId(skuId: string) {
  return productCatalogue.find((sku) => sku.id === skuId);
}

export function getProductNameBySkuId(skuId: string) {
  return getProductBySkuId(skuId)?.name;
}

export function resolveSkuFromText(text: string) {
  const normalizedText = normalizeSkuText(text);

  return productCatalogue.find((sku) => {
    const terms = [sku.id, sku.name, ...sku.aliases].map(normalizeSkuText);
    return terms.some((term) => normalizedText.includes(term));
  });
}

export function getActiveSkuDisplay(skuId = activeSkuId) {
  const sku = getProductBySkuId(skuId) ?? productCatalogue[0];

  return {
    id: sku.id,
    name: sku.name,
    aliases: sku.aliases,
    price: sku.price,
    stock: sku.stock,
    facts: sku.facts,
    aliasLabel: sku.aliases[0],
    factSummary: sku.facts.join(" "),
  };
}
