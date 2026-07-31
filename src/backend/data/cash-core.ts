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

  const [balRes, flowRes, txRes] = await Promise.all([
    db.rpc("agg_cash_balances", { p_org: DEMO_ORG_ID }),
    db.rpc("agg_cash_flow_monthly", { p_org: DEMO_ORG_ID, p_since: flowSince }),
    db
      .from("cash_tx")
      .select(CASH_TX_SELECT)
      .eq("org_id", DEMO_ORG_ID)
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(30),
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

  return {
    accounts,
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

// ОПиУ: выручка − удержания WB − себестоимость − расходы = чистая прибыль.
// Удержания WB = выручка − «к перечислению» (raw_sales.for_pay): реальная
// комиссия маркетплейса по фактическим продажам, доступна всегда.
// Логистику/хранение/штрафы вносят статьями расходов — двойного счёта нет.
export async function getPnlView(db: SupabaseClient, monthsBack = 6): Promise<PnlView> {
  const sinceDate = isoDay(monthStart(monthsBack - 1));
  const today = isoDay(new Date());

  const [salesRes, cogsRes, expRes, incomeRes, advRes, slicesRes] = await Promise.all([
    db.rpc("agg_sales_monthly", { p_store: DEMO_STORE_ID, p_since: `${sinceDate}T00:00:00` }),
    db.rpc("agg_cogs_monthly", { p_store: DEMO_STORE_ID, p_since: `${sinceDate}T00:00:00` }),
    db.rpc("agg_expenses_monthly", { p_org: DEMO_ORG_ID, p_since: sinceDate }),
    db.rpc("agg_other_income_monthly", { p_org: DEMO_ORG_ID, p_since: sinceDate }),
    db.rpc("agg_advert_monthly", { p_store: DEMO_STORE_ID, p_since: sinceDate }),
    db.rpc("agg_expenses_by_category", { p_org: DEMO_ORG_ID, p_from: sinceDate, p_to: today }),
  ]);
  for (const r of [salesRes, cogsRes, expRes, incomeRes, advRes, slicesRes]) {
    if (r.error) throw r.error;
  }

  type SalesRow = { month: string; qty: number; revenue_rub: number; for_pay_rub: number };
  type CogsRow = { month: string; cogs_rub: number; covered_qty: number; total_qty: number };
  type ExpRow = { month: string; opex_rub: number; total_rub: number };
  type IncomeRow = { month: string; income_rub: number };

  const sales = new Map(((salesRes.data ?? []) as SalesRow[]).map((r) => [String(r.month), r]));
  const cogs = new Map(((cogsRes.data ?? []) as CogsRow[]).map((r) => [String(r.month), r]));
  const opex = new Map(((expRes.data ?? []) as ExpRow[]).map((r) => [String(r.month), r]));
  const income = new Map(((incomeRes.data ?? []) as IncomeRow[]).map((r) => [String(r.month), r]));

  // Месяцы периода — сплошным рядом, даже если данных за месяц нет
  const months: PnlMonth[] = [];
  for (let i = 0; i < monthsBack; i += 1) {
    const key = isoDay(monthStart(monthsBack - 1 - i));
    const s = sales.get(key);
    const c = cogs.get(key);
    const e = opex.get(key);
    const inc = income.get(key);

    const revenueRub = Math.round(Number(s?.revenue_rub ?? 0));
    const forPayRub = Math.round(Number(s?.for_pay_rub ?? 0));
    const wbFeesRub = Math.max(0, revenueRub - forPayRub);
    const cogsRub = Math.round(Number(c?.cogs_rub ?? 0));
    const opexRub = Math.round(Number(e?.opex_rub ?? 0));
    const otherIncomeRub = Math.round(Number(inc?.income_rub ?? 0));
    const grossRub = revenueRub - wbFeesRub - cogsRub;
    const netRub = grossRub - opexRub + otherIncomeRub;
    const coveredQty = Number(c?.covered_qty ?? 0);
    const totalQty = Number(c?.total_qty ?? 0);

    months.push({
      month: key,
      label: monthLabel(key, true),
      revenueRub,
      wbFeesRub,
      cogsRub,
      grossRub,
      opexRub,
      otherIncomeRub,
      netRub,
      marginPct: revenueRub > 0 ? Math.round((netRub / revenueRub) * 100) : 0,
      qty: Number(s?.qty ?? 0),
      costCoveragePct: totalQty > 0 ? Math.round((coveredQty / totalQty) * 100) : 0,
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
    cogsRub: sum((m) => m.cogsRub),
    grossRub: sum((m) => m.grossRub),
    opexRub: sum((m) => m.opexRub),
    otherIncomeRub: sum((m) => m.otherIncomeRub),
    netRub: totalNet,
    marginPct: totalRevenue > 0 ? Math.round((totalNet / totalRevenue) * 100) : 0,
    qty: sum((m) => m.qty),
    costCoveragePct,
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
    advertSpendRub: Math.round(
      ((advRes.data ?? []) as { spend_rub: number }[]).reduce(
        (t, r) => t + Number(r.spend_rub ?? 0),
        0,
      ),
    ),
  };
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
