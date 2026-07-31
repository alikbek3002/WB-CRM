import { NoAccess } from "@/frontend/components/layout/no-access";
import { PnlReport } from "@/frontend/components/finance/pnl-report";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getPnlView } from "@/backend/data";

// ОПиУ: сколько компания реально заработала за последние 6 месяцев.
// Удержания WB — из отчёта о реализации (синк), себестоимость — из карточек,
// расходы — из кассы. Всё считается в кэш-таблицах, страница только рисует.
export default async function PnlPage() {
  const session = await getSession();
  if (!can(session.role, "finance:cash")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const view = await getPnlView(6);

  return <PnlReport view={view} />;
}
