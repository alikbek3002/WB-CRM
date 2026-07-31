import { NoAccess } from "@/frontend/components/layout/no-access";
import { PnlReport } from "@/frontend/components/finance/pnl-report";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getFinanceRows, getPnlView } from "@/backend/data";

// ОПиУ: сколько компания реально заработала за последние 6 месяцев.
export default async function PnlPage() {
  const session = await getSession();
  if (!can(session.role, "finance:cash")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const [view, wbRows] = await Promise.all([getPnlView(6), getFinanceRows()]);

  return <PnlReport view={view} wbRows={wbRows} />;
}
