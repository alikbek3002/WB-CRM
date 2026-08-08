// Единая точка доступа к данным для страниц и API-роутов.
// БД — источник правды: если заданы ключи Supabase (service_role), читаем ТОЛЬКО
// из реальной БД; пустые таблицы → честные нули/пустые списки. Ошибки чтения
// пробрасываются (их видно в error-boundary), а не маскируются демо-данными.
// Mock (mock.ts) используется исключительно когда Supabase не настроен.
//
// КЭШ ЧТЕНИЯ. Сеть до удалённого Supabase нестабильна: те же агрегаты иногда
// отдаются за 6–11 с (и ловят connect-timeout), из-за чего переключение вкладок
// «залипает». Read-only геттеры обёрнуты в unstable_cache — повторные заходы на
// вкладку читаются из памяти сервера (доли мс) вместо round-trip к Supabase.
// Все мутации (API-роуты, синк) сбрасывают кэш через revalidateTag(WB_DATA_TAG),
// поэтому созданное/изменённое видно сразу; TTL влияет только на задержку
// появления фоновых обновлений (например, синка WB).

import type { SupabaseClient } from "@supabase/supabase-js";
import { unstable_cache } from "next/cache";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import type { MemberRole } from "@/shared/rbac";
import type { DutyStatsPeriod, PnlMonth, PnlView } from "@/shared/types";
import * as mock from "./mock";
import * as payouts from "./payouts-core";
import * as db from "./supabase";

export const dataSource = () => (getSupabaseAdmin() ? "supabase" : "mock");

// Общий тег: сбрасывает ВЕСЬ кэш чтения. Нужен только там, где меняется всё
// сразу (синк WB, ручной сброс). Точечные мутации должны звать invalidateWbData
// со списком затронутых областей — см. ./revalidate.
export const WB_DATA_TAG = "wb-data";

// Отдельный тег для строки членства в getSession(). Раньше она висела на
// WB_DATA_TAG, и любая мутация заставляла layout снова идти в Supabase.
export const SESSION_TAG = "wb-session";

// Области кэша = ключи cachedRead ниже. Мутация сбрасывает только свои.
export type WbScope =
  | "dashboard"
  | "products"
  | "product-groups"
  | "finance"
  | "sales-plan"
  | "cash"
  | "finance-refs"
  | "expenses"
  | "payroll"
  | "members"
  | "pnl"
  | "unit-econ"
  | "wb-incomes"
  | "tasks"
  | "integrations"
  | "tariffs"
  | "rnp"
  | "team"
  | "factories"
  | "supplies"
  | "fulfillment"
  | "fulfillment-partners"
  | "stocks-overview"
  | "duty-stats"
  | "design";

// Сколько переиспользовать результат чтения между навигациями (сек).
// 30 мин — в такт авто-синку WB: каждый синк сбрасывает тег и тут же прогревает
// кэш заново (warmReadCache), а любая мутация инвалидирует тегом. Поэтому юзер
// практически никогда не попадает на холодный рендер тяжёлых агрегатов.
const READ_TTL_SECONDS = 1800;

// БД настроена → реальные данные (пустая БД = нули); нет БД → демо-режим.
// Без кэша — для функций, которые ПИШУТ в БД при чтении или зависят от юзера/даты.
async function fromDb<T>(
  read: (client: SupabaseClient) => Promise<T>,
  demo: () => T,
): Promise<T> {
  const admin = getSupabaseAdmin();
  if (!admin) return demo();
  return read(admin);
}

// То же, но результат кэшируется (тег WB_DATA_TAG + пер-ключевой тег).
function cachedRead<T>(
  key: string,
  read: (client: SupabaseClient) => Promise<T>,
  demo: () => T,
): () => Promise<T> {
  return unstable_cache(() => fromDb(read, demo), ["wb-data", key], {
    revalidate: READ_TTL_SECONDS,
    tags: [WB_DATA_TAG, `${WB_DATA_TAG}:${key}`],
  });
}

export const getDashboardData = cachedRead(
  "dashboard",
  db.getDashboardData,
  mock.getDashboardData,
);

export const getProductList = cachedRead(
  "products",
  db.getProductList,
  mock.getProductList,
);

export const getProductGroups = cachedRead(
  "product-groups",
  db.getProductGroups,
  mock.getProductGroups,
);

export const getFinanceRows = cachedRead(
  "finance",
  db.getFinanceRows,
  mock.getFinanceRows,
);

export const getSalesPlanView = cachedRead(
  "sales-plan",
  db.getSalesPlanView,
  () => ({
    hasPlan: false,
    periodStart: "2026-07-02",
    periodEnd: "2026-12-31",
    amountRub: 0,
    factToDateRub: 0,
    planToDateRub: 0,
    completionPct: 0,
    completionTotalPct: 0,
    dailyPlanRub: 0,
    neededDailyRub: 0,
    remainingRub: 0,
    remainingDays: 0,
    avgDailyFactRub: 0,
    forecastRub: 0,
    forecastPct: 0,
    currency: "RUB",
    days: [],
  }),
);

// ─── Касса, расходы, ОПиУ ─────────────────────────────────────────────────────
// Без БД (демо-режим) — честные нули: выдумывать деньги компании нельзя.

export const getCashOverview = cachedRead("cash", db.getCashOverview, () => ({
  accounts: [],
  wbBalance: null,
  totalRub: 0,
  monthInRub: 0,
  monthOutRub: 0,
  flow: [],
  recent: [],
}));

export const getFinanceRefs = cachedRead("finance-refs", db.getFinanceRefs, () => ({
  accounts: [],
  categories: [],
}));

// Параметризованы периодом — кэшируем по ключу периода
export const getExpensesView = (from?: string, to?: string) =>
  unstable_cache(
    () =>
      fromDb(
        (client) => db.getExpensesView(client, from, to),
        () => ({
          from: from ?? "",
          to: to ?? "",
          totalRub: 0,
          opexRub: 0,
          categories: [],
          items: [],
          monthly: [],
        }),
      ),
    ["wb-data", "expenses", from ?? "", to ?? ""],
    { revalidate: READ_TTL_SECONDS, tags: [WB_DATA_TAG, `${WB_DATA_TAG}:expenses`] },
  )();

// Выплаты команде — параметризованы периодом
export const getPayrollView = (from?: string, to?: string) =>
  unstable_cache(
    () =>
      fromDb(
        (client) => db.getPayrollView(client, from, to),
        () => ({
          from: from ?? "",
          to: to ?? "",
          totalRub: 0,
          people: [],
          unassignedRub: 0,
          unassignedCount: 0,
          items: [],
          pendingRub: 0,
        }),
      ),
    ["wb-data", "payroll", from ?? "", to ?? ""],
    { revalidate: READ_TTL_SECONDS, tags: [WB_DATA_TAG, `${WB_DATA_TAG}:payroll`] },
  )();

// Сотрудники как справочник адресатов выплат (для форм)
export const getMembers = cachedRead("members", db.listMembers, () => []);

const EMPTY_PNL_MONTH: PnlMonth = {
  month: "",
  label: "Итого",
  revenueRub: 0,
  wbFeesRub: 0,
  commissionRub: 0,
  acquiringRub: 0,
  logisticsRub: 0,
  storageRub: 0,
  penaltyRub: 0,
  acceptanceRub: 0,
  deductionRub: 0,
  advertRub: 0,
  cogsRub: 0,
  grossRub: 0,
  opexRub: 0,
  otherIncomeRub: 0,
  netRub: 0,
  marginPct: 0,
  qty: 0,
  costCoveragePct: 0,
  source: "estimate",
};

export const getPnlView = (monthsBack = 6) =>
  unstable_cache(
    () =>
      fromDb<PnlView>(
        (client) => db.getPnlView(client, monthsBack),
        () => ({
          months: [],
          total: EMPTY_PNL_MONTH,
          expenseSlices: [],
          costCoveragePct: 0,
          hasExpenses: false,
          hasWbReport: false,
          reportUntil: null,
          advertSpendRub: 0,
          currency: "RUB",
          wbBalance: null,
          deductionDetails: [],
        }),
      ),
    ["wb-data", "pnl", String(monthsBack)],
    { revalidate: READ_TTL_SECONDS, tags: [WB_DATA_TAG, `${WB_DATA_TAG}:pnl`] },
  )();

// Юнит-экономика по товарам — параметризована периодом (30/90 дней)
export const getUnitEconomics = (days = 30) =>
  unstable_cache(
    () =>
      fromDb(
        (client) => db.getUnitEconomics(client, days),
        () => ({
          from: "",
          to: "",
          days,
          rows: [],
          unallocated: null,
          totals: {
            saleQty: 0,
            revenueRub: 0,
            wbFeesRub: 0,
            advertRub: 0,
            cogsRub: 0,
            profitRub: 0,
            marginPct: 0,
          },
          storageSource: "finance" as const,
          costCoveragePct: 0,
        }),
      ),
    ["wb-data", "unit-econ", String(days)],
    { revalidate: READ_TTL_SECONDS, tags: [WB_DATA_TAG, `${WB_DATA_TAG}:unit-econ`] },
  )();

// Поставки FBW (приёмки складов WB)
export const getWbIncomes = cachedRead("wb-incomes", db.getWbIncomes, () => []);

// Заявки на выплату: список зависит от того, кто смотрит (свои vs все),
// и меняется каждым решением — кэшировать нечего.
export const getPayouts = (viewer: { id: string; role: MemberRole }) =>
  fromDb(
    (client) => payouts.getPayouts(client, viewer),
    () => ({ items: [], pendingCount: 0, pendingRub: 0, approvedRub: 0, paidMonthRub: 0 }),
  );

export const getTasks = cachedRead("tasks", db.getTasks, mock.getTasks);

export const getIntegrations = cachedRead(
  "integrations",
  db.getIntegrations,
  mock.getIntegrations,
);

export const getTariffs = cachedRead("tariffs", db.getTariffs, mock.getTariffs);

export const getRnpProducts = cachedRead(
  "rnp",
  db.getRnpProducts,
  mock.getRnpProducts,
);

export const getTeam = cachedRead("team", db.getTeam, mock.getTeam);

// ─── Цепочка поставок ─────────────────────────────────────────────────────────

export const getFactories = cachedRead(
  "factories",
  db.getFactories,
  mock.getFactories,
);

export const getSupplies = cachedRead(
  "supplies",
  db.getSupplies,
  mock.getSupplies,
);

export const getFulfillment = cachedRead(
  "fulfillment",
  db.getFulfillment,
  mock.getFulfillment,
);

export const getFulfillmentPartners = cachedRead(
  "fulfillment-partners",
  db.getFulfillmentPartners,
  () => [],
);

// ─── Остатки по складам ───────────────────────────────────────────────────────

export const getStocksOverview = cachedRead(
  "stocks-overview",
  db.getStocksOverview,
  () => ({ warehouses: [], totalQty: 0, inTransitQty: 0, productsWithStock: 0 }),
);

// Параметризованы товаром — без кэша (строк мало, чтение быстрое)
export const getProductStocks = (productId: string) =>
  fromDb((client) => db.getProductStocks(client, productId), () => []);

export const getProductWarehouseOrders = (nmId: number) =>
  fromDb(
    (client) => db.getProductWarehouseOrders(client, nmId),
    () => new Map<string, number>(),
  );

// ─── Дизайн карточек ──────────────────────────────────────────────────────────
// Кэшируем под своим тегом. Раньше очередь дизайнера читалась мимо кэша ради
// свежести — и вкладка стабильно стоила ~1.9 с на каждый заход. Свежесть от
// кэша не страдает: оба роута дизайна зовут invalidateWbData("design") после
// записи, поэтому изменение видно сразу, а не через TTL.
export const getDesignRequests = cachedRead("design", db.getDesignRequests, () => []);

// ─── Регламент и отчёты ───────────────────────────────────────────────────────
// НЕ кэшируются: readDuties() → ensureDutyAssignments() пишет в БД (генерация
// нарядов на день + пометка просроченных missed). Плюс зависят от userId/date.

export const getMyDuties = (userId: string) =>
  fromDb((client) => db.getMyDuties(client, userId), () => []);

// Статистика дисциплины регламента (7/30 дней) — чистое чтение, кэшируем
// коротко: данные меняются в течение дня по мере закрытия задач.
const EMPTY_DUTY_PERIOD = (days: 7 | 30): DutyStatsPeriod => ({
  days,
  from: "",
  employees: [],
  teamCompletionPct: 0,
  teamOnTimePct: 0,
});

export const getDutyStats = unstable_cache(
  () =>
    fromDb(db.getDutyStats, () => ({
      d7: EMPTY_DUTY_PERIOD(7),
      d30: EMPTY_DUTY_PERIOD(30),
    })),
  ["wb-data", "duty-stats"],
  { revalidate: 300, tags: [WB_DATA_TAG, `${WB_DATA_TAG}:duty-stats`] },
);

// Прогрев кэша чтения: пересчитать все кэшируемые геттеры, чтобы юзер открывал
// вкладки уже с тёплым кэшем. ВАЖНО: звать из ОТДЕЛЬНОГО запроса ПОСЛЕ синка
// (/api/cron/warm), а не из запроса, где был revalidateTag — Next сбрасывает
// тег в конце того запроса, и прогретое тут же выбрасывается (ловили вживую).
// Партиями по 4 — тринадцать параллельных геттеров устраивали шторм запросов
// к Supabase и ловили statement timeout.
export async function warmReadCache(): Promise<{ ms: number; failed: number }> {
  const t = Date.now();
  const getters = [
    getDashboardData,
    getRnpProducts,
    getProductList,
    getProductGroups,
    getStocksOverview,
    getFinanceRows,
    getSalesPlanView,
    getCashOverview,
    getFinanceRefs,
    () => getPnlView(6), // ОПиУ — самая тяжёлая вкладка финансов
    () => getExpensesView(), // расходы текущего месяца
    () => getPayrollView(), // выплаты команде за текущий месяц
    () => getUnitEconomics(30), // юнит-экономика (страница «Экономика»)
    getWbIncomes,
    getMembers,
    getTasks,
    getIntegrations,
    getTariffs,
    getTeam,
    getFactories,
    getSupplies,
    getFulfillment,
    getFulfillmentPartners,
  ];
  let failed = 0;
  for (let i = 0; i < getters.length; i += 4) {
    const results = await Promise.allSettled(getters.slice(i, i + 4).map((g) => g()));
    failed += results.filter((r) => r.status === "rejected").length;
  }
  return { ms: Date.now() - t, failed };
}

// Отчёты по задачам за день — параметризованы датой, без кэша
export const getTaskReports = (date?: string) =>
  fromDb((client) => db.getTaskReports(client, date), () => []);

export const getReportsBoard = (date?: string) =>
  fromDb(
    (client) => db.getReportsBoard(client, date),
    () => ({
      date: new Date().toLocaleDateString("sv"),
      total: 0,
      done: 0,
      onTime: 0,
      missed: 0,
      pending: 0,
      items: [],
    }),
  );

export type * from "@/shared/types";
