import { NoAccess } from "@/frontend/components/layout/no-access";
import { PayrollBoard } from "@/frontend/components/finance/payroll-board";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import {
  getCurrencyRateMap,
  getFinanceRefs,
  getMembers,
  getPayrollView,
} from "@/backend/data";

// Выплаты команде: кому сколько ушло за период. Считается из кассы (расходы с
// указанным сотрудником) — отдельного «фонда зарплат» нет, деньги одни и те же.
export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const session = await getSession();
  if (!can(session.role, "finance:cash")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const { from, to } = await searchParams;
  const isDate = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

  const [view, refs, members, rates] = await Promise.all([
    getPayrollView(isDate(from), isDate(to)),
    getFinanceRefs(),
    getMembers(),
    getCurrencyRateMap(),
  ]);

  return (
    <PayrollBoard
      view={view}
      accounts={refs.accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
      categories={refs.categories}
      members={members.map((m) => ({ id: m.id, name: m.name, roleLabel: m.roleLabel }))}
      rates={rates}
      canEdit={can(session.role, "finance:expense")}
    />
  );
}
