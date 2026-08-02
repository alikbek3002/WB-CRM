import { NoAccess } from "@/frontend/components/layout/no-access";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getTasks, getTeam } from "@/backend/data";
import { TaskForm } from "@/frontend/components/tasks/task-form";
import { TaskBoard } from "@/frontend/components/tasks/task-board";
import { ROLE_LABELS, type MemberRole } from "@/shared/rbac";

export default async function TasksPage() {
  const session = await getSession();
  if (!can(session.role, "tasks:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const [tasks, team] = await Promise.all([getTasks(), getTeam()]);
  const canAssign = ["owner", "admin", "manager"].includes(session.role);
  // Руководители видят всю доску; специалист — только свои и созданные им
  const visibleTasks = canAssign
    ? tasks
    : tasks.filter(
        (t) => t.assigneeId === session.user.id || t.createdById === session.user.id,
      );
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
            При закрытии задачи обязателен отчёт — что именно сделано. Отчёты
            видят директор и старшие менеджеры (и здесь, и в Telegram).
          </p>
        </div>
        {canAssign && <TaskForm team={teamOptions} />}
      </div>

      <TaskBoard tasks={visibleTasks} userId={session.user.id} canLead={canAssign} />
    </div>
  );
}
