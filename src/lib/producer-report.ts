import {
  type BackendCommerceState,
  type BackendOrderGroup,
  formatMoney,
  getBackendSkuName,
  groupOrdersBySku,
} from "./backend-commerce";

type ProducerQueueItem = {
  status: "Draft" | "Review" | "Blocked";
  analysis?: {
    intent: string;
    risk: "low" | "medium" | "high";
    decision: string;
    skuId: string | null;
    reason: string;
  };
};

type ProducerLedgerEvent = {
  label: string;
  detail: string;
  status: "complete" | "watching" | "blocked" | "pending";
};

export type ProducerListedSku = {
  skuId: string;
  name: string;
  sourceEvents: string[];
};

export type ProducerReport = {
  listedSkus: ProducerListedSku[];
  totalUnitsSold: number;
  totalGmv: number;
  perProduct: BackendOrderGroup[];
  flashSaleSellThrough: {
    label: string;
    sold: number;
    quantity: number;
    percent: number;
  } | null;
  questionsHandled: string[];
  riskEvents: string[];
  hostLearning: string[];
  nextRecommendations: string[];
};

function getPayloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];

  return typeof value === "string" ? value : null;
}

export function getListedSkusFromLedger(
  state: BackendCommerceState | null,
): ProducerListedSku[] {
  if (!state) {
    return [];
  }

  const listedSkus = new Map<string, ProducerListedSku>();

  for (const event of state.event_ledger) {
    if (event.type !== "list_product" && event.type !== "create_flash_sale") {
      continue;
    }

    const skuId = getPayloadString(event.payload, "sku_id");

    if (!skuId) {
      continue;
    }

    const existingSku = listedSkus.get(skuId);
    const eventName = event.type;

    if (existingSku) {
      if (!existingSku.sourceEvents.includes(eventName)) {
        existingSku.sourceEvents.push(eventName);
      }
      continue;
    }

    listedSkus.set(skuId, {
      skuId,
      name:
        getPayloadString(event.payload, "name") ?? getBackendSkuName(state, skuId),
      sourceEvents: [eventName],
    });
  }

  return Array.from(listedSkus.values());
}

export function buildProducerReport(input: {
  backendState: BackendCommerceState | null;
  queueItems: ProducerQueueItem[];
  localLedgerEvents: ProducerLedgerEvent[];
}): ProducerReport {
  const { backendState, queueItems, localLedgerEvents } = input;
  const perProduct = groupOrdersBySku(backendState);
  const totalUnitsSold = perProduct.reduce((total, item) => total + item.units, 0);
  const totalGmv = perProduct.reduce((total, item) => total + item.gmv, 0);
  const handledQuestions = queueItems
    .filter((item) =>
      ["product_fact", "product_clarification", "comparison"].includes(
        item.analysis?.intent ?? "",
      ),
    )
    .map((item) => `${item.analysis?.intent}: ${item.analysis?.reason}`);
  const riskEvents = [
    ...queueItems
      .filter(
        (item) =>
          item.status === "Blocked" ||
          item.analysis?.risk === "medium" ||
          item.analysis?.risk === "high" ||
          item.analysis?.decision === "host_review",
      )
      .map((item) => `${item.analysis?.intent ?? item.status}: ${item.analysis?.reason ?? "Host review required"}`),
    ...localLedgerEvents
      .filter((event) => event.status === "blocked" || event.status === "pending")
      .map((event) => `${event.label}: ${event.detail}`),
  ];
  const flashSale = backendState?.flash_sale;
  const flashSaleSellThrough = flashSale
    ? {
        label: flashSale.name,
        sold: flashSale.sold,
        quantity: flashSale.quantity,
        percent:
          flashSale.quantity > 0
            ? Math.round((flashSale.sold / flashSale.quantity) * 100)
            : 0,
      }
    : null;
  const hostLearning = [
    totalUnitsSold > 0
      ? `Backend orders converted ${totalUnitsSold} units for ${formatMoney(totalGmv)} GMV.`
      : "No backend orders yet; keep prompting for explicit quantity and SKU.",
    riskEvents.length > 0
      ? `${riskEvents.length} risk event(s) needed host review or blocking.`
      : "No risky viewer requests have been recorded yet.",
    handledQuestions.length > 0
      ? `${handledQuestions.length} product question(s) were handled from grounded catalogue facts.`
      : "No grounded product questions have been handled yet.",
  ];
  const nextRecommendations = [
    "List every promoted SKU through backend actions so the report has durable evidence.",
    "Keep discounts, skin-safety claims, and price complaints under host review.",
    perProduct.length > 0
      ? "Restock or extend offers based on per-product units sold and GMV, not the latest active SKU."
      : "Run an order flow to populate per-product KPI recommendations.",
  ];

  return {
    listedSkus: getListedSkusFromLedger(backendState),
    totalUnitsSold,
    totalGmv,
    perProduct,
    flashSaleSellThrough,
    questionsHandled: handledQuestions,
    riskEvents,
    hostLearning,
    nextRecommendations,
  };
}
