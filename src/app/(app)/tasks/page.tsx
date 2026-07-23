import { Badge } from "@/frontend/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/frontend/components/ui/card";
import { NoAccess } from "@/frontend/components/layout/no-access";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getTasks, getTeam } from "@/backend/data";
import { TaskForm } from "@/frontend/components/tasks/task-form";
import { ROLE_LABELS, type MemberRole } from "@/shared/rbac";
import type { TaskItem } from "@/shared/types";
import { cn } from "@/shared/utils";

const COLUMNS: { status: TaskItem["status"]; title: string }[] = [
  { status: "open", title: "Открытые" },
  { status: "in_progress", title: "В работе" },
  { status: "done", title: "Выполнены" },
];

const PRIORITY_LABELS: Record<TaskItem["priority"], string> = {
  low: "низкий",
  normal: "обычный",
  high: "высокий",
  urgent: "срочно",
};

function priorityClass(p: TaskItem["priority"]) {
  switch (p) {
    case "urgent":
      return "border-red-500/50 text-red-400";
    case "high":
      return "border-amber-500/50 text-amber-400";
    default:
      return "text-muted-foreground";
  }
}

export default async function TasksPage() {
  const session = await getSession();
  if (!can(session.role, "tasks:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const [tasks, team] = await Promise.all([getTasks(), getTeam()]);
  const canAssign = ["owner", "admin", "manager"].includes(session.role);
  const teamOptions = team.map((m) => ({
    id: m.id,
    name: m.name,
    roleLabel: ROLE_LABELS[m.role as MemberRole] ?? m.role,
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
        <h1 className="text-xl font-semibold tracking-tight">Задачи</h1>
        <p className="text-sm text-muted-foreground">
          Синхронизируются с Telegram-ботом (Фаза 7)
        </p>
        </div>
        {canAssign && <TaskForm team={teamOptions} />}
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col.status);
          return (
            <Card key={col.status} className="py-4">
              <CardHeader className="px-4">
                <CardTitle className="flex items-center justify-between text-sm">
                  {col.title}
                  <Badge variant="secondary">{items.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 px-4">
                {items.map((t) => (
                  <div
                    key={t.id}
                    className="rounded-lg border border-border/70 bg-background/40 p-3"
                  >
                    <div
                      className={cn(
                        "text-sm",
                        t.status === "done" &&
                          "text-muted-foreground line-through",
                      )}
                    >
                      {t.title}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Badge
                        variant="outline"
                        className={cn("text-[10px]", priorityClass(t.priority))}
                      >
                        {PRIORITY_LABELS[t.priority]}
                      </Badge>
                      {t.productLabel && (
                        <Badge variant="secondary" className="text-[10px]">
                          {t.productLabel}
                        </Badge>
                      )}
                      <span className="ml-auto">{t.assignee}</span>
                      {t.dueDate && (
                        <span>
                          ·{" "}
                          {new Date(t.dueDate).toLocaleDateString("ru-RU", {
                            day: "numeric",
                            month: "short",
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {items.length === 0 && (
                  <div className="py-6 text-center text-xs text-muted-foreground">
                    Нет задач
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
