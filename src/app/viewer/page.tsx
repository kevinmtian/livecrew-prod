import { AppShell, Panel, StatusPill } from "@/components/dashboard";
import { mockChat, mockProducts } from "@/lib/mock-data";

export default function ViewerPage() {
  const activeProduct = mockProducts[0];

  return (
    <AppShell
      eyebrow="Viewer"
      title="Customer livestream room"
      description="A local mock viewer surface with the active product, offer state, and chat preview."
    >
      <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <Panel title="Active Product" eyebrow="Now featured">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-slate-950">
                  {activeProduct.name}
                </h2>
                <p className="mt-2 text-2xl font-semibold text-teal-800">
                  {activeProduct.price}
                </p>
              </div>
              <StatusPill tone="good">{activeProduct.stock} left</StatusPill>
            </div>
            <ul className="mt-5 space-y-2 text-sm leading-6 text-slate-700">
              {activeProduct.facts.map((fact) => (
                <li key={fact}>- {fact}</li>
              ))}
            </ul>
          </div>
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold text-amber-900">
                Limited-time offer
              </p>
              <StatusPill tone="warning">ends in 90s</StatusPill>
            </div>
            <p className="mt-2 text-sm text-amber-800">12/20 left</p>
          </div>
        </Panel>
        <Panel title="Viewer Chat" eyebrow="Local preview">
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
            <div className="rounded-md border border-teal-200 bg-teal-50 p-3">
              <p className="text-xs font-semibold text-teal-700">
                LiveCrew Agent
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-800">
                GlowFix Vitamin C Serum is a 30 ml brightening serum. Please
                check with the host before relying on any unverified discount.
              </p>
            </div>
          </div>
          <form className="mt-4 flex flex-col gap-2 sm:flex-row">
            <label className="sr-only" htmlFor="viewer-message">
              Viewer message
            </label>
            <input
              className="min-h-11 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-teal-500"
              id="viewer-message"
              placeholder="Ask about the active product"
            />
            <button
              className="min-h-11 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800"
              type="button"
            >
              Send
            </button>
          </form>
        </Panel>
      </div>
    </AppShell>
  );
}
