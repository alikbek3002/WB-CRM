import Link from "next/link";
import { Badge } from "@/frontend/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/frontend/components/ui/card";
import { NoAccess } from "@/frontend/components/layout/no-access";
import { can } from "@/shared/rbac";
import { cn } from "@/shared/utils";
import { getSession } from "@/backend/auth/session";
import { getReportsBoard, getTaskReports } from "@/backend/data";

export const dynamic = "force-dynamic";

function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

// Отчёты команды по регламенту — для директора и старшего менеджера.
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const session = await getSession();
  if (!can(session.role, "reports:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const { date } = await searchParams;
  const valid = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
  const [board, taskReports] = await Promise.all([
    getReportsBoard(valid),
    getTaskReports(valid),
  ]);

  const dayLabel = new Date(`${board.date}T12:00:00`).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    weekday: "long",
  });

  const kpis = [
    { label: "Задач", value: board.total, className: "" },
    { label: "Выполнено", value: board.done, className: "text-emerald-400" },
    { label: "Вовремя", value: board.onTime, className: "text-emerald-400" },
    { label: "Просрочено", value: board.missed, className: board.missed ? "text-red-400" : "" },
    { label: "В работе", value: board.pending, className: board.pending ? "text-sky-300" : "" },
  ];

  const byAssignee = new Map<string, typeof board.items>();
  for (const item of board.items) {
    const list = byAssignee.get(item.assigneeName) ?? [];
    list.push(item);
    byAssignee.set(item.assigneeName, list);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Отчёты команды</h1>
          <p className="text-sm text-muted-foreground">
            {dayLabel} · отчёты по задачам и выполнение регламента
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`/reports?date=${shiftDate(board.date, -1)}`}
            className="rounded-md border border-border/60 px-2.5 py-1 text-muted-foreground hover:text-foreground"
          >
            ← Пред. день
          </Link>
          <Link
            href="/reports"
            className="rounded-md border border-border/60 px-2.5 py-1 text-muted-foreground hover:text-foreground"
          >
            Сегодня
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardContent className="py-4">
              <div className="text-xs text-muted-foreground">{k.label}</div>
              <div className={cn("text-2xl font-semibold tabular-nums", k.className)}>
                {k.value}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Отчёты по задачам: что сотрудники написали при закрытии */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm">
            <span>Отчёты по задачам</span>
            <span className="text-xs font-normal text-muted-foreground">
              закрыто за день: {taskReports.length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {taskReports.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              За этот день задач не закрывали.
            </p>
          )}
          {taskReports.map((t) => (
            <div key={t.id} className="rounded-lg border border-border/60 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t.title}</span>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px]",
                    t.onTime === false
                      ? "border-amber-500/50 text-amber-400"
                      : "border-emerald-500/50 text-emerald-400",
                  )}
                >
                  {t.onTime === false ? "После срока" : "Выполнено"}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {t.assignee} ·{" "}
                  {new Date(t.completedAt).toLocaleTimeString("ru-RU", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              {t.report ? (
                <p className="mt-1.5 whitespace-pre-line text-sm text-muted-foreground">
                  {t.report}
                </p>
              ) : (
                <p className="mt-1.5 text-xs italic text-muted-foreground">
                  Закрыта до введения обязательных отчётов
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {board.items.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            За этот день назначений по регламенту нет.
          </CardContent>
        </Card>
      )}

      {[...byAssignee.entries()].map(([name, items]) => {
        const done = items.filter((i) => i.status === "done").length;
        return (
          <Card key={name}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-sm">
                <span>{name}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  выполнено {done} из {items.length}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {items.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "rounded-lg border border-border/60 px-3 py-2.5",
                    item.status === "missed" && "border-red-500/40",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{item.title}</span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        item.status === "done" && "border-emerald-500/50 text-emerald-400",
                        item.status === "missed" && "border-red-500/50 text-red-400",
                        item.status === "pending" && "border-sky-500/50 text-sky-300",
                      )}
                    >
                      {item.status === "done"
                        ? item.reportOnTime === false
                          ? "Выполнено с опозданием"
                          : "Выполнено вовремя"
                        : item.status === "missed"
                          ? "Просрочено"
                          : "В работе"}
                    </Badge>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {item.dueLabel}
                      {item.completedAt &&
                        ` · сдано ${new Date(item.completedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`}
                    </span>
                  </div>
                  {item.reportContent ? (
                    <p className="mt-1.5 whitespace-pre-line text-sm text-muted-foreground">
                      {item.reportContent}
                    </p>
                  ) : (
                    item.status !== "pending" && (
                      <p className="mt-1.5 text-xs italic text-muted-foreground">
                        Без отчёта
                      </p>
                    )
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
