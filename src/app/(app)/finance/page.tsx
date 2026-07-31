import { PlanFact } from "@/frontend/components/finance/plan-fact";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSalesPlanView } from "@/backend/data";

// Вкладка «План WB»: план продаж на полугодие против факта.
// Заголовок и переключатель вкладок — в layout.tsx раздела.
export default async function FinancePage() {
  const session = await getSession();
  const planView = await getSalesPlanView();

  return <PlanFact view={planView} canPlan={can(session.role, "finance:plan")} />;
}
