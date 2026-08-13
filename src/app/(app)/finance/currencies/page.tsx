import { NoAccess } from "@/frontend/components/layout/no-access";
import { CurrencyRatesBoard } from "@/frontend/components/finance/currency-rates-board";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getCurrencyRates } from "@/backend/data";

// Курсы валют к сому. Смотрят все, кто ведёт деньги, правят директор и старший
// менеджер (currency:manage) — от этих чисел зависит вся отчётность.
export default async function CurrenciesPage() {
  const session = await getSession();
  if (!can(session.role, "finance:cash")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const view = await getCurrencyRates();

  return <CurrencyRatesBoard view={view} canEdit={can(session.role, "currency:manage")} />;
}
