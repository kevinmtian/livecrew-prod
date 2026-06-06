export type BackendSku = {
  id: string;
  name: string;
  current_price: string;
  stock: number;
};

export type BackendFlashSale = {
  id: string;
  sku_id: string;
  sale_price: string;
  total: number;
  remaining: number;
  ends_in_seconds: number;
  created_at: string;
};

export type BackendOrder = {
  id: string;
  sku_id: string;
  qty: number;
  price: string;
  viewer: string;
  created_at: string;
};

export type BackendLedgerEvent = {
  id: string;
  ts: string;
  action: string;
  [key: string]: unknown;
};

export type BackendState = {
  active_sku_id: string | null;
  skus: Record<string, BackendSku>;
  flash_sale: BackendFlashSale | null;
  orders: BackendOrder[];
  announcements: string[];
  event_ledger: BackendLedgerEvent[];
};

export type OrderPayload = {
  viewer: string;
  sku_id: string;
  qty: number;
};

const backendBaseUrl =
  process.env.NEXT_PUBLIC_AGENT_BASE_URL ?? "http://127.0.0.1:8000";

export function normalizeBackendSkuId(skuId: string) {
  return skuId;
}

export function parseCommercePrice(price: string) {
  const numericValue = Number(price.replace(/[^0-9.]/g, ""));
  return Number.isFinite(numericValue) ? numericValue : 0;
}

async function requestBackend<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${backendBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`Backend request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export function getLiveState() {
  return requestBackend<BackendState>("/live/state", {
    cache: "no-store",
  });
}

export function postLiveOrder(payload: OrderPayload) {
  return requestBackend<{ order: BackendOrder; state: BackendState }>(
    "/live/order",
    {
      method: "POST",
      body: JSON.stringify({
        viewer: payload.viewer,
        sku_id: normalizeBackendSkuId(payload.sku_id),
        qty: payload.qty,
      }),
    },
  );
}

export function postLiveReset() {
  return requestBackend<BackendState>("/live/reset", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function summarizeOrdersBySku(
  orders: BackendOrder[],
  skus: Record<string, BackendSku>,
) {
  return Object.values(
    orders.reduce<Record<string, { sku_id: string; name: string; units: number; gmv: number }>>(
      (summary, order) => {
        const current = summary[order.sku_id] ?? {
          sku_id: order.sku_id,
          name: skus[order.sku_id]?.name ?? order.sku_id,
          units: 0,
          gmv: 0,
        };

        current.units += order.qty;
        current.gmv += parseCommercePrice(order.price) * order.qty;
        summary[order.sku_id] = current;

        return summary;
      },
      {},
    ),
  );
}

export function formatGmv(value: number) {
  return `S$${value.toFixed(2)}`;
}
