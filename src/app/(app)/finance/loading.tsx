import { Skeleton } from "@/frontend/components/ui/skeleton";

// Каркас вкладок финансов. Общий скелет раздела (app) рисует четыре
// KPI-квадрата, которых здесь больше нет, — из-за этого при переключении
// вкладки макет прыгал. Этот повторяет реальную раскладку: герой-число,
// лента метрик, полоса структуры, график, таблица.
export default function FinanceLoading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      <div className="space-y-3 rounded-xl border border-border/60 p-4">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-11 w-64" />
        <Skeleton className="h-3 w-80" />
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-xl border border-border/60 px-4 py-3.5 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-5 w-28" />
          </div>
        ))}
      </div>

      <div className="space-y-3 rounded-xl border border-border p-4">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-7 w-full" />
        <div className="flex flex-wrap gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-32" />
          ))}
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-border p-4">
        <Skeleton className="h-4 w-52" />
        <Skeleton className="h-56 w-full" />
      </div>

      <div className="space-y-2 rounded-xl border border-border p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}
