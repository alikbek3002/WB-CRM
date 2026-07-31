import type { ReactNode } from "react";
import { NoAccess } from "@/frontend/components/layout/no-access";
import { FinanceNav } from "@/frontend/components/finance/finance-nav";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";

// Общая шапка раздела: заголовок + переключатель вкладок.
// Доступ к кассе/расходам/ОПиУ шире, чем finance:view, поэтому вкладки
// показываем по правам (finance:cash) — сами страницы тоже проверяют доступ.
export default async function FinanceLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!can(session.role, "finance:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Финансы</h1>
        <p className="text-sm text-muted-foreground">
          План WB, реальная прибыль, расходы компании и остатки денег в кассе
        </p>
      </div>

      <FinanceNav canCash={can(session.role, "finance:cash")} />

      {children}
    </div>
  );
}
