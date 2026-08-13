import { NoAccess } from "@/frontend/components/layout/no-access";
import { ExpensesBoard } from "@/frontend/components/finance/expenses-board";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import {
  getCurrencyRateMap,
  getExpensesView,
  getFinanceRefs,
  getMembers,
} from "@/backend/data";

// Расходы компании за период. Период задаётся в адресе (?from=&to=), чтобы
// ссылкой на конкретный месяц можно было поделиться.
export default async function ExpensesPage({
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
    getExpensesView(isDate(from), isDate(to)),
    getFinanceRefs(),
    getMembers(),
    getCurrencyRateMap(),
  ]);

  return (
    <ExpensesBoard
      view={view}
      accounts={refs.accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
      categories={refs.categories}
      members={members.map((m) => ({ id: m.id, name: m.name, roleLabel: m.roleLabel }))}
      rates={rates}
      canEdit={can(session.role, "finance:expense")}
    />
  );
}
