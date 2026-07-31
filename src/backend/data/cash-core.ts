// Управленческие финансы — ЕДИНОЕ место правил для всех входов: веб (API-роуты),
// Telegram-бот (кнопки) и ИИ-ассистент (инструменты).
//
// Модель одна на всё, чтобы не было двойного учёта (миграция 0024):
//   cash_accounts — где лежат деньги, expense_categories — статьи,
//   cash_tx — операции (приход / расход / перевод).
// «Расходы» = срез cash_tx с kind='out'; «Касса» = счета и их остатки;
// ОПиУ = выручка WB − удержания WB − себестоимость проданного − расходы.
//
// Чистый модуль (npm + относительные импорты) — работает и в Turbopack, и в tsx.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_ORG_ID, DEMO_STORE_ID, EXCHANGE_RATES, toRub } from "../../shared/constants";
import { can, type MemberRole } from "../../shared/rbac";
import type {
  CashAccount,
  CashAccountKind,
  CashFlowMonth,
  CashOverview,
  CashTx,
  CashTxKind,
  Currency,
  ExpenseCategory,
  ExpenseCategorySlice,
  ExpensesView,
  PnlMonth,
  PnlView,
} from "../../shared/types";
import { notifyRoles, tgEsc } from "../telegram/notify";

const MONTHS_RU = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

// Локальная дата yyyy-mm-dd (без toISOString — он сдвигает день в UTC+5/6)
export function isoDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// Первое число месяца, отстоящего на n назад
function monthStart(monthsBack = 0): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsBack);
  return d;
}

// Последний день месяца по его первому дню (yyyy-mm-01)
function monthEndOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return isoDay(new Date(y, m, 0));
}

function monthLabel(iso: string, withYear = false): string {
  const [y, m] = iso.split("-").map(Number);
  const name = MONTHS_RU[(m ?? 1) - 1] ?? "";
  return withYear ? `${name} ${y}` : name;
}

function first<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// ─── Чтение ──────────────────────────────────────────────────────────────────

type CashTxRow = {
  id: string;
  kind: CashTxKind;
  amount: number;
  amount_rub: number;
  currency: Currency;
  occurred_on: string;
  note: string | null;
  source: CashTx["source"];
  account_id: string;
  category_id: string | null;
  account: { name: string } | { name: string }[] | null;
  to_account: { name: string } | { name: string }[] | null;
  category: { name: string; emoji: string | null } | { name: string; emoji: string | null }[] | null;
  author: { full_name: string | null } | { full_name: string | null }[] | null;
};

// Один и тот же select для ленты кассы и списка расходов
const CASH_TX_SELECT =
  "id, kind, amount, amount_rub, currency, occurred_on, note, source, account_id, category_id, " +
  "account:cash_accounts!cash_tx_account_id_fkey(name), " +
  "to_account:cash_accounts!cash_tx_to_account_id_fkey(name), " +
  "category:expense_categories(name, emoji), " +
  "author:profiles!cash_tx_created_by_fkey(full_name)";

function mapTx(r: CashTxRow): CashTx {
  const cat = first(r.category);
  return {
    id: String(r.id),
    kind: r.kind,
    accountId: String(r.account_id),
    accountName: first(r.account)?.name ?? "—",
    toAccountName: first(r.to_account)?.name ?? null,
    categoryId: r.category_id ? String(r.category_id) : null,
    categoryName: cat?.name ?? null,
    categoryEmoji: cat?.emoji ?? null,
    amount: Number(r.amount),
    currency: r.currency,
    amountRub: Math.round(Number(r.amount_rub ?? 0)),
    occurredOn: String(r.occurred_on),
    note: r.note,
    authorName: first(r.author)?.full_name ?? null,
    source: r.source,
  };
}

// Справочники для форм (веб, бот, ИИ): куда платить и по какой статье
export async function getFinanceRefs(db: SupabaseClient): Promise<{
  accounts: { id: string; name: string; kind: CashAccountKind; currency: Currency }[];
  categories: ExpenseCategory[];
}> {
  const [accRes, catRes] = await Promise.all([
    db
      .from("cash_accounts")
      .select("id, name, kind, currency")
      .eq("org_id", DEMO_ORG_ID)
      .eq("archived", false)
      .order("sort_order")
      .limit(100),
    db
      .from("expense_categories")
      .select("id, name, direction, in_pnl, emoji")
      .eq("org_id", DEMO_ORG_ID)
      .eq("archived", false)
      .order("direction")
      .order("sort_order")
      .limit(200),
  ]);
  if (accRes.error) throw accRes.error;
  if (catRes.error) throw catRes.error;
  return {
    accounts: (accRes.data ?? []).map((a) => ({
      id: String(a.id),
      name: String(a.name),
      kind: a.kind as CashAccountKind,
      currency: a.currency as Currency,
    })),
    categories: (catRes.data ?? []).map((c) => ({
      id: String(c.id),
      name: String(c.name),
      direction: c.direction as "in" | "out",
      inPnl: Boolean(c.in_pnl),
      emoji: (c.emoji as string) ?? null,
    })),
  };
}

export async function getCashOverview(db: SupabaseClient): Promise<CashOverview> {
  const flowSince = isoDay(monthStart(5)); // текущий месяц + 5 предыдущих
  const thisMonth = isoDay(monthStart(0));

  const [balRes, flowRes, txRes, wbRes] = await Promise.all([
    db.rpc("agg_cash_balances", { p_org: DEMO_ORG_ID }),
    db.rpc("agg_cash_flow_monthly", { p_org: DEMO_ORG_ID, p_since: flowSince }),
    db
      .from("cash_tx")
      .select(CASH_TX_SELECT)
      .eq("org_id", DEMO_ORG_ID)
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(30),
    db
      .from("wb_balance")
      .select("currency, current_amount, for_withdraw, checked_at")
      .eq("store_id", DEMO_STORE_ID)
      .maybeSingle(),
  ]);
  if (balRes.error) throw balRes.error;
  if (flowRes.error) throw flowRes.error;
  if (txRes.error) throw txRes.error;

  type BalRow = {
    account_id: string;
    name: string;
    kind: CashAccountKind;
    currency: Currency;
    balance: number;
    tx_count: number;
    last_tx: string | null;
  };
  const accounts: CashAccount[] = ((balRes.data ?? []) as BalRow[]).map((r) => {
    const balance = Number(r.balance ?? 0);
    return {
      id: String(r.account_id),
      name: String(r.name),
      kind: r.kind,
      currency: r.currency,
      balance,
      balanceRub: toRub(balance, r.currency),
      txCount: Number(r.tx_count ?? 0),
      lastTx: r.last_tx ? String(r.last_tx) : null,
    };
  });

  type FlowRow = { month: string; in_rub: number; out_rub: number };
  const flow: CashFlowMonth[] = ((flowRes.data ?? []) as FlowRow[]).map((r) => ({
    month: String(r.month),
    label: monthLabel(String(r.month)),
    inRub: Math.round(Number(r.in_rub ?? 0)),
    outRub: Math.round(Number(r.out_rub ?? 0)),
  }));
  const current = flow.find((f) => f.month === thisMonth);

  const wb = wbRes.data as
    | { currency: string; current_amount: number; for_withdraw: number; checked_at: string }
    | null;

  return {
    accounts,
    wbBalance: wb
      ? {
          currency: String(wb.currency ?? "RUB"),
          current: Math.round(Number(wb.current_amount ?? 0)),
          forWithdraw: Math.round(Number(wb.for_withdraw ?? 0)),
          checkedAt: String(wb.checked_at),
        }
      : null,
    totalRub: accounts.reduce((t, a) => t + a.balanceRub, 0),
    monthInRub: current?.inRub ?? 0,
    monthOutRub: current?.outRub ?? 0,
    flow,
    recent: ((txRes.data ?? []) as unknown as CashTxRow[]).map(mapTx),
  };
}

// Расходы за период (по умолчанию — текущий месяц)
export async function getExpensesView(
  db: SupabaseClient,
  from?: string,
  to?: string,
): Promise<ExpensesView> {
  const periodFrom = from ?? isoDay(monthStart(0));
  const periodTo = to ?? isoDay(new Date());

  const [catRes, itemsRes, monthlyRes] = await Promise.all([
    db.rpc("agg_expenses_by_category", {
      p_org: DEMO_ORG_ID,
      p_from: periodFrom,
      p_to: periodTo,
    }),
    db
      .from("cash_tx")
      .select(CASH_TX_SELECT)
      .eq("org_id", DEMO_ORG_ID)
      .eq("kind", "out")
      .gte("occurred_on", periodFrom)
      .lte("occurred_on", periodTo)
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(300),
    db.rpc("agg_expenses_monthly", { p_org: DEMO_ORG_ID, p_since: isoDay(monthStart(5)) }),
  ]);
  if (catRes.error) throw catRes.error;
  if (itemsRes.error) throw itemsRes.error;
  if (monthlyRes.error) throw monthlyRes.error;

  type CatRow = {
    category_id: string | null;
    name: string;
    emoji: string | null;
    in_pnl: boolean;
    amount_rub: number;
    tx_count: number;
  };
  const rawCats = ((catRes.data ?? []) as CatRow[]).filter((c) => Number(c.amount_rub) > 0);
  const totalRub = rawCats.reduce((t, c) => t + Number(c.amount_rub), 0);
  const categories: ExpenseCategorySlice[] = rawCats.map((c) => ({
    categoryId: c.category_id ? String(c.category_id) : null,
    name: String(c.name),
    emoji: c.emoji,
    inPnl: Boolean(c.in_pnl),
    amountRub: Math.round(Number(c.amount_rub)),
    txCount: Number(c.tx_count ?? 0),
    sharePct: totalRub > 0 ? Math.round((Number(c.amount_rub) / totalRub) * 100) : 0,
  }));

  type MonthRow = { month: string; opex_rub: number; total_rub: number };
  return {
    from: periodFrom,
    to: periodTo,
    totalRub: Math.round(totalRub),
    opexRub: Math.round(
      rawCats.filter((c) => c.in_pnl).reduce((t, c) => t + Number(c.amount_rub), 0),
    ),
    categories,
    items: ((itemsRes.data ?? []) as unknown as CashTxRow[]).map(mapTx),
    monthly: ((monthlyRes.data ?? []) as MonthRow[]).map((m) => ({
      month: String(m.month),
      label: monthLabel(String(m.month)),
      totalRub: Math.round(Number(m.total_rub ?? 0)),
    })),
  };
}

// ОПиУ: выручка − удержания WB − себестоимость − реклама − расходы = прибыль.
//
// Удержания берём из отчёта о реализации WB (v5/reportDetailByPeriod, синк
// 0026): комиссия, эквайринг, логистика, хранение, штрафы, приёмка, прочие
// удержания — каждая строка фактическая, а не выведенная. Пока отчёт за месяц
// не пришёл (WB закрывает неделю с задержкой), для этого месяца остаётся оценка
// «выручка − к перечислению» — она помечается source: "estimate", и интерфейс
// показывает это явно, чтобы цифру не принимали за окончательную.
export async function getPnlView(db: SupabaseClient, monthsBack = 6): Promise<PnlView> {
  const sinceDate = isoDay(monthStart(monthsBack - 1));
  const today = isoDay(new Date());

  const [salesRes, cogsRes, expRes, incomeRes, advRes, slicesRes, wbRes, balRes] =
    await Promise.all([
      db.rpc("agg_sales_monthly", { p_store: DEMO_STORE_ID, p_since: `${sinceDate}T00:00:00` }),
      db.rpc("agg_cogs_monthly", { p_store: DEMO_STORE_ID, p_since: `${sinceDate}T00:00:00` }),
      db.rpc("agg_expenses_monthly", { p_org: DEMO_ORG_ID, p_since: sinceDate }),
      db.rpc("agg_other_income_monthly", { p_org: DEMO_ORG_ID, p_since: sinceDate }),
      db.rpc("agg_advert_monthly", { p_store: DEMO_STORE_ID, p_since: sinceDate }),
      db.rpc("agg_expenses_by_category", { p_org: DEMO_ORG_ID, p_from: sinceDate, p_to: today }),
      db.rpc("agg_wb_finance_monthly", { p_store: DEMO_STORE_ID, p_since: sinceDate }),
      db
        .from("wb_balance")
        .select("currency, current_amount, for_withdraw, checked_at")
        .eq("store_id", DEMO_STORE_ID)
        .maybeSingle(),
    ]);
  for (const r of [salesRes, cogsRes, expRes, incomeRes, advRes, slicesRes, wbRes]) {
    if (r.error) throw r.error;
  }

  type SalesRow = { month: string; qty: number; revenue_rub: number; for_pay_rub: number };
  type CogsRow = { month: string; cogs_rub: number; covered_qty: number; total_qty: number };
  type ExpRow = { month: string; opex_rub: number; total_rub: number };
  type IncomeRow = { month: string; income_rub: number };
  type AdvRow = { month: string; spend_rub: number };
  type WbRow = {
    month: string;
    revenue_rub: number;
    for_pay_rub: number;
    commission_rub: number;
    acquiring_rub: number;
    logistics_rub: number;
    storage_rub: number;
    penalty_rub: number;
    acceptance_rub: number;
    deduction_rub: number;
    qty: number;
    rows_count: number;
    report_until: string | null;
  };

  const sales = new Map(((salesRes.data ?? []) as SalesRow[]).map((r) => [String(r.month), r]));
  const cogs = new Map(((cogsRes.data ?? []) as CogsRow[]).map((r) => [String(r.month), r]));
  const opex = new Map(((expRes.data ?? []) as ExpRow[]).map((r) => [String(r.month), r]));
  const income = new Map(((incomeRes.data ?? []) as IncomeRow[]).map((r) => [String(r.month), r]));
  const advert = new Map(((advRes.data ?? []) as AdvRow[]).map((r) => [String(r.month), r]));
  const wb = new Map(((wbRes.data ?? []) as WbRow[]).map((r) => [String(r.month), r]));

  // До какой даты WB посчитал: месяц считается закрытым, если отчёт доходит
  // до его последнего дня.
  const reportUntilRaw =
    ((wbRes.data ?? []) as WbRow[])
      .map((r) => r.report_until)
      .filter(Boolean)
      .sort()
      .pop() ?? null;

  // Месяцы периода — сплошным рядом, даже если данных за месяц нет
  const months: PnlMonth[] = [];
  for (let i = 0; i < monthsBack; i += 1) {
    const key = isoDay(monthStart(monthsBack - 1 - i));
    const s = sales.get(key);
    const c = cogs.get(key);
    const e = opex.get(key);
    const inc = income.get(key);
    const w = wb.get(key);
    const hasReport = Boolean(w && Number(w.rows_count) > 0);
    const closed = hasReport && Boolean(reportUntilRaw && reportUntilRaw >= monthEndOf(key));

    // Источник выручки. Закрытый месяц — из отчёта о реализации: это первичный
    // документ WB, он бьётся с удержаниями до копейки. Незакрытый — из продаж
    // statistics-api: там свежие дни, которых в отчёте ещё нет, иначе текущий
    // месяц выглядел бы провалившимся (WB просто не досчитал).
    const revenueRub = Math.round(
      closed ? Number(w!.revenue_rub ?? 0) : Number(s?.revenue_rub ?? 0),
    );

    let commissionRub = 0;
    let acquiringRub = 0;
    let logisticsRub = 0;
    let storageRub = 0;
    let penaltyRub = 0;
    let acceptanceRub = 0;
    let deductionRub = 0;
    if (hasReport) {
      commissionRub = Math.round(Number(w!.commission_rub ?? 0));
      acquiringRub = Math.round(Number(w!.acquiring_rub ?? 0));
      logisticsRub = Math.round(Number(w!.logistics_rub ?? 0));
      storageRub = Math.round(Number(w!.storage_rub ?? 0));
      penaltyRub = Math.round(Number(w!.penalty_rub ?? 0));
      acceptanceRub = Math.round(Number(w!.acceptance_rub ?? 0));
      deductionRub = Math.round(Number(w!.deduction_rub ?? 0));
    } else {
      // Отчёта нет — оценка комиссии по продажам (к перечислению уже за вычетом)
      commissionRub = Math.max(
        0,
        Math.round(Number(s?.revenue_rub ?? 0) - Number(s?.for_pay_rub ?? 0)),
      );
    }
    const wbFeesRub =
      commissionRub + acquiringRub + logisticsRub + storageRub + penaltyRub + acceptanceRub + deductionRub;

    const advertRub = Math.round(Number(advert.get(key)?.spend_rub ?? 0));
    const cogsRub = Math.round(Number(c?.cogs_rub ?? 0));
    const opexRub = Math.round(Number(e?.opex_rub ?? 0));
    const otherIncomeRub = Math.round(Number(inc?.income_rub ?? 0));
    const grossRub = revenueRub - wbFeesRub - cogsRub;
    const netRub = grossRub - advertRub - opexRub + otherIncomeRub;
    const coveredQty = Number(c?.covered_qty ?? 0);
    const totalQty = Number(c?.total_qty ?? 0);

    months.push({
      month: key,
      label: monthLabel(key, true),
      revenueRub,
      wbFeesRub,
      commissionRub,
      acquiringRub,
      logisticsRub,
      storageRub,
      penaltyRub,
      acceptanceRub,
      deductionRub,
      advertRub,
      cogsRub,
      grossRub,
      opexRub,
      otherIncomeRub,
      netRub,
      marginPct: revenueRub > 0 ? Math.round((netRub / revenueRub) * 100) : 0,
      qty: closed ? Number(w!.qty ?? 0) : Number(s?.qty ?? 0),
      costCoveragePct: totalQty > 0 ? Math.round((coveredQty / totalQty) * 100) : 0,
      source: closed ? "wb_report" : "estimate",
    });
  }

  const sum = (pick: (m: PnlMonth) => number) => months.reduce((t, m) => t + pick(m), 0);
  const totalRevenue = sum((m) => m.revenueRub);
  const totalNet = sum((m) => m.netRub);

  // Покрытие себестоимостью за период — по штукам, а не среднее из средних
  const cogsRows = (cogsRes.data ?? []) as CogsRow[];
  const coveredAll = cogsRows.reduce((t, r) => t + Number(r.covered_qty ?? 0), 0);
  const qtyAll = cogsRows.reduce((t, r) => t + Number(r.total_qty ?? 0), 0);
  const costCoveragePct = qtyAll > 0 ? Math.round((coveredAll / qtyAll) * 100) : 0;

  const total: PnlMonth = {
    month: months[0]?.month ?? sinceDate,
    label: `Итого за ${monthsBack} мес.`,
    revenueRub: totalRevenue,
    wbFeesRub: sum((m) => m.wbFeesRub),
    commissionRub: sum((m) => m.commissionRub),
    acquiringRub: sum((m) => m.acquiringRub),
    logisticsRub: sum((m) => m.logisticsRub),
    storageRub: sum((m) => m.storageRub),
    penaltyRub: sum((m) => m.penaltyRub),
    acceptanceRub: sum((m) => m.acceptanceRub),
    deductionRub: sum((m) => m.deductionRub),
    advertRub: sum((m) => m.advertRub),
    cogsRub: sum((m) => m.cogsRub),
    grossRub: sum((m) => m.grossRub),
    opexRub: sum((m) => m.opexRub),
    otherIncomeRub: sum((m) => m.otherIncomeRub),
    netRub: totalNet,
    marginPct: totalRevenue > 0 ? Math.round((totalNet / totalRevenue) * 100) : 0,
    qty: sum((m) => m.qty),
    costCoveragePct,
    source: months.some((m) => m.source === "wb_report") ? "wb_report" : "estimate",
  };

  type SliceRow = {
    category_id: string | null;
    name: string;
    emoji: string | null;
    in_pnl: boolean;
    amount_rub: number;
    tx_count: number;
  };
  const rawSlices = ((slicesRes.data ?? []) as SliceRow[]).filter((c) => Number(c.amount_rub) > 0);
  const slicesTotal = rawSlices.reduce((t, c) => t + Number(c.amount_rub), 0);

  // Валюта кабинета: WB считает отчёт в валюте юрлица (у киргизского — сомы),
  // и подписывать эти суммы рублём было бы враньём.
  const currency = ((wbRes.data ?? []) as WbRow[]).length
    ? await storeCurrency(db)
    : "RUB";

  const bal = balRes.data as
    | { currency: string; current_amount: number; for_withdraw: number; checked_at: string }
    | null;

  return {
    months,
    total,
    expenseSlices: rawSlices.map((c) => ({
      categoryId: c.category_id ? String(c.category_id) : null,
      name: String(c.name),
      emoji: c.emoji,
      inPnl: Boolean(c.in_pnl),
      amountRub: Math.round(Number(c.amount_rub)),
      txCount: Number(c.tx_count ?? 0),
      sharePct: slicesTotal > 0 ? Math.round((Number(c.amount_rub) / slicesTotal) * 100) : 0,
    })),
    costCoveragePct,
    hasExpenses: rawSlices.length > 0,
    hasWbReport: months.some((m) => m.source === "wb_report"),
    reportUntil: reportUntilRaw,
    advertSpendRub: sum((m) => m.advertRub),
    currency,
    wbBalance: bal
      ? {
          currency: String(bal.currency ?? "RUB"),
          current: Math.round(Number(bal.current_amount ?? 0)),
          forWithdraw: Math.round(Number(bal.for_withdraw ?? 0)),
          checkedAt: String(bal.checked_at),
        }
      : null,
  };
}

// Валюта кабинета — из последней строки отчёта о реализации (WB отдаёт её в
// currency_name). Кэшируется на процесс: значение меняется раз в жизни.
let _storeCurrency: string | null = null;
export async function storeCurrency(db: SupabaseClient): Promise<string> {
  if (_storeCurrency) return _storeCurrency;
  const { data } = await db
    .from("raw_finance_report")
    .select("currency_name")
    .eq("store_id", DEMO_STORE_ID)
    .not("currency_name", "is", null)
    .order("rr_dt", { ascending: false })
    .limit(1)
    .maybeSingle();
  _storeCurrency = (data?.currency_name as string) || "RUB";
  return _storeCurrency;
}

// ─── Поиск счёта/статьи по человеческому названию (бот и ИИ) ─────────────────

export type NamedRef = { id: string; name: string; currency?: Currency; direction?: string };

// Поиск по подстроке без учёта регистра. Возвращает все совпадения — вызывающий
// решает, переспросить пользователя или взять единственное.
export async function findAccounts(
  db: SupabaseClient,
  query: string,
): Promise<{ id: string; name: string; currency: Currency }[]> {
  const { accounts } = await getFinanceRefs(db);
  const q = query.trim().toLowerCase();
  if (!q) return accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }));
  return accounts
    .filter((a) => a.name.toLowerCase().includes(q))
    .map((a) => ({ id: a.id, name: a.name, currency: a.currency }));
}

// Счёт «по умолчанию» для голосового ввода («потратил 15 тысяч на рекламу»):
// самый ходовой рублёвый счёт. Ассистент обязан назвать его в ответе, чтобы
// человек заметил ошибку и поправил.
export async function pickDefaultAccount(
  db: SupabaseClient,
): Promise<{ id: string; name: string; currency: Currency } | null> {
  const { accounts } = await getCashOverview(db);
  const rubles = accounts.filter((a) => a.currency === "rub");
  const pool = rubles.length ? rubles : accounts;
  if (!pool.length) return null;
  const best = [...pool].sort((a, b) => b.txCount - a.txCount)[0];
  return { id: best.id, name: best.name, currency: best.currency };
}

export async function findCategories(
  db: SupabaseClient,
  query: string,
  direction: "in" | "out" = "out",
): Promise<ExpenseCategory[]> {
  const { categories } = await getFinanceRefs(db);
  const pool = categories.filter((c) => c.direction === direction);
  const q = query.trim().toLowerCase();
  if (!q) return pool;
  const exact = pool.filter((c) => c.name.toLowerCase() === q);
  if (exact.length) return exact;
  return pool.filter(
    (c) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()),
  );
}

// ─── Запись операций ─────────────────────────────────────────────────────────

export type CashActor = { id: string; name: string; role: MemberRole; roleLabel: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Автор операции: в демо-режиме (роль из cookie) id не UUID — пишем null,
// иначе Postgres отвергнет вставку целиком.
const authorId = (actor: CashActor) => (UUID_RE.test(actor.id) ? actor.id : null);

export type CashTxInput = {
  kind: CashTxKind;
  accountId: string;
  toAccountId?: string | null;
  categoryId?: string | null;
  amount: number;
  amountTo?: number | null;
  occurredOn?: string | null; // yyyy-mm-dd, по умолчанию сегодня
  note?: string | null;
  rateToRub?: number | null; // курс валюты счёта; по умолчанию — общий курс
  source?: CashTx["source"];
  sourceRef?: string | null; // внешний ключ (номер отчёта WB) — защита от дублей
};

export type CashResult =
  | { ok: true; id: string; amountRub: number; message: string }
  | {
      ok: false;
      code: "forbidden" | "invalid" | "not_found" | "db_error";
      message: string;
    };

// Крупный расход руководство должно видеть сразу, не заходя в систему.
export const CASH_NOTIFY_THRESHOLD_RUB = 100_000;

const NOTE_MAX = 500;

const rubFmt = (n: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(n)) + " ₽";

const KIND_LABEL: Record<CashTxKind, string> = {
  in: "Приход",
  out: "Расход",
  transfer: "Перевод",
};

// Создать операцию кассы. Валюту и курс определяет сервер по счёту — клиент
// (веб/бот/ИИ) их не задаёт, иначе рублёвые суммы в ОПиУ можно подделать.
export async function createCashTx(
  db: SupabaseClient,
  actor: CashActor,
  input: CashTxInput,
): Promise<CashResult> {
  if (!can(actor.role, "finance:expense")) {
    return { ok: false, code: "forbidden", message: "Нет права вести кассу и расходы." };
  }

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: "invalid", message: "Сумма должна быть больше нуля." };
  }
  if (amount > 1_000_000_000) {
    return { ok: false, code: "invalid", message: "Слишком большая сумма — проверьте ввод." };
  }

  const occurredOn = /^\d{4}-\d{2}-\d{2}$/.test(String(input.occurredOn ?? ""))
    ? String(input.occurredOn)
    : isoDay(new Date());

  // Счёт-источник: из него берём валюту операции
  const { data: acc, error: accErr } = await db
    .from("cash_accounts")
    .select("id, name, currency, archived, org_id")
    .eq("id", input.accountId)
    .eq("org_id", DEMO_ORG_ID)
    .maybeSingle();
  if (accErr) return { ok: false, code: "db_error", message: accErr.message };
  if (!acc || acc.archived) {
    return { ok: false, code: "not_found", message: "Счёт не найден." };
  }
  const currency = acc.currency as Currency;

  let toAccountId: string | null = null;
  let amountTo: number | null = null;
  let categoryId: string | null = null;

  if (input.kind === "transfer") {
    if (!input.toAccountId || input.toAccountId === input.accountId) {
      return { ok: false, code: "invalid", message: "Для перевода нужен второй счёт." };
    }
    const { data: dst } = await db
      .from("cash_accounts")
      .select("id, name, currency, archived")
      .eq("id", input.toAccountId)
      .eq("org_id", DEMO_ORG_ID)
      .maybeSingle();
    if (!dst || dst.archived) {
      return { ok: false, code: "not_found", message: "Счёт зачисления не найден." };
    }
    toAccountId = String(dst.id);
    // Разные валюты → сумма зачисления обязательна (курс обменника)
    const to = Number(input.amountTo);
    if (dst.currency !== currency && (!Number.isFinite(to) || to <= 0)) {
      return {
        ok: false,
        code: "invalid",
        message: "Счета в разных валютах — укажите, сколько зачислено на второй счёт.",
      };
    }
    amountTo = Number.isFinite(to) && to > 0 ? to : amount;
  } else {
    if (input.categoryId) {
      const { data: cat } = await db
        .from("expense_categories")
        .select("id, direction")
        .eq("id", input.categoryId)
        .eq("org_id", DEMO_ORG_ID)
        .maybeSingle();
      if (!cat) return { ok: false, code: "not_found", message: "Статья не найдена." };
      if (cat.direction !== input.kind) {
        return {
          ok: false,
          code: "invalid",
          message: `Статья не подходит: она для операций «${cat.direction === "out" ? "расход" : "приход"}».`,
        };
      }
      categoryId = String(cat.id);
    } else if (input.kind === "out") {
      return { ok: false, code: "invalid", message: "Укажите статью расхода." };
    }
  }

  // Курс к рублю: свой можно передать (реальный курс сделки), иначе общий
  const rate =
    currency === "rub"
      ? 1
      : Number(input.rateToRub) > 0
        ? Number(input.rateToRub)
        : (EXCHANGE_RATES[currency] ?? 1);

  const { data, error } = await db
    .from("cash_tx")
    .insert({
      org_id: DEMO_ORG_ID,
      kind: input.kind,
      account_id: String(acc.id),
      to_account_id: toAccountId,
      category_id: categoryId,
      amount,
      amount_to: amountTo,
      currency,
      rate_to_rub: rate,
      occurred_on: occurredOn,
      note: input.note ? String(input.note).slice(0, NOTE_MAX) : null,
      source: input.source ?? "manual",
      source_ref: input.sourceRef ?? null,
      created_by: authorId(actor),
    })
    .select("id, amount_rub, category:expense_categories(name)")
    .single();
  if (error || !data) {
    return { ok: false, code: "db_error", message: error?.message ?? "Ошибка записи" };
  }

  const amountRub = Math.round(Number(data.amount_rub ?? 0));
  const catName = first(data.category as { name: string } | { name: string }[] | null)?.name ?? null;
  const what =
    input.kind === "transfer"
      ? `перевод ${rubFmt(amountRub)}`
      : `${input.kind === "out" ? "расход" : "приход"} ${rubFmt(amountRub)}${catName ? ` · ${catName}` : ""}`;

  // Крупные расходы — пушем директору (best effort, не роняет запись)
  if (input.kind === "out" && amountRub >= CASH_NOTIFY_THRESHOLD_RUB) {
    void notifyRoles(
      ["owner"],
      `💸 <b>Крупный расход</b> — ${tgEsc(rubFmt(amountRub))}\n` +
        `Статья: <b>${tgEsc(catName ?? "без статьи")}</b>\n` +
        `Счёт: ${tgEsc(String(acc.name))}\n` +
        `Внёс: ${tgEsc(actor.name)} (${tgEsc(actor.roleLabel)})` +
        (input.note ? `\nКомментарий: ${tgEsc(String(input.note).slice(0, 200))}` : ""),
    );
  }

  return {
    ok: true,
    id: String(data.id),
    amountRub,
    message: `${KIND_LABEL[input.kind]} записан: ${what} (${occurredOn}).`,
  };
}

// Оплата поставки — это тоже уход денег, поэтому зеркалим её в кассу:
// иначе остаток на счетах врал бы после каждого платежа фабрике.
// Счёт подбираем по валюте платежа; нет такого счёта — молча пропускаем
// (оплата поставки всё равно сохранена в карточке поставки).
// Статья с in_pnl = false: в прибыль закуп войдёт через себестоимость.
export async function mirrorSupplyPaymentToCash(
  db: SupabaseClient,
  actor: CashActor,
  payment: { id: string; kind: "goods" | "cargo"; amount: number; currency: Currency; paidAt: string; note?: string | null; supplyTitle?: string | null },
): Promise<boolean> {
  try {
    const { accounts, categories } = await getFinanceRefs(db);
    const account = accounts.find((a) => a.currency === payment.currency);
    if (!account) return false;

    const wanted = payment.kind === "goods" ? "Закуп товара" : "Карго и доставка";
    const category =
      categories.find((c) => c.direction === "out" && c.name === wanted) ??
      categories.find((c) => c.direction === "out" && c.name === "Прочие расходы");
    if (!category) return false;

    const { error } = await db.from("cash_tx").insert({
      org_id: DEMO_ORG_ID,
      kind: "out",
      account_id: account.id,
      category_id: category.id,
      amount: payment.amount,
      currency: payment.currency,
      rate_to_rub: payment.currency === "rub" ? 1 : (EXCHANGE_RATES[payment.currency] ?? 1),
      occurred_on: payment.paidAt,
      note:
        `Оплата поставки${payment.supplyTitle ? ` «${payment.supplyTitle}»` : ""}` +
        (payment.note ? ` · ${payment.note}` : ""),
      source: "supply_payment",
      source_id: payment.id,
      created_by: authorId(actor),
    });
    // 23505 — платёж уже зеркалили (повторный вызов); это не ошибка
    if (error && error.code !== "23505") {
      console.error("[cash] зеркалирование оплаты поставки:", error.message);
      return false;
    }
    return !error;
  } catch (e) {
    console.error("[cash] зеркалирование оплаты поставки:", e);
    return false;
  }
}

// Поступления от Wildberries — по отчётам о реализации.
// WB перечисляет деньги за отчётный период; сумму периода мы уже умеем считать
// (agg_wb_payouts). Заводим её приходом в кассу, чтобы «сколько денег» не
// требовало ручного ввода после каждой выплаты маркетплейса.
// Защита от дублей — уникальный (source, source_ref) по номеру отчёта.
// Счёт: первый в валюте кабинета; если такого нет — создаём «Счёт WB».
export async function syncWbPayoutsToCash(
  db: SupabaseClient,
  actor: CashActor,
  sinceDays = 90,
): Promise<{ created: number; skipped: number }> {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);

  const { data, error } = await db.rpc("agg_wb_payouts", {
    p_store: DEMO_STORE_ID,
    p_since: isoDay(since),
  });
  if (error) throw new Error(error.message);
  const reports = (data ?? []) as {
    report_id: number;
    period_start: string;
    period_end: string;
    currency: string | null;
    payout: number;
  }[];
  if (!reports.length) return { created: 0, skipped: 0 };

  const currency = ((reports[0].currency ?? "RUB").toLowerCase() as Currency) ?? "rub";
  const { accounts, categories } = await getFinanceRefs(db);

  let account = accounts.find((a) => a.kind === "wb" && a.currency === currency)
    ?? accounts.find((a) => a.currency === currency);
  if (!account) {
    const created = await createCashAccount(db, actor, {
      name: "Счёт WB",
      kind: "wb",
      currency,
    });
    if (!created.ok) throw new Error(created.message);
    account = { id: created.id, name: "Счёт WB", kind: "wb", currency };
  }

  const category = categories.find((c) => c.direction === "in" && c.name === "Поступление от WB");

  // Уже заведённые отчёты — чтобы не гонять заведомо дублирующие вставки
  const { data: existing } = await db
    .from("cash_tx")
    .select("source_ref")
    .eq("org_id", DEMO_ORG_ID)
    .eq("source", "wb_payout")
    .not("source_ref", "is", null)
    .limit(1000);
  const known = new Set(
    ((existing ?? []) as { source_ref: string }[]).map((r) => String(r.source_ref)),
  );

  let created = 0;
  let skipped = 0;
  for (const r of reports) {
    const ref = String(r.report_id);
    const amount = Math.round(Number(r.payout));
    if (known.has(ref)) {
      skipped += 1;
      continue;
    }
    if (amount <= 0) {
      // Отрицательный итог периода (возвраты перевесили) — это не приход;
      // такие периоды показываем в ОПиУ, но деньгами не двигаем.
      skipped += 1;
      continue;
    }
    const { error: insErr } = await db.from("cash_tx").insert({
      org_id: DEMO_ORG_ID,
      kind: "in",
      account_id: account.id,
      category_id: category?.id ?? null,
      amount,
      currency,
      rate_to_rub: currency === "rub" ? 1 : (EXCHANGE_RATES[currency] ?? 1),
      occurred_on: r.period_end ?? isoDay(new Date()),
      note: `Выплата WB за период ${r.period_start} — ${r.period_end} (отчёт ${ref})`,
      source: "wb_payout",
      source_ref: ref,
      created_by: authorId(actor),
    });
    // 23505 — отчёт уже заводили параллельным прогоном, это не ошибка
    if (insErr && insErr.code !== "23505") {
      console.error("[cash] поступление WB:", insErr.message);
      skipped += 1;
      continue;
    }
    if (insErr) skipped += 1;
    else created += 1;
  }
  return { created, skipped };
}

// Удалить ошибочную операцию (только руководители — право finance:expense)
export async function deleteCashTx(
  db: SupabaseClient,
  actor: CashActor,
  txId: string,
): Promise<CashResult> {
  if (!can(actor.role, "finance:expense")) {
    return { ok: false, code: "forbidden", message: "Нет права вести кассу и расходы." };
  }
  const { data: tx } = await db
    .from("cash_tx")
    .select("id, amount_rub, source")
    .eq("id", txId)
    .eq("org_id", DEMO_ORG_ID)
    .maybeSingle();
  if (!tx) return { ok: false, code: "not_found", message: "Операция не найдена." };
  if (tx.source === "supply_payment") {
    return {
      ok: false,
      code: "invalid",
      message: "Это оплата поставки — удаляйте её в карточке поставки.",
    };
  }
  const { error } = await db.from("cash_tx").delete().eq("id", txId);
  if (error) return { ok: false, code: "db_error", message: error.message };
  return {
    ok: true,
    id: String(txId),
    amountRub: Math.round(Number(tx.amount_rub ?? 0)),
    message: "Операция удалена.",
  };
}

// Завести счёт (наличные, банк, карта, юани…)
export async function createCashAccount(
  db: SupabaseClient,
  actor: CashActor,
  input: { name: string; kind: CashAccountKind; currency: Currency; openingBalance?: number },
): Promise<CashResult> {
  if (!can(actor.role, "finance:expense")) {
    return { ok: false, code: "forbidden", message: "Нет права вести кассу." };
  }
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, code: "invalid", message: "Укажите название счёта." };

  const { data, error } = await db
    .from("cash_accounts")
    .insert({
      org_id: DEMO_ORG_ID,
      name: name.slice(0, 80),
      kind: input.kind,
      currency: input.currency,
      opening_balance: Number(input.openingBalance ?? 0) || 0,
      created_by: authorId(actor),
    })
    .select("id")
    .single();
  if (error || !data) {
    const dup = error?.code === "23505";
    return {
      ok: false,
      code: dup ? "invalid" : "db_error",
      message: dup ? "Счёт с таким названием уже есть." : (error?.message ?? "Ошибка записи"),
    };
  }
  return { ok: true, id: String(data.id), amountRub: 0, message: `Счёт «${name}» создан.` };
}

// Завести свою статью расхода/прихода
export async function createExpenseCategory(
  db: SupabaseClient,
  actor: CashActor,
  input: { name: string; direction: "in" | "out"; inPnl?: boolean; emoji?: string | null },
): Promise<CashResult> {
  if (!can(actor.role, "finance:expense")) {
    return { ok: false, code: "forbidden", message: "Нет права вести кассу." };
  }
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, code: "invalid", message: "Укажите название статьи." };

  const { data, error } = await db
    .from("expense_categories")
    .insert({
      org_id: DEMO_ORG_ID,
      name: name.slice(0, 60),
      direction: input.direction,
      in_pnl: input.inPnl ?? true,
      emoji: input.emoji ? String(input.emoji).slice(0, 8) : null,
      sort_order: 200,
    })
    .select("id")
    .single();
  if (error || !data) {
    const dup = error?.code === "23505";
    return {
      ok: false,
      code: dup ? "invalid" : "db_error",
      message: dup ? "Статья с таким названием уже есть." : (error?.message ?? "Ошибка записи"),
    };
  }
  return { ok: true, id: String(data.id), amountRub: 0, message: `Статья «${name}» создана.` };
}
