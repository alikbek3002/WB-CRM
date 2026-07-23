import { Skeleton } from "@/frontend/components/ui/skeleton";

// Мгновенный каркас при переходе на любую вкладку раздела (app). Без него
// App Router держит старую страницу на экране, пока сервер тянет данные из
// Supabase (иногда 6–11 с) — клик выглядит как «залипание». Скелетон
// показывается сразу, реальная страница подменяет его, когда данные готовы.
export default function AppLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      {/* Заголовок */}
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>

      {/* Ряд KPI-карточек */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-xl border border-border p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>

      {/* Крупный блок (график / таблица) */}
      <div className="space-y-3 rounded-xl border border-border p-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-52 w-full" />
      </div>

      {/* Строки таблицы */}
      <div className="space-y-2 rounded-xl border border-border p-4">
        <Skeleton className="h-4 w-40" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </div>
  );
}
