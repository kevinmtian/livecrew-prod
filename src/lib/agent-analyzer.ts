import {
  activeSkuId as defaultActiveSkuId,
  productCatalogue,
  type ProductSku,
} from "@/lib/catalogue";

export type AgentIntent =
  | "product_fact"
  | "promo_request"
  | "price_objection"
  | "price_change_complaint"
  | "product_clarification"
  | "order"
  | "skin_safety"
  | "comparison"
  | "malicious"
  | "off_topic"
  | "ambiguous";

export type ViewerMessageForAnalysis = {
  id: string;
  viewerName: string;
  text: string;
  timestamp: string;
};

export type AnalyzeViewerMessageInput = {
  viewerMessage: ViewerMessageForAnalysis;
  activeSkuId: string | null;
  catalogue?: ProductSku[];
};

export type AnalyzeViewerMessageOutput = {
  messageId: string;
  resolvedSkuId: string | null;
  intent: AgentIntent;
  riskLevel: "low" | "medium" | "high";
  decision:
    | "auto_reply"
    | "host_review"
    | "ask_clarification"
    | "block"
    | "ignore"
    | "no_reply"
    | "update_context";
  confidence: number;
  safeReply: string;
  groundedFacts: string[];
  blockedClaims: string[];
  reason: string;
  orderQuantity?: number;
  groupKey?: string;
};

const wordNumbers: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

const contextualSkuTerms = [
  "it",
  "this",
  "this one",
  "that",
  "that one",
  "the product",
  "active product",
  "current product",
  "this product",
  "that product",
];

const blockedClaims = {
  discounts: "No discount, voucher, or price exception is confirmed in the catalogue.",
  delivery: "No delivery timing or shipping origin promise is confirmed in the catalogue.",
  authenticity: "No authenticity or origin guarantee is confirmed in the catalogue.",
  refunds: "No refund policy is confirmed in the catalogue.",
  medical: "No medical, cure, or guaranteed skin outcome claim is supported.",
  priceHistory: "No historical price or price-change reason is confirmed in the catalogue.",
};

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\w\s%$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeQuestionKey(text: string) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(can you|could you|would you|please|pls|can i|do you)\b/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function getCatalogue(inputCatalogue?: ProductSku[]) {
  return inputCatalogue?.length ? inputCatalogue : productCatalogue;
}

function buildSkuTerms(sku: ProductSku) {
  return [sku.id, sku.name, ...sku.aliases].map(normalizeText);
}

function resolveExplicitSku(text: string, catalogue: ProductSku[]) {
  const normalizedText = normalizeText(text);

  const expandedTerms: Record<string, string[]> = {
    "sku-glowfix-vitamin-c-serum": ["glowfix", "vitamin c", "serum"],
    "sku-hydramist-cushion-spf": ["hydramist", "cushion", "spf"],
    "sku-bamboo-thermal-tumbler": ["bamboo", "tumbler"],
    "sku-satin-cloud-sleep-mask": ["satin", "sleep mask"],
  };

  return catalogue.find((sku) => {
    const terms = [...buildSkuTerms(sku), ...(expandedTerms[sku.id] ?? [])];

    return terms.some((term) => {
      const normalizedTerm = normalizeText(term);
      return new RegExp(`(^|\\s)${escapeRegExp(normalizedTerm)}(\\s|$)`).test(
        normalizedText,
      );
    });
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasContextualSkuReference(text: string) {
  const normalizedText = normalizeText(text);

  return contextualSkuTerms.some((term) =>
    new RegExp(`(^|\\s)${escapeRegExp(term)}(\\s|$)`).test(normalizedText),
  );
}

function resolveSku(
  text: string,
  activeSkuId: string | null,
  catalogue: ProductSku[],
) {
  const explicitSku = resolveExplicitSku(text, catalogue);
  if (explicitSku) {
    return explicitSku;
  }

  if (!activeSkuId || !hasContextualSkuReference(text)) {
    return null;
  }

  return catalogue.find((sku) => sku.id === activeSkuId) ?? null;
}

function clampQuantity(quantity: number) {
  return Math.max(1, Math.min(999, quantity));
}

function parseNumberWords(text: string) {
  const normalizedWords = normalizeText(text).split(" ");

  for (let index = 0; index < normalizedWords.length; index += 1) {
    const current = normalizedWords[index];
    const next = normalizedWords[index + 1];
    const currentValue = wordNumbers[current];

    if (!currentValue) {
      continue;
    }

    if (next === "hundred") {
      return currentValue * 100;
    }

    const nextValue = wordNumbers[next];
    if (currentValue >= 20 && currentValue % 10 === 0 && nextValue > 0 && nextValue < 10) {
      return currentValue + nextValue;
    }

    return currentValue;
  }

  return null;
}

function inferOrderQuantity(text: string) {
  const normalizedText = normalizeText(text);
  const numericMatch = normalizedText.match(/\b(\d{1,4})\b/);

  if (numericMatch) {
    return clampQuantity(Number(numericMatch[1]));
  }

  const wordQuantity = parseNumberWords(normalizedText);
  return wordQuantity ? clampQuantity(wordQuantity) : 1;
}

function isOrderIntent(text: string) {
  const normalizedText = normalizeText(text);

  if (/\b(another|order|buy|purchase|cart|checkout|claim|take|get me|i want)\b/.test(normalizedText)) {
    return /\b(order|buy|purchase|cart|checkout|claim|take|get me|another|i want)\b/.test(
      normalizedText,
    );
  }

  return parseNumberWords(normalizedText) !== null && hasContextualSkuReference(text);
}

function classifyIntent(text: string): AgentIntent {
  const normalizedText = normalizeText(text);

  if (
    hasAny(normalizedText, ["ignore policy", "bypass policy", "break policy", "promise me"]) ||
    /\bpromise\b.*\b(discount|50%|voucher|free)\b/.test(normalizedText)
  ) {
    return "malicious";
  }

  if (isOrderIntent(text)) {
    return "order";
  }

  if (hasAny(normalizedText, ["cure", "acne", "eczema", "rash", "allergy", "safe for skin", "sensitive skin", "pregnant", "medical"])) {
    return "skin_safety";
  }

  if (hasAny(normalizedText, ["discount", "voucher", "promo", "promotion", "coupon", "50% off", "deal"])) {
    return "promo_request";
  }

  if (hasAny(normalizedText, ["too expensive", "cheaper", "pricey", "cost too much", "lower price", "best price"])) {
    return "price_objection";
  }

  if (hasAny(normalizedText, ["price change", "was cheaper", "increased", "changed price", "old price", "last time"])) {
    return "price_change_complaint";
  }

  if (hasAny(normalizedText, ["compare", "better than", "versus", " vs ", "difference between"])) {
    return "comparison";
  }

  if (hasAny(normalizedText, ["which one", "what product", "which product", "what is this", "which sku"])) {
    return "product_clarification";
  }

  if (hasAny(normalizedText, ["ship", "shipping", "deliver", "delivery", "singapore", "price", "how much", "stock", "facts", "benefit", "use", "how long", "spf", "ingredient"])) {
    return "product_fact";
  }

  if (hasAny(normalizedText, ["hello", "hi", "lol", "music", "song", "weather"])) {
    return "off_topic";
  }

  return "ambiguous";
}

function productNeedsSku(intent: AgentIntent) {
  return [
    "product_fact",
    "product_clarification",
    "order",
    "skin_safety",
    "comparison",
    "price_objection",
    "price_change_complaint",
  ].includes(intent);
}

function makeProductFactReply(text: string, sku: ProductSku) {
  const normalizedText = normalizeText(text);
  const facts = [...sku.facts];

  if (normalizedText.includes("price") || normalizedText.includes("how much")) {
    facts.unshift(`${sku.name} is listed at ${sku.price}.`);
  }

  if (normalizedText.includes("stock")) {
    facts.unshift(`${sku.stock} units are listed in the catalogue.`);
  }

  if (normalizedText.includes("ship") || normalizedText.includes("deliver") || normalizedText.includes("singapore")) {
    return {
      safeReply: `${sku.name}: I can confirm the catalogue facts: ${sku.facts.join(" ")} I do not have a confirmed delivery timing or shipping-origin promise.`,
      groundedFacts: sku.facts,
      blockedClaims: [blockedClaims.delivery],
    };
  }

  return {
    safeReply: `${sku.name}: ${facts.join(" ")}`,
    groundedFacts: facts,
    blockedClaims: [],
  };
}

export function analyzeViewerMessage(
  input: AnalyzeViewerMessageInput,
): AnalyzeViewerMessageOutput {
  const catalogue = getCatalogue(input.catalogue);
  const text = input.viewerMessage.text;
  const normalizedText = normalizeText(text);
  const intent = classifyIntent(text);
  const resolvedSku = resolveSku(text, input.activeSkuId, catalogue);
  const groupKey = normalizeQuestionKey(text);

  const base = {
    messageId: input.viewerMessage.id,
    resolvedSkuId: resolvedSku?.id ?? null,
    intent,
    groupKey,
  };

  if (intent === "malicious") {
    return {
      ...base,
      riskLevel: "high",
      decision: "block",
      confidence: 0.96,
      safeReply: "",
      groundedFacts: [],
      blockedClaims: [blockedClaims.discounts],
      reason: "Message tries to override policy or force an unsupported promotional promise.",
    };
  }

  if (intent === "order") {
    const orderQuantity = inferOrderQuantity(text);

    return {
      ...base,
      riskLevel: "low",
      decision: resolvedSku ? "update_context" : "ask_clarification",
      confidence: resolvedSku ? 0.9 : 0.68,
      safeReply: resolvedSku
        ? `Order intent detected for ${resolvedSku.name}, quantity ${orderQuantity}.`
        : "Which product would you like to order?",
      groundedFacts: resolvedSku ? [`${resolvedSku.name} is a catalogue SKU.`] : [],
      blockedClaims: [],
      reason: "Purchase language was detected before product-fact classification.",
      orderQuantity,
    };
  }

  if (productNeedsSku(intent) && !resolvedSku) {
    return {
      ...base,
      riskLevel: "medium",
      decision: "ask_clarification",
      confidence: 0.72,
      safeReply: "Which product should I check for you?",
      groundedFacts: [],
      blockedClaims: [],
      reason: "The message needs product context, but no explicit SKU or contextual active SKU was available.",
    };
  }

  if (intent === "promo_request") {
    return {
      ...base,
      riskLevel: "medium",
      decision: resolvedSku || input.activeSkuId ? "host_review" : "ask_clarification",
      confidence: 0.86,
      safeReply: resolvedSku
        ? `I need host confirmation before discussing discounts for ${resolvedSku.name}.`
        : "Which product is the promotion question about?",
      groundedFacts: resolvedSku ? [`${resolvedSku.name} is listed at ${resolvedSku.price}.`] : [],
      blockedClaims: [blockedClaims.discounts],
      reason: "Discount or promo requests require host review and cannot invent an offer.",
    };
  }

  if (intent === "skin_safety") {
    const highRisk = hasAny(normalizedText, ["cure", "acne", "eczema", "medical"]);

    return {
      ...base,
      riskLevel: highRisk ? "high" : "medium",
      decision: highRisk ? "block" : "host_review",
      confidence: 0.91,
      safeReply: highRisk
        ? ""
        : `I can share catalogue facts for ${resolvedSku?.name}, but skin-safety advice needs host review.`,
      groundedFacts: resolvedSku?.facts ?? [],
      blockedClaims: [blockedClaims.medical],
      reason: "Skin or medical claims cannot promise cures or guaranteed outcomes.",
    };
  }

  if (intent === "product_fact" && resolvedSku) {
    const reply = makeProductFactReply(text, resolvedSku);

    return {
      ...base,
      riskLevel: reply.blockedClaims.length ? "medium" : "low",
      decision: "auto_reply",
      confidence: 0.88,
      safeReply: reply.safeReply,
      groundedFacts: reply.groundedFacts,
      blockedClaims: reply.blockedClaims,
      reason: "The reply is limited to shared catalogue facts and explicit unsupported-claim boundaries.",
    };
  }

  if (intent === "price_objection" || intent === "price_change_complaint") {
    return {
      ...base,
      riskLevel: "medium",
      decision: "host_review",
      confidence: 0.82,
      safeReply: resolvedSku
        ? `${resolvedSku.name} is currently listed at ${resolvedSku.price}. I need host confirmation for any price exception or price-history explanation.`
        : "",
      groundedFacts: resolvedSku ? [`${resolvedSku.name} is listed at ${resolvedSku.price}.`] : [],
      blockedClaims: [blockedClaims.discounts, blockedClaims.priceHistory],
      reason: "Price objections and price-change explanations need host review.",
    };
  }

  if (intent === "comparison") {
    return {
      ...base,
      riskLevel: "medium",
      decision: "host_review",
      confidence: 0.78,
      safeReply: resolvedSku
        ? `I can compare only catalogue facts for ${resolvedSku.name}; host review is recommended before making a recommendation.`
        : "",
      groundedFacts: resolvedSku?.facts ?? [],
      blockedClaims: [],
      reason: "Comparison questions can require context beyond the catalogue.",
    };
  }

  if (intent === "product_clarification") {
    return {
      ...base,
      riskLevel: "low",
      decision: resolvedSku ? "auto_reply" : "ask_clarification",
      confidence: resolvedSku ? 0.84 : 0.7,
      safeReply: resolvedSku
        ? `You are asking about ${resolvedSku.name}.`
        : "Which product do you mean?",
      groundedFacts: resolvedSku ? [`${resolvedSku.name} is a catalogue SKU.`] : [],
      blockedClaims: [],
      reason: "Product clarification can be answered from SKU identity when resolved.",
    };
  }

  if (intent === "off_topic") {
    return {
      ...base,
      riskLevel: "low",
      decision: "ignore",
      confidence: 0.7,
      safeReply: "",
      groundedFacts: [],
      blockedClaims: [],
      reason: "Message does not require a commerce-agent reply.",
    };
  }

  return {
    ...base,
    riskLevel: "medium",
    decision: "ask_clarification",
    confidence: 0.58,
    safeReply: "Could you clarify what you need help with?",
    groundedFacts: [],
    blockedClaims: [],
    reason: "The deterministic rules did not find a clear supported intent.",
  };
}

export const analyzerDefaultActiveSkuId = defaultActiveSkuId;
