import { Clock, Radio } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { MetricCard } from "@/components/MetricCard";
import { Panel } from "@/components/Panel";
import { ProductTable } from "@/components/ProductTable";
import { StatusPill } from "@/components/StatusPill";
import { activeSkuId, productCatalogue, type ProductSku } from "@/lib/catalogue";
import { chatMessages, liveSession, runOfShow } from "@/lib/mockData";

type HostProductQueueItem = ProductSku & {
  sold: number;
  status: string;
};

const soldCounts = [74, 52, 39, 28];
const hostProductQueue: HostProductQueueItem[] = productCatalogue.map((sku, index) => ({
  ...sku,
  sold: soldCounts[index],
  status: sku.id === activeSkuId ? "Featured" : index === 1 ? "Bundle" : "Queued",
}));

export default function HostPage() {
  return (
    <AppShell
      active="host"
      title="Host Console"
      subtitle="Coordinate the live room with products, prompts, and priority viewer questions."
    >
      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard label="Runtime" value={liveSession.runtime} detail={liveSession.host} />
        <MetricCard label="Live viewers" value={liveSession.audience.toLocaleString()} detail="Mock active audience" />
        <MetricCard label="Conversion" value={liveSession.conversionRate} detail="Viewer to order" />
        <MetricCard label="Orders" value={String(liveSession.orders)} detail="Paid orders" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <Panel
          title="Product Queue"
          action={<StatusPill tone="live">On air</StatusPill>}
        >
          <ProductTable products={hostProductQueue} />
        </Panel>

        <Panel title="Run of Show">
          <div className="space-y-3">
            {runOfShow.map((item) => (
              <div
                key={`${item.time}-${item.label}`}
                className="grid grid-cols-[64px_1fr_auto] items-center gap-3 rounded-md border border-line bg-panel px-3 py-3"
              >
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500">
                  <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                  {item.time}
                </span>
                <div>
                  <p className="text-sm font-medium text-ink">{item.label}</p>
                  <p className="text-xs text-slate-500">{item.owner}</p>
                </div>
                <StatusPill tone={item.state === "Now" ? "warn" : "neutral"}>
                  {item.state}
                </StatusPill>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Priority Questions">
        <div className="grid gap-3 lg:grid-cols-3">
          {chatMessages.map((message) => (
            <article
              key={message.id}
              className="rounded-md border border-line bg-panel p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
                  <Radio className="h-4 w-4 text-slate-500" aria-hidden="true" />
                  {message.user}
                </span>
                <StatusPill tone={message.priority === "High" ? "warn" : "neutral"}>
                  {message.priority}
                </StatusPill>
              </div>
              <p className="mt-3 text-sm text-slate-700">{message.text}</p>
              <p className="mt-3 text-xs font-semibold uppercase text-slate-500">
                {message.intent}
              </p>
            </article>
          ))}
        </div>
      </Panel>
    </AppShell>
  );
}
