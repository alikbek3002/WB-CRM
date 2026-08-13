import { NoAccess } from "@/frontend/components/layout/no-access";
import { CashBoard } from "@/frontend/components/finance/cash-board";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import {
  getCashOverview,
  getCurrencyRateMap,
  getFinanceRefs,
  getMembers,
} from "@/backend/data";

// Касса: сколько денег и где лежит, что приходило и уходило.
export default async function CashPage() {
  const session = await getSession();
  if (!can(session.role, "finance:cash")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const [overview, refs, members, rates] = await Promise.all([
    getCashOverview(),
    getFinanceRefs(),
    getMembers(),
    getCurrencyRateMap(),
  ]);

  return (
    <CashBoard
      overview={overview}
      categories={refs.categories}
      members={members.map((m) => ({ id: m.id, name: m.name, roleLabel: m.roleLabel }))}
      rates={rates}
      canEdit={can(session.role, "finance:expense")}
    />
  );
}
