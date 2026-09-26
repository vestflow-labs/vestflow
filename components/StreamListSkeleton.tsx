export default function StreamListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="card p-5 mb-6" aria-label="Loading streams" role="status">
      <div className="h-5 w-40 rounded bg-white/10 animate-pulse mb-4" />
      <div className="space-y-3">
        {Array.from({ length: count }, (_, index) => (
          <div key={index} className="min-h-[60px] py-3 border-b border-white/5 last:border-0">
            <div className="h-4 w-44 rounded bg-white/10 animate-pulse" />
            <div className="h-3 w-64 rounded bg-white/5 animate-pulse mt-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
