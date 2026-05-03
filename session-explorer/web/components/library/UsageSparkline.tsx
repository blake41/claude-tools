interface Props {
  buckets: Array<{ day: string; count: number }>;
}

export default function UsageSparkline({ buckets }: Props) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="flex items-end gap-px h-[40px] p-1 bg-white/3 border border-border/30 rounded">
      {buckets.map((b) => {
        const intensity = b.count === 0 ? 0 : Math.max(0.1, b.count / max);
        const height = b.count === 0 ? 2 : Math.max(3, intensity * 36);
        const opacity = b.count === 0 ? 0.15 : 0.4 + intensity * 0.6;
        return (
          <div
            key={b.day}
            className="flex-1 min-w-[3px] rounded-sm bg-accent-purple"
            style={{ height: `${height}px`, opacity }}
            title={`${b.day}: ${b.count} invocation${b.count === 1 ? "" : "s"}`}
          />
        );
      })}
    </div>
  );
}
