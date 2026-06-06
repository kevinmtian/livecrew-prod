import type { ProductSku } from "@/lib/catalogue";
import { StatusPill } from "./StatusPill";

type ProductQueueItem = ProductSku & {
  sold: number;
  status: string;
};

type ProductTableProps = {
  products: ProductQueueItem[];
};

export function ProductTable({ products }: ProductTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr className="border-b border-line">
            <th className="pb-3 font-semibold">Product</th>
            <th className="pb-3 font-semibold">Price</th>
            <th className="pb-3 font-semibold">Inventory</th>
            <th className="pb-3 font-semibold">Sold</th>
            <th className="pb-3 font-semibold">State</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {products.map((product) => (
            <tr key={product.id}>
              <td className="py-3 font-medium text-ink">{product.name}</td>
              <td className="py-3 text-slate-700">{product.price}</td>
              <td className="py-3 text-slate-700">{product.stock}</td>
              <td className="py-3 text-slate-700">{product.sold}</td>
              <td className="py-3">
                <StatusPill tone={product.status === "Featured" ? "good" : "neutral"}>
                  {product.status}
                </StatusPill>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
