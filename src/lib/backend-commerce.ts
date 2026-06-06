import { type SkuId, commerceCatalogue, resolveSkuById } from "@/lib/catalogue";

export type BackendSku = {
  id: string;
  name: string;
  current_price: number;
  stock: number;
};

export type BackendFlashSale = {
  id: string;
  sku_id: string;
  name: string;
  sale_price: number;
  quantity: number;
  sold: number;
  ends_in_seconds: number;
  created_at: string;
};

export type BackendOrder = {
  id: string;
  sku_id: string;
  qty: number;
  price: number;
  viewer: string;
  created_at: string;
};

export type BackendAnnouncement = {
  id: string;
  message: string;
  created_at: string;
};

export type BackendLedgerEvent = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type BackendCommerceState = {
  active_sku_id: string | null;
  skus: Record<string, BackendSku>;
  flash_sale: BackendFlashSale | null;
  orders: BackendOrder[];
  announcements: BackendAnnouncement[];
  event_ledger: BackendLedgerEvent[];
};

export type BackendOrderGroup = {
  skuId: string;
  name: string;
  units: number;
  gmv: number;
};

const BACKEND_BASE_URL =
  process.env.NEXT_PUBLIC_COMMERCE_API_URL ?? "http://localhost:8000";

export function isKnownSkuId(skuId: string | null | undefined): skuId is SkuId {
  return Boolean(skuId && resolveSkuById(skuId));
}

export function getBackendBaseUrl() {
  return BACKEND_BASE_URL;
}

export function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

async function requestBackend<T>(
  path: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${BACKEND_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Backend request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export function fetchBackendState(signal?: AbortSignal) {
  return requestBackend<BackendCommerceState>("/live/state", undefined, signal);
}

export function listBackendProduct(skuId: SkuId) {
  return requestBackend<BackendCommerceState>("/live/list-product", {
    method: "POST",
    body: JSON.stringify({ sku_id: skuId }),
  });
}

export function createBackendFlashSale(skuId: SkuId, salePrice: number) {
  return requestBackend<BackendCommerceState>("/live/flash-sale", {
    method: "POST",
    body: JSON.stringify({
      sku_id: skuId,
      sale_price: salePrice,
      quantity: 20,
      ends_in_seconds: 90,
    }),
  });
}

export function resetBackendCommerce() {
  return requestBackend<BackendCommerceState>("/live/reset", {
    method: "POST",
  });
}

export function getBackendSkuName(
  state: BackendCommerceState | null,
  skuId: string,
) {
  return (
    state?.skus[skuId]?.name ??
    commerceCatalogue.find((sku) => sku.id === skuId)?.name ??
    skuId
  );
}

export function groupOrdersBySku(
  state: BackendCommerceState | null,
): BackendOrderGroup[] {
  if (!state) {
    return [];
  }

  const groups = new Map<string, BackendOrderGroup>();

  for (const order of state.orders) {
    const currentGroup = groups.get(order.sku_id) ?? {
      skuId: order.sku_id,
      name: getBackendSkuName(state, order.sku_id),
      units: 0,
      gmv: 0,
    };

    currentGroup.units += order.qty;
    currentGroup.gmv += order.qty * order.price;
    groups.set(order.sku_id, currentGroup);
  }

  return Array.from(groups.values()).sort((a, b) => b.gmv - a.gmv);
}

export function getBackendActiveSkuId(
  state: BackendCommerceState | null,
): SkuId | null {
  if (isKnownSkuId(state?.active_sku_id)) {
    return state.active_sku_id;
  }

  if (isKnownSkuId(state?.flash_sale?.sku_id)) {
    return state.flash_sale.sku_id;
  }

  return null;
}
