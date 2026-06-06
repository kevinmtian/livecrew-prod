type PanelProps = {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
};

export function Panel({ title, action, children }: PanelProps) {
  return (
    <section className="rounded-md border border-line bg-white shadow-soft">
      <div className="flex min-h-12 items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
