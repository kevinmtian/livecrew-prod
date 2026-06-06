import { AppShell, Panel, StatusPill } from "@/components/dashboard";
import {
  defaultActiveSkuId,
  getActiveSkuDisplay,
  resolveSkuFromText,
} from "@/lib/catalogue";
import { mockChat, mockLedgerEvents } from "@/lib/mock-data";

export default function HostPage() {
  const activeProduct = getActiveSkuDisplay(defaultActiveSkuId);
  const transcriptMention = resolveSkuFromText(
    "Today we are starting with GlowFix Vitamin C Serum.",
  );

  return (
    <AppShell
      eyebrow="Host"
      title="Operator cockpit"
      description="Monitor transcript context, active products, viewer chat, agent suggestions, and the commerce ledger."
    >
      <div className="grid gap-4 xl:grid-cols-[1fr_1fr_0.8fr]">
        <div className="grid gap-4">
          <Panel title="Host Transcript" eyebrow="Input">
            <label className="sr-only" htmlFor="transcript">
              Host transcript
            </label>
            <textarea
              className="min-h-36 w-full resize-y rounded-md border border-slate-200 bg-slate-50 p-3 text-sm leading-6 outline-none transition focus:border-teal-500 focus:bg-white"
              defaultValue="Today we are starting with GlowFix Vitamin C Serum. It is a brightening serum in a 30 ml bottle."
              id="transcript"
            />
          </Panel>
          <Panel title="Viewer Chat" eyebrow="Live messages">
            <div className="space-y-3">
              {mockChat.map((chat) => (
                <div
                  className="rounded-md border border-slate-200 bg-slate-50 p-3"
                  key={`${chat.viewer}-${chat.message}`}
                >
                  <p className="text-xs font-semibold text-slate-500">
                    {chat.viewer}
                  </p>
                  <p className="mt-1 text-sm text-slate-800">{chat.message}</p>
                </div>
              ))}
            </div>
          </Panel>
        </div>
        <div className="grid gap-4">
          <Panel title="Product Shelf" eyebrow="Active SKU">
            <div className="rounded-lg border border-teal-200 bg-teal-50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">
                    {activeProduct.name}
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {activeProduct.price} · {activeProduct.stockLabel}
                  </p>
                </div>
                <StatusPill tone="good">Highlighted</StatusPill>
              </div>
              <ul className="mt-4 space-y-2 text-sm text-slate-700">
                {activeProduct.facts.map((fact) => (
                  <li key={fact}>- {fact}</li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-teal-800">
                Resolved from transcript: {transcriptMention?.name ?? "No SKU"}
              </p>
            </div>
          </Panel>
          <Panel title="AI Suggested Replies" eyebrow="Agent queue">
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
              <div className="flex flex-wrap gap-2">
                <StatusPill tone="warning">Needs review</StatusPill>
                <StatusPill>Grounded facts only</StatusPill>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-700">
                Suggested replies will appear here after viewer-message analysis
                is added in a later step.
              </p>
            </div>
          </Panel>
        </div>
        <div className="grid gap-4">
          <Panel title="Agent Event Timeline" eyebrow="Commerce ledger">
            <div className="space-y-3">
              {mockLedgerEvents.map((event) => (
                <div className="border-l-2 border-teal-500 pl-3" key={event.id}>
                  <p className="text-sm font-semibold text-slate-900">
                    {event.label}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {event.detail}
                  </p>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Backend Commerce" eyebrow="Placeholder">
            <p className="text-sm leading-6 text-slate-600">
              Backend state, orders, flash sales, and SKU KPIs will connect in a
              later prompt.
            </p>
          </Panel>
          <Panel title="Producer Report" eyebrow="Placeholder">
            <p className="text-sm leading-6 text-slate-600">
              The final report will cite ledger events and backend commerce
              numbers after those systems exist.
            </p>
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
