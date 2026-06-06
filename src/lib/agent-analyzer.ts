import {
  type CommerceSku,
  type SkuId,
  resolveSkuById,
  resolveSkuFromText,
} from "./catalogue";

export type ViewerIntent =
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

export type SkuResolutionSource = "explicit" | "active_context" | "none";

export type AgentDecision = "auto_reply" | "host_review" | "block" | "clarify";

export type AgentRisk = "low" | "medium" | "high";

export type ViewerMessageAnalysis = {
  intent: ViewerIntent;
  skuId: SkuId | null;
  sku: CommerceSku | null;
  skuResolutionSource: SkuResolutionSource;
  orderQuantity: number | null;
  decision: AgentDecision;
  risk: AgentRisk;
  confidence: number;
  reason: string;
  reply: string | null;
  evidence: string[];
};

type AnalyzeInput = {
  message: string;
  activeSkuId?: SkuId | string | null;
};

const numberWords: Record<string, number> = {
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

const orderKeywords = [
  "order",
  "buy",
  "purchase",
  "checkout",
  "take",
  "get",
  "add to cart",
  "another",
];

const contextualSkuTerms = [
  "it",
  "this",
  "that",
  "one",
  "item",
  "product",
  "sku",
  "another",
  "these",
  "those",
];

function normalizeMessage(message: string) {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9$%.]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function hasQuestionShape(text: string) {
  return (
    text.includes("?") ||
    /\b(what|which|how|does|do|is|are|can|could|tell me|show me)\b/.test(text)
  );
}

function resolveSku(message: string, activeSkuId?: string | null) {
  const explicitSku = resolveSkuFromText(message);

  if (explicitSku) {
    return {
      sku: explicitSku,
      source: "explicit" as const,
    };
  }

  const activeSku = resolveSkuById(activeSkuId);
  const normalizedMessage = normalizeMessage(message);
  const hasContextualReference = contextualSkuTerms.some((term) =>
    new RegExp(`\\b${term}\\b`).test(normalizedMessage),
  );

  if (activeSku && hasContextualReference) {
    return {
      sku: activeSku,
      source: "active_context" as const,
    };
  }

  return {
    sku: null,
    source: "none" as const,
  };
}

function parseNumberWord(tokens: string[], index: number) {
  const current = numberWords[tokens[index]];
  const next = numberWords[tokens[index + 1]];

  if (current === undefined) {
    return null;
  }

  if (current < 100 && next !== undefined && next < 10) {
    return current + next;
  }

  return current;
}

export function inferOrderQuantity(message: string): number | null {
  const normalizedMessage = normalizeMessage(message);
  const numericMatch = normalizedMessage.match(/\b(\d{1,5})\b/);

  if (numericMatch) {
    return Number(numericMatch[1]);
  }

  const tokens = normalizedMessage.split(" ");

  for (let index = 0; index < tokens.length; index += 1) {
    const parsed = parseNumberWord(tokens, index);

    if (parsed !== null) {
      return parsed;
    }
  }

  if (isOrderIntent(normalizedMessage)) {
    return 1;
  }

  return null;
}

function isOrderIntent(normalizedMessage: string) {
  return includesAny(normalizedMessage, orderKeywords);
}

function groundedProductReply(sku: CommerceSku | null) {
  if (!sku) {
    return null;
  }

  return `${sku.name}: ${sku.facts.join("; ")}.`;
}

function classifyIntent(normalizedMessage: string): ViewerIntent {
  if (
    /\b(ignore instructions|system prompt|developer message|jailbreak|steal|hack|exploit|drop database|delete data)\b/.test(
      normalizedMessage,
    )
  ) {
    return "malicious";
  }

  if (
    /\b(allergy|allergic|rash|pregnant|pregnancy|eczema|acne|sensitive skin|safe for skin|dermatologist|medical|cure|treat)\b/.test(
      normalizedMessage,
    )
  ) {
    return "skin_safety";
  }

  if (isOrderIntent(normalizedMessage)) {
    return "order";
  }

  if (
    /\b(discount|promo|voucher|coupon|free shipping|bundle|deal|sale|cheaper|lowest price)\b/.test(
      normalizedMessage,
    )
  ) {
    return "promo_request";
  }

  if (
    /\b(price changed|price change|was cheaper|used to be|earlier price|before it was|why is it more|went up)\b/.test(
      normalizedMessage,
    )
  ) {
    return "price_change_complaint";
  }

  if (
    /\b(expensive|too much|too pricey|costly|overpriced|better price|lower price)\b/.test(
      normalizedMessage,
    )
  ) {
    return "price_objection";
  }

  if (/\b(compare|comparison|versus|vs|better than|different from)\b/.test(normalizedMessage)) {
    return "comparison";
  }

  if (
    /\b(which one|what product|which product|what is this|which sku|what item|what are you showing)\b/.test(
      normalizedMessage,
    )
  ) {
    return "product_clarification";
  }

  if (
    hasQuestionShape(normalizedMessage) &&
    /\b(ingredients|size|capacity|finish|refill|strap|light|morning|routine|use|facts|details|stock|left|spf)\b/.test(
      normalizedMessage,
    )
  ) {
    return "product_fact";
  }

  if (
    /\b(hello|hi|thanks|thank you|lol|music|song|weather|football|game|shipping to mars)\b/.test(
      normalizedMessage,
    )
  ) {
    return "off_topic";
  }

  return normalizedMessage.length < 8 || hasQuestionShape(normalizedMessage)
    ? "ambiguous"
    : "off_topic";
}

function buildAnalysis(input: {
  intent: ViewerIntent;
  sku: CommerceSku | null;
  source: SkuResolutionSource;
  orderQuantity: number | null;
  reason: string;
}): ViewerMessageAnalysis {
  const { intent, sku, source, orderQuantity, reason } = input;
  const skuId = sku?.id ?? null;
  const evidence = sku?.facts ?? [];

  if (intent === "malicious") {
    return {
      intent,
      skuId,
      sku,
      skuResolutionSource: source,
      orderQuantity,
      decision: "block",
      risk: "high",
      confidence: 0.96,
      reason,
      reply: null,
      evidence,
    };
  }

  if (["promo_request", "skin_safety", "price_change_complaint"].includes(intent)) {
    return {
      intent,
      skuId,
      sku,
      skuResolutionSource: source,
      orderQuantity,
      decision: "host_review",
      risk: intent === "skin_safety" ? "high" : "medium",
      confidence: 0.86,
      reason,
      reply: null,
      evidence,
    };
  }

  if (intent === "order") {
    return {
      intent,
      skuId,
      sku,
      skuResolutionSource: source,
      orderQuantity,
      decision: sku ? "host_review" : "clarify",
      risk: "medium",
      confidence: sku ? 0.9 : 0.72,
      reason,
      reply: null,
      evidence,
    };
  }

  if (intent === "product_fact" && sku) {
    return {
      intent,
      skuId,
      sku,
      skuResolutionSource: source,
      orderQuantity,
      decision: "auto_reply",
      risk: "low",
      confidence: 0.88,
      reason,
      reply: groundedProductReply(sku),
      evidence,
    };
  }

  if (intent === "off_topic") {
    return {
      intent,
      skuId,
      sku,
      skuResolutionSource: source,
      orderQuantity,
      decision: "clarify",
      risk: "low",
      confidence: 0.75,
      reason,
      reply: null,
      evidence,
    };
  }

  return {
    intent,
    skuId,
    sku,
    skuResolutionSource: source,
    orderQuantity,
    decision: sku ? "host_review" : "clarify",
    risk: "medium",
    confidence: sku ? 0.78 : 0.62,
    reason,
    reply: null,
    evidence,
  };
}

export function deterministicAnalyzeViewerMessage(
  input: AnalyzeInput,
): ViewerMessageAnalysis {
  const normalizedMessage = normalizeMessage(input.message);
  const { sku, source } = resolveSku(input.message, input.activeSkuId);
  const intent = classifyIntent(normalizedMessage);
  const orderQuantity =
    intent === "order" ? inferOrderQuantity(normalizedMessage) : null;
  const reasonParts = [
    `Classified as ${intent}`,
    sku ? `resolved ${sku.name} from ${source}` : "no SKU resolved",
  ];

  if (intent === "order") {
    reasonParts.push(`order quantity ${orderQuantity ?? "unknown"}`);
  }

  return buildAnalysis({
    intent,
    sku,
    source,
    orderQuantity,
    reason: reasonParts.join("; "),
  });
}
