import { MessageSquare, ShoppingBag } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { MetricCard } from "@/components/MetricCard";
import { Panel } from "@/components/Panel";
import { StatusPill } from "@/components/StatusPill";
import { getActiveSkuDisplay } from "@/lib/catalogue";
import { chatMessages, liveSession, viewerActions } from "@/lib/mockData";

export default function ViewerPage() {
  const featuredProduct = getActiveSkuDisplay();

  return (
    <AppShell
      active="viewer"
      title="Viewer Room"
      subtitle="A mock consumer-facing stream layout with product discovery and live chat signals."
    >
      <div className="grid gap-4 md:grid-cols-3">
        {viewerActions.map((action) => (
          <MetricCard
            key={action.label}
            label={action.label}
            value={action.value}
            detail={action.change}
          />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Panel
          title="Live Preview"
          action={<StatusPill tone="live">{liveSession.status}</StatusPill>}
        >
          <div className="flex aspect-video min-h-[260px] items-center justify-center rounded-md border border-slate-800 bg-slate-950 p-6 text-center text-white">
            <div>
              <p className="text-sm font-semibold uppercase text-slate-300">
                {liveSession.title}
              </p>
              <p className="mt-3 text-3xl font-semibold">{liveSession.host}</p>
              <p className="mt-2 text-sm text-slate-300">
                {liveSession.audience.toLocaleString()} watching
              </p>
            </div>
          </div>
        </Panel>

        <Panel title="Featured Offer">
          <div className="rounded-md border border-line bg-panel p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase text-slate-500">
                  Now featuring
                </p>
                <h2 className="mt-2 text-xl font-semibold text-ink">
                  {featuredProduct.name}
                </h2>
                <p className="mt-2 text-sm text-slate-600">
                  {featuredProduct.stock} in stock. {featuredProduct.facts[0]}.
                </p>
              </div>
              <span className="text-xl font-semibold text-ink">
                {featuredProduct.price}
              </span>
            </div>
            <button className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white">
              <ShoppingBag className="h-4 w-4" aria-hidden="true" />
              Add to cart
            </button>
          </div>
        </Panel>
      </div>

      <Panel title="Live Chat">
        <div className="space-y-3">
          {chatMessages.map((message) => (
            <div
              key={message.id}
              className="flex items-start gap-3 rounded-md border border-line bg-panel p-3"
            >
              <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
              <div>
                <p className="text-sm font-semibold text-ink">{message.user}</p>
                <p className="mt-1 text-sm text-slate-700">{message.text}</p>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </AppShell>
  );
}
