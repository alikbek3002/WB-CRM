import { NoAccess } from "@/frontend/components/layout/no-access";
import { CashBoard } from "@/frontend/components/finance/cash-board";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getCashOverview, getFinanceRefs } from "@/backend/data";

// Касса: сколько денег и где лежит, что приходило и уходило.
export default async function CashPage() {
  const session = await getSession();
  if (!can(session.role, "finance:cash")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const [overview, refs] = await Promise.all([getCashOverview(), getFinanceRefs()]);

  return (
    <CashBoard
      overview={overview}
      categories={refs.categories}
      canEdit={can(session.role, "finance:expense")}
    />
  );
}
