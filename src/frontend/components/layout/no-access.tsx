import { Lock } from "lucide-react";

export function NoAccess({ roleLabel }: { roleLabel: string }) {
  return (
    <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Lock className="size-5 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold">Нет доступа</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Раздел недоступен для роли «{roleLabel}». Обратитесь к директору или
        администратору организации (матрица прав — раздел 5 плана).
      </p>
    </div>
  );
}
