import { NoAccess } from "@/frontend/components/layout/no-access";
import { DutiesList } from "@/frontend/components/duties/duties-list";
import { DutiesTabs } from "@/frontend/components/duties/duties-tabs";
import { DutyRules } from "@/frontend/components/duties/duty-rules";
import { DutyStatsSection } from "@/frontend/components/duties/duty-stats";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import {
  getDutyStats,
  getDutyTemplates,
  getMembers,
  getMyDuties,
  getReportsBoard,
} from "@/backend/data";
import type { DutyItem } from "@/shared/types";

export const dynamic = "force-dynamic";

// Регламент. Три вопроса — три вкладки: что мне делать сегодня, как устроен
// сам регламент (и кто его правит) и как команда его соблюдает.
export default async function DutiesPage() {
  const session = await getSession();
  if (!can(session.role, "duty:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const canComplete = can(session.role, "duty:complete");
  const canManage = can(session.role, "duty:manage");
  const seesTeam = can(session.role, "reports:view");

  let mine: DutyItem[] = [];
  let team: DutyItem[] = [];
  if (seesTeam) {
    const board = await getReportsBoard();
    mine = board.items.filter((i) => i.assigneeId === session.user.id);
    team = board.items.filter((i) => i.assigneeId !== session.user.id);
  } else {
    mine = await getMyDuties(session.user.id);
  }
  // Дисциплина за период — после readDuties: тот уже сгенерировал сегодняшние
  // наряды и пометил просроченные
  const stats = await getDutyStats();
  // Сам регламент видят все (это правила игры), правят — директор и ст. менеджер
  const [templates, members] = await Promise.all([
    getDutyTemplates(),
    canManage ? getMembers() : Promise.resolve([]),
  ]);

  const today = new Date().toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    weekday: "long",
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Регламент</h1>
        <p className="text-sm text-muted-foreground">
          {today} · обязанности приходят задачами автоматически: у каждой дедлайн,
          запас времени и отчёт{!canComplete && " · только просмотр"}
        </p>
      </div>

      <DutiesTabs
        todayCount={mine.length}
        rulesCount={templates.filter((t) => t.active).length}
        today={
          <>
            <DutiesList duties={mine} canComplete={canComplete} />

            {seesTeam && team.length > 0 && (
              <div className="space-y-2 pt-2">
                <h2 className="text-sm font-medium text-muted-foreground">
                  Команда сегодня
                </h2>
                {[...new Set(team.map((t) => t.assigneeName))].map((name) => (
                  <div key={name} className="space-y-2">
                    <div className="pt-1 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                      {name}
                    </div>
                    <DutiesList
                      duties={team.filter((t) => t.assigneeName === name)}
                      canComplete={canComplete}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        }
        rules={
          <DutyRules
            templates={templates}
            members={members.map((m) => ({
              id: m.id,
              name: m.name,
              role: m.role,
              roleLabel: m.roleLabel,
            }))}
            me={{ userId: session.user.id, role: session.role }}
            canManage={canManage}
          />
        }
        discipline={
          <DutyStatsSection
            stats={stats}
            currentUserId={session.user.id}
            seesTeam={seesTeam}
          />
        }
      />
    </div>
  );
}
