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
import * as mock from "./mock";
import * as db from "./supabase";

export const dataSource = () => (getSupabaseAdmin() ? "supabase" : "mock");

// Общий тег для точечного сброса кэша чтения после любой мутации.
export const WB_DATA_TAG = "wb-data";

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
    periodEnd: "2026-12-28",
    amountRub: 0,
    factToDateRub: 0,
    planToDateRub: 0,
    completionPct: 0,
    dailyPlanRub: 0,
    neededDailyRub: 0,
    days: [],
  }),
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
// Без кэша: рабочая очередь дизайнера, мутации частые — свежесть важнее.

export const getDesignRequests = () =>
  fromDb(db.getDesignRequests, () => []);

// ─── Регламент и отчёты ───────────────────────────────────────────────────────
// НЕ кэшируются: readDuties() → ensureDutyAssignments() пишет в БД (генерация
// нарядов на день + пометка просроченных missed). Плюс зависят от userId/date.

export const getMyDuties = (userId: string) =>
  fromDb((client) => db.getMyDuties(client, userId), () => []);

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
    getStocksOverview,
    getFinanceRows,
    getSalesPlanView,
    getTasks,
    getIntegrations,
    getTariffs,
    getTeam,
    getFactories,
    getSupplies,
    getFulfillment,
  ];
  let failed = 0;
  for (let i = 0; i < getters.length; i += 4) {
    const results = await Promise.allSettled(getters.slice(i, i + 4).map((g) => g()));
    failed += results.filter((r) => r.status === "rejected").length;
  }
  return { ms: Date.now() - t, failed };
}

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
