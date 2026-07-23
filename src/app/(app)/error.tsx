"use client";

// Ошибки чтения БД больше не маскируются демо-данными — показываем их честно.

import { useEffect } from "react";
import { Button } from "@/frontend/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] ошибка страницы:", error);
  }, [error]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-24 text-center">
      <h2 className="text-lg font-semibold">Не удалось загрузить данные</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Ошибка при обращении к базе данных. Попробуйте обновить страницу — если
        повторяется, проверьте подключение Supabase и логи сервера.
      </p>
      {error.digest && (
        <p className="text-xs text-muted-foreground">Код: {error.digest}</p>
      )}
      <Button variant="outline" size="sm" onClick={reset}>
        Повторить
      </Button>
    </div>
  );
}
