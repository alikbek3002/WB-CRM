// Синхронизация данных Wildberries → Supabase.
// Источники: карточки (контент+фото+описание), цены, остатки, заказы, продажи.
// Пользовательские поля товара (себестоимость, статус, ответственный) НЕ трогаем.
// Каждый источник фиксируется в sync_runs; статус токена — в integration_credentials.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_STORE_ID } from "@/shared/constants";
import { syncWbPayoutsToCash } from "@/backend/data/cash-core";
import {
  decodeTokenMeta,
  fetchAcceptanceReport,
  fetchAccountBalance,
  fetchAdvertCampaigns,
  fetchAdvertStats,
  fetchAllCards,
  fetchBoxTariffs,
  fetchCommissionTariffs,
  fetchFinanceReport,
  fetchSalesFunnelHistory,
  fetchOrders,
  fetchPaidStorage,
  fetchPrices,
  fetchSales,
  fetchSellerInfo,
  fetchWarehouseRemains,
  fetchWbSupplyDetail,
  fetchWbSupplyGoods,
  fetchWbSupplyList,
  getWbToken,
} from "./client";

// Локальная дата yyyy-mm-dd (пояс UTC+5/6 — не toISOString)
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const CHUNK = 500;

// Финансовый отчёт: страница по 100k строк, до 6 страниц за прогон (между
// страницами обязательная минутная пауза — лимит statistics 1 запрос/мин).
// Хвост, который не влез, догрузится следующим запуском по курсору rr_dt.
// 50k строк на страницу: при 100k выгрузка крупного кабинета не укладывалась в
// таймаут запроса и обрывалась (ловили вживую — «operation was aborted»).
const FINANCE_PAGE = 50_000;
const FINANCE_MAX_PAGES = 10;
const FINANCE_TIMEOUT_MS = 600_000;

// Реклама: до 50 кампаний в запросе, 4 партии за прогон, окно 30 дней.
const ADVERT_BATCH = 50;
const ADVERT_MAX_BATCHES = 4;
const ADVERT_WINDOW_DAYS = 30;

// Платное хранение: задача покрывает максимум 8 дней, создание задач ~1/мин.
// Число окон за прогон = maxBatches (cron 3 ≈ 24 дня/ночь; бэкфилл — до 10).
const STORAGE_WINDOW_DAYS = 8;

// Воронка nm-report: ≤20 nmID и ≤7 дней на запрос, лимит 3 запроса/мин.
const FUNNEL_BATCH = 20;
const FUNNEL_WAIT_MS = 21_000;
const FUNNEL_WINDOW_DAYS = 7;

// Платная приёмка: окно задачи максимум 31 день.
const ACCEPTANCE_WINDOW_DAYS = 31;

// Поставки FBW: на каждую изменившуюся поставку 2 запроса (детали + товары),
// поэтому за прогон обрабатываем ограниченную пачку — хвост доедет следующим.
const INCOMES_DETAIL_CAP = 30;
const INCOMES_PAUSE_MS = 1_500;
const WB_SUPPLY_STATUS: Record<number, string> = {
  1: "Не запланировано",
  2: "Запланировано",
  3: "Отгрузка разрешена",
  4: "Идёт приёмка",
  5: "Принято",
  6: "Отклонено",
};

async function chunkedUpsert(
  db: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  chunk = CHUNK,
): Promise<number> {
  for (let i = 0; i < rows.length; i += chunk) {
    const { error } = await db
      .from(table)
      .upsert(rows.slice(i, i + chunk), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  return rows.length;
}

export type WbSyncResult = {
  ok: boolean;
  seller: string | null;
  counts: Record<string, number>;
  errors: string[];
  startedAt: string;
  finishedAt: string;
};

// Один источник = одна запись в sync_runs (успех/ошибка не роняет остальные)
async function runSource(
  db: SupabaseClient,
  source: string,
  fromDate: string | null,
  fn: () => Promise<number>,
  counts: Record<string, number>,
  errors: string[],
): Promise<void> {
  const { data: run, error: runErr } = await db
    .from("sync_runs")
    .insert({
      store_id: DEMO_STORE_ID,
      source,
      status: "running",
      from_date: fromDate,
      to_date: isoDate(new Date()),
    })
    .select("id")
    .single();
  // Источник выполняем даже без записи в sync_runs, но потерю лога не молчим:
  // так уже терялись прогоны wb-payouts/balance из-за CHECK по source (до 0031)
  if (runErr) console.error(`[wb-sync] sync_runs insert (${source}): ${runErr.message}`);
  try {
    const n = await fn();
    counts[source] = n;
    if (run) {
      await db
        .from("sync_runs")
        .update({ status: "success", rows_upserted: n, finished_at: new Date().toISOString() })
        .eq("id", run.id);
    }
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    errors.push(`${source}: ${msg}`);
    if (run) {
      await db
        .from("sync_runs")
        .update({ status: "error", error: msg, finished_at: new Date().toISOString() })
        .eq("id", run.id);
    }
  }
}

// Какие источники тянуть за прогон. Разделение нужно, чтобы частый авто-синк гонял
// только «живые» данные (orders/sales/stocks — инкрементально, дёшево), а тяжёлую
// полную выгрузку каталога (cards+prices) — редко.
export const WB_SYNC_SOURCES = [
  "cards",
  "stocks",
  "orders",
  "sales",
  "finance", // отчёт о реализации: фактические удержания WB (для ОПиУ)
  "advert", // расход на внутреннюю рекламу по дням
  "incomes", // поставки FBW: приёмки на склады WB
  "storage", // платное хранение по товарам (task-based отчёт)
  "acceptance", // платная приёмка (task-based отчёт)
  "funnel", // воронка nm-report → raw_funnel_daily (для РНП)
  "tariffs", // комиссии по категориям + тарифы коробов
] as const;
export type WbSyncSource = (typeof WB_SYNC_SOURCES)[number];

// Дефолт ручного запуска (кнопка «Интеграции»): без task-based отчётов —
// storage/acceptance/funnel идут минутами и запускаются кроном (mode=analytics)
// или явно через body.sources.
export const WB_DEFAULT_SOURCES: readonly WbSyncSource[] = [
  "cards",
  "stocks",
  "orders",
  "sales",
  "finance",
  "advert",
  "incomes",
  "tariffs",
];

// days — стартовое окно заказов/продаж при пустой БД (дальше — по курсору
// last_change_date); maxBatches — партий по 80k за запуск (интерактив 2, cron больше);
// sources — какие источники тянуть.
export async function runWbSync(
  db: SupabaseClient,
  days = 30,
  maxBatches = 2,
  sources: readonly WbSyncSource[] = WB_DEFAULT_SOURCES,
): Promise<WbSyncResult> {
  const startedAt = new Date().toISOString();
  const token = getWbToken();
  if (!token) {
    return {
      ok: false,
      seller: null,
      counts: {},
      errors: ["WB_API_TOKEN не задан в .env.local"],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const counts: Record<string, number> = {};
  const errors: string[] = [];
  const want = new Set<WbSyncSource>(sources);

  // Защита от параллельных запусков: два синка одним токеном душат друг друга
  // rate-limit'ами WB (наблюдалось вживую). Живой запуск = running моложе 15 мин;
  // старше — считаем брошенным (умерший handler) и перехватываем.
  const { data: inFlight } = await db
    .from("sync_runs")
    .select("id, started_at")
    .eq("store_id", DEMO_STORE_ID)
    .eq("status", "running")
    .gte("started_at", new Date(Date.now() - 15 * 60_000).toISOString())
    .limit(1)
    .maybeSingle();
  if (inFlight) {
    return {
      ok: false,
      seller: null,
      counts,
      errors: ["Синхронизация уже выполняется — дождитесь завершения"],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  // Брошенные running (умерший handler) помечаем, чтобы не висели вечно
  await db
    .from("sync_runs")
    .update({ status: "error", error: "прерван (не завершился)", finished_at: new Date().toISOString() })
    .eq("store_id", DEMO_STORE_ID)
    .eq("status", "running");

  // Валидация токена + имя продавца
  let seller: string | null = null;
  try {
    const info = await fetchSellerInfo(token);
    seller = info.tradeMark || info.name;
  } catch (e) {
    // Токен не работает — фиксируем invalid и выходим
    await db.from("integration_credentials").upsert(
      {
        store_id: DEMO_STORE_ID,
        provider: "wb",
        status: "invalid",
        last_checked_at: new Date().toISOString(),
      },
      { onConflict: "store_id,provider" },
    );
    return {
      ok: false,
      seller: null,
      counts,
      errors: [`seller-info: ${(e as Error).message}`],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  // ── Карточки + цены → products (только в полном синке) ──────────────────
  if (want.has("cards")) await runSource(db, "cards", null, async () => {
    const [cards, prices] = await Promise.all([
      fetchAllCards(token),
      fetchPrices(token).catch(() => new Map<number, { price: number; discounted: number }>()),
    ]);

    // Существующие товары: сохраняем пользовательские поля
    const { data: existing, error: exErr } = await db
      .from("products")
      .select("nm_id, status, cost_price, logistics_cost, responsible_user_id")
      .eq("store_id", DEMO_STORE_ID);
    if (exErr) throw new Error(exErr.message);
    const byNm = new Map((existing ?? []).map((p) => [Number(p.nm_id), p]));

    const rows = cards.map((c) => {
      const prev = byNm.get(c.nmID);
      const photos = (c.photos ?? [])
        .map((p) => p.big ?? p.c516x688 ?? p.square)
        .filter(Boolean) as string[];
      const price = prices.get(c.nmID);
      return {
        store_id: DEMO_STORE_ID,
        nm_id: c.nmID,
        vendor_code: c.vendorCode || null,
        title: c.title || `Товар ${c.nmID}`,
        brand: c.brand || null,
        category: c.subjectName || null,
        photo_url: c.photos?.[0]?.c516x688 ?? c.photos?.[0]?.big ?? null,
        photos: photos.length ? photos : null,
        description: c.description || null,
        price_wb: price ? price.price : null,
        price_discounted_wb: price ? price.discounted : null,
        // пользовательские поля — как были (новым — дефолты)
        status: prev?.status ?? "Новинка",
        cost_price: prev?.cost_price ?? 0,
        logistics_cost: prev?.logistics_cost ?? 0,
        responsible_user_id: prev?.responsible_user_id ?? null,
      };
    });
    return chunkedUpsert(db, "products", rows, "store_id,nm_id");
  }, counts, errors);

  // Карта nm_id → product_id — нужна только остаткам (заказы/продажи пишут nm_id напрямую)
  const idByNm = new Map<number, string>();
  if (want.has("stocks")) {
    const { data: prods, error: prodErr } = await db
      .from("products")
      .select("id, nm_id")
      .eq("store_id", DEMO_STORE_ID);
    if (prodErr) errors.push(`products map: ${prodErr.message}`);
    for (const p of prods ?? []) idByNm.set(Number(p.nm_id), p.id as string);
  }

  // ── Остатки → stock_snapshots (срез на сегодня, warehouse_remains) ──────
  if (want.has("stocks")) await runSource(db, "stocks", isoDate(new Date()), async () => {
    const remains = await fetchWarehouseRemains(token);
    const today = isoDate(new Date());
    // Служебные «склады» отчёта: транзит — отдельной строкой, агрегат — мимо
    const IN_TRANSIT = new Set(["В пути до получателей", "В пути возвраты на склад WB"]);
    const SKIP = "Всего находится на складах";
    const rows: Record<string, unknown>[] = [];
    for (const r of remains) {
      const pid = idByNm.get(Number(r.nmId));
      if (!pid) continue; // нет карточки — пропускаем
      let transit = 0;
      for (const w of r.warehouses ?? []) {
        if (w.warehouseName === SKIP) continue;
        if (IN_TRANSIT.has(w.warehouseName)) {
          transit += Number(w.quantity ?? 0);
          continue;
        }
        rows.push({
          product_id: pid,
          warehouse: w.warehouseName,
          size: r.techSize,
          on_stock: Number(w.quantity ?? 0),
          in_transit: 0,
          snapshot_date: today,
        });
      }
      if (transit > 0) {
        rows.push({
          product_id: pid,
          warehouse: "В пути (WB)",
          size: r.techSize,
          on_stock: 0,
          in_transit: transit,
          snapshot_date: today,
        });
      }
    }
    return chunkedUpsert(db, "stock_snapshots", rows, "product_id,warehouse,size,snapshot_date");
  }, counts, errors);

  // ── Заказы / продажи → raw_orders / raw_sales ────────────────────────────
  // WB отдаёт максимум 80 000 строк за запрос (кабинет крупный — 20 тыс.+
  // изменений в день). Партионный цикл: dateFrom = max(last_change_date) из БД
  // (или days назад), партия сразу апсертится, продолжение — со следующего
  // lastChangeDate. Прогресс не теряется: любой запуск продолжает с места.
  const daysAgo = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return isoDate(d);
  };
  const WB_BATCH_LIMIT = 80_000;
  const RATE_WAIT_MS = 61_000; // statistics: 1 запрос/мин на эндпоинт

  async function lastCursor(table: string): Promise<string | null> {
    const { data } = await db
      .from(table)
      .select("last_change_date")
      .eq("store_id", DEMO_STORE_ID)
      .not("last_change_date", "is", null)
      .order("last_change_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.last_change_date as string) ?? null;
  }

  async function syncBatched<T extends { lastChangeDate: string }>(
    table: string,
    fetchFn: (dateFrom: string) => Promise<T[]>,
    mapRow: (r: T) => Record<string, unknown> | null,
    onConflict: string,
    maxBatches: number,
  ): Promise<number> {
    let dateFrom = (await lastCursor(table)) ?? daysAgo(days);
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      if (batch > 0) await new Promise((r) => setTimeout(r, RATE_WAIT_MS));
      const rows = await fetchFn(dateFrom.slice(0, 19));
      if (rows.length === 0) break;
      const mapped = rows.map(mapRow).filter(Boolean) as Record<string, unknown>[];
      total += await chunkedUpsert(db, table, mapped, onConflict);
      if (rows.length < WB_BATCH_LIMIT) break; // хвост забрали — история полная
      dateFrom = rows.reduce(
        (max, r) => (r.lastChangeDate > max ? r.lastChangeDate : max),
        dateFrom,
      );
      if (batch === maxBatches - 1) {
        errors.push(`${table}: история длиннее ${maxBatches} партий — продолжится следующим запуском`);
      }
    }
    return total;
  }

  if (want.has("orders")) await runSource(db, "orders", daysAgo(days), async () => {
    return syncBatched(
      "raw_orders",
      (from) => fetchOrders(token!, from, 150_000),
      (o) =>
        o.srid
          ? {
              store_id: DEMO_STORE_ID,
              srid: o.srid,
              nm_id: o.nmId,
              order_date: o.date,
              last_change_date: o.lastChangeDate,
              price: o.priceWithDisc,
              finished_price: o.finishedPrice,
              spp_percent: o.spp,
              warehouse: o.warehouseName ?? null,
              region: o.regionName ?? null,
              is_cancel: Boolean(o.isCancel),
            }
          : null,
      "store_id,srid",
      maxBatches,
    );
  }, counts, errors);

  if (want.has("sales")) await runSource(db, "sales", daysAgo(days), async () => {
    return syncBatched(
      "raw_sales",
      (from) => fetchSales(token!, from, 150_000),
      (s) =>
        s.srid && s.saleID
          ? {
              store_id: DEMO_STORE_ID,
              srid: s.srid,
              sale_id: s.saleID,
              nm_id: s.nmId,
              sale_date: s.date,
              last_change_date: s.lastChangeDate,
              price_with_disc: s.priceWithDisc,
              for_pay: s.forPay,
              spp_percent: s.spp,
              is_return: s.saleID.startsWith("R"),
            }
          : null,
      "store_id,srid,sale_id",
      maxBatches,
    );
  }, counts, errors);

  // ── Финансовый отчёт о реализации → raw_finance_report ───────────────────
  // Единственный источник фактических удержаний WB (комиссия, эквайринг,
  // логистика, хранение, штрафы, приёмка) — на нём стоит ОПиУ.
  // Тянем по дате расчёта: с последней имеющейся rr_dt минус неделя (WB
  // досчитывает свежие отчёты) до сегодня, страницами по курсору rrdid.
  if (want.has("finance")) await runSource(db, "finance", null, async () => {
    const { data: last } = await db
      .from("raw_finance_report")
      .select("rr_dt")
      .eq("store_id", DEMO_STORE_ID)
      .not("rr_dt", "is", null)
      .order("rr_dt", { ascending: false })
      .limit(1)
      .maybeSingle();

    const from = new Date();
    if (last?.rr_dt) {
      from.setTime(new Date(last.rr_dt as string).getTime());
      from.setDate(from.getDate() - 7); // хвост отчёта WB ещё уточняется
    } else {
      from.setDate(from.getDate() - days); // первый запуск — стартовое окно
    }
    const dateFrom = isoDate(from);
    const dateTo = isoDate(new Date());

    let rrdid = 0;
    let total = 0;
    // Каждая страница — отдельный запрос под лимит «1 запрос/мин»
    for (let page = 0; page < FINANCE_MAX_PAGES; page++) {
      if (page > 0) await new Promise((r) => setTimeout(r, RATE_WAIT_MS));
      const rows = await fetchFinanceReport(
        token!,
        dateFrom,
        dateTo,
        rrdid,
        FINANCE_PAGE,
        FINANCE_TIMEOUT_MS,
      );
      if (!rows.length) break;

      const mapped = rows
        .filter((r) => r.rrd_id != null)
        .map((r) => ({
          store_id: DEMO_STORE_ID,
          rrd_id: r.rrd_id,
          realizationreport_id: r.realizationreport_id ?? null,
          nm_id: r.nm_id ?? null,
          doc_type: r.doc_type_name ?? null,
          oper_name: r.supplier_oper_name ?? null,
          currency_name: r.currency_name ?? null,
          quantity: r.quantity ?? 0,
          // amount — сумма реализации строки (для возвратов WB отдаёт её же,
          // знак задаёт doc_type; так считает и кабинет)
          amount: r.retail_amount ?? r.retail_price_withdisc_rub ?? 0,
          retail_price: r.retail_price ?? null,
          commission: r.ppvz_sales_commission ?? 0,
          for_pay: r.ppvz_for_pay ?? 0,
          acquiring_fee: r.acquiring_fee ?? 0,
          logistics: r.delivery_rub ?? 0,
          rebill_logistic: r.rebill_logistic_cost ?? 0,
          storage_fee: r.storage_fee ?? 0,
          penalty: r.penalty ?? 0,
          acceptance: r.acceptance ?? 0,
          deduction: r.deduction ?? 0,
          period_start: r.date_from || null,
          period_end: r.date_to || null,
          rr_dt: r.rr_dt || null,
          sale_dt: r.sale_dt || null,
        }));
      // Строк в отчёте сотни тысяч — пишем крупными партиями, иначе один
      // прогон превращается в сотни round-trip'ов к Supabase
      total += await chunkedUpsert(db, "raw_finance_report", mapped, "store_id,rrd_id", 2000);

      if (rows.length < FINANCE_PAGE) break; // хвост забрали
      rrdid = rows[rows.length - 1].rrd_id;
      if (page === FINANCE_MAX_PAGES - 1) {
        errors.push("finance: отчёт длиннее лимита страниц — продолжится следующим запуском");
      }
    }
    return total;
  }, counts, errors);

  // ── Расход на внутреннюю рекламу → raw_advert_daily ──────────────────────
  // Статистику берём только по кампаниям, которых касались за последние 90
  // дней: у кабинета их сотни, а лимит рекламного API — 1 запрос/мин.
  if (want.has("advert")) await runSource(db, "advert", null, async () => {
    const campaigns = await fetchAdvertCampaigns(token!);
    const since = new Date();
    since.setDate(since.getDate() - 90);
    const ids = campaigns
      .filter((c) => new Date(c.changeTime).getTime() >= since.getTime())
      .map((c) => c.advertId);
    if (!ids.length) return 0;

    const begin = daysAgo(ADVERT_WINDOW_DAYS);
    const end = isoDate(new Date());
    const rows: Record<string, unknown>[] = [];

    for (let i = 0, batch = 0; i < ids.length && batch < ADVERT_MAX_BATCHES; i += ADVERT_BATCH, batch++) {
      if (batch > 0) await new Promise((r) => setTimeout(r, RATE_WAIT_MS));
      const stats = await fetchAdvertStats(token!, ids.slice(i, i + ADVERT_BATCH), begin, end);
      for (const c of stats) {
        for (const d of c.days ?? []) {
          const day = String(d.date).slice(0, 10);

          // Один товар может встретиться в нескольких площадках (apps) за день —
          // складываем, иначе upsert по ключу (кампания, товар, день) затрёт
          // предыдущую площадку и расход окажется занижен.
          const byNm = new Map<number, { views: number; clicks: number; sum: number; atbs: number; orders: number }>();
          for (const app of d.apps ?? []) {
            for (const nm of app.nms ?? []) {
              const acc = byNm.get(nm.nmId) ?? { views: 0, clicks: 0, sum: 0, atbs: 0, orders: 0 };
              acc.views += nm.views ?? 0;
              acc.clicks += nm.clicks ?? 0;
              acc.sum += nm.sum ?? 0;
              acc.atbs += nm.atbs ?? 0;
              acc.orders += nm.orders ?? 0;
              byNm.set(nm.nmId, acc);
            }
          }

          if (byNm.size) {
            for (const [nmId, a] of byNm) {
              rows.push({
                store_id: DEMO_STORE_ID,
                advert_id: c.advertId,
                nm_id: nmId,
                stat_date: day,
                views: a.views,
                clicks: a.clicks,
                ctr: a.views > 0 ? Number(((a.clicks / a.views) * 100).toFixed(3)) : 0,
                cpc: a.clicks > 0 ? Number((a.sum / a.clicks).toFixed(4)) : 0,
                sum: a.sum,
                atbs: a.atbs,
                orders_count: a.orders,
                cr: a.clicks > 0 ? Number(((a.orders / a.clicks) * 100).toFixed(3)) : 0,
              });
            }
          } else {
            // Разбивки по товарам нет (медийные форматы) — пишем итог кампании
            rows.push({
              store_id: DEMO_STORE_ID,
              advert_id: c.advertId,
              nm_id: 0,
              stat_date: day,
              views: d.views ?? 0,
              clicks: d.clicks ?? 0,
              ctr: d.ctr ?? 0,
              cpc: d.cpc ?? 0,
              sum: d.sum ?? 0,
              atbs: d.atbs ?? 0,
              orders_count: d.orders ?? 0,
              cr: d.cr ?? 0,
            });
          }
        }
      }
      if (i + ADVERT_BATCH < ids.length && batch === ADVERT_MAX_BATCHES - 1) {
        errors.push("advert: кампаний больше лимита партий — остальные догрузятся следующим запуском");
      }
    }
    return chunkedUpsert(db, "raw_advert_daily", rows, "store_id,advert_id,nm_id,stat_date");
  }, counts, errors);

  // ── Поставки FBW → raw_incomes ───────────────────────────────────────────
  // Supplies API (старый statistics /incomes удалён WB): список поставок, по
  // каждой изменившейся — детали (склад, статус) + товары. Курсор — макс.
  // updatedDate из БД; обрабатываем старые→новые, обрыв не теряет данные.
  // Ключ включает nm_id и barcode — null в unique ломает дедуп, коалесим в 0/"".
  if (want.has("incomes")) await runSource(db, "incomes", null, async () => {
    const { data: last } = await db
      .from("raw_incomes")
      .select("last_change_date")
      .eq("store_id", DEMO_STORE_ID)
      .not("last_change_date", "is", null)
      .order("last_change_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const cursor = last?.last_change_date ? new Date(last.last_change_date as string) : null;
    const minDate = new Date();
    minDate.setDate(minDate.getDate() - 90);

    const list = await fetchWbSupplyList(token!, 500);
    const changed = list
      .filter((s) => {
        if (s.supplyID == null) return false; // черновики без номера поставки
        const upd = new Date(s.updatedDate ?? s.createDate ?? 0);
        return cursor ? upd > cursor : upd >= minDate;
      })
      .sort((a, b) => String(a.updatedDate ?? "").localeCompare(String(b.updatedDate ?? "")));

    const batch = changed.slice(0, INCOMES_DETAIL_CAP);
    let total = 0;
    for (const s of batch) {
      const [detail, goods] = await Promise.all([
        fetchWbSupplyDetail(token!, s.supplyID!),
        fetchWbSupplyGoods(token!, s.supplyID!),
      ]);
      const incomeDate =
        (detail.factDate ?? detail.supplyDate ?? s.createDate ?? "").slice(0, 10) || null;
      const rows = goods.map((g) => ({
        store_id: DEMO_STORE_ID,
        income_id: s.supplyID,
        number: s.preorderID != null ? String(s.preorderID) : null,
        income_date: incomeDate,
        last_change_date: detail.updatedDate ?? s.updatedDate ?? null,
        nm_id: g.nmID ?? 0,
        barcode: g.barcode ?? "",
        tech_size: g.techSize ?? null,
        quantity: (g.acceptedQuantity ?? 0) > 0 ? g.acceptedQuantity : (g.quantity ?? 0),
        total_price: 0,
        date_close: detail.factDate ? String(detail.factDate).slice(0, 10) : null,
        warehouse: detail.actualWarehouseName || detail.warehouseName || null,
        status: WB_SUPPLY_STATUS[detail.statusID] ?? `Статус ${detail.statusID}`,
      }));
      total += await chunkedUpsert(db, "raw_incomes", rows, "store_id,income_id,nm_id,barcode");
      await new Promise((r) => setTimeout(r, INCOMES_PAUSE_MS));
    }
    if (changed.length > batch.length) {
      errors.push(
        `incomes: обработано ${batch.length} из ${changed.length} поставок — остальные следующим запуском`,
      );
    }
    return total;
  }, counts, errors);

  // ── Платное хранение → raw_storage_daily ────────────────────────────────
  // Отчёт отдаёт строки по баркодам — агрегируем в (товар, день, склад),
  // иначе upsert затирал бы размеры друг другом. Курсор: max(stat_date) − 2
  // (WB досчитывает свежие дни), окна по 8 дней, окон за прогон — maxBatches.
  if (want.has("storage")) await runSource(db, "storage", null, async () => {
    const { data: last } = await db
      .from("raw_storage_daily")
      .select("stat_date")
      .eq("store_id", DEMO_STORE_ID)
      .order("stat_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const cursor = new Date();
    if (last?.stat_date) {
      cursor.setTime(new Date(last.stat_date as string).getTime());
      cursor.setDate(cursor.getDate() - 2);
    } else {
      cursor.setDate(cursor.getDate() - days);
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let total = 0;
    for (let w = 0; w < maxBatches && cursor <= today; w++) {
      if (w > 0) await new Promise((r) => setTimeout(r, RATE_WAIT_MS));
      const winEnd = new Date(cursor);
      winEnd.setDate(winEnd.getDate() + STORAGE_WINDOW_DAYS - 1);
      if (winEnd > today) winEnd.setTime(today.getTime());

      const rows = await fetchPaidStorage(token!, isoDate(cursor), isoDate(winEnd));
      const agg = new Map<string, Record<string, unknown> & { warehouse_price: number; barcodes_count: number }>();
      for (const r of rows) {
        if (r.nmId == null || !r.date) continue;
        const statDate = String(r.date).slice(0, 10);
        const warehouse = r.warehouse ?? "";
        const key = `${r.nmId}|${statDate}|${warehouse}`;
        const acc = agg.get(key) ?? {
          store_id: DEMO_STORE_ID,
          nm_id: r.nmId,
          stat_date: statDate,
          warehouse,
          warehouse_price: 0,
          barcodes_count: 0,
          volume: r.volume ?? null,
        };
        acc.warehouse_price = Math.round((acc.warehouse_price + (r.warehousePrice ?? 0)) * 100) / 100;
        acc.barcodes_count += r.barcodesCount ?? 0;
        agg.set(key, acc);
      }
      total += await chunkedUpsert(
        db,
        "raw_storage_daily",
        [...agg.values()],
        "store_id,nm_id,stat_date,warehouse",
      );
      cursor.setTime(winEnd.getTime());
      cursor.setDate(cursor.getDate() + 1);
      if (w === maxBatches - 1 && cursor <= today) {
        errors.push("storage: история длиннее лимита окон — продолжится следующим запуском");
      }
    }
    return total;
  }, counts, errors);

  // ── Платная приёмка → raw_acceptance ────────────────────────────────────
  // Одно окно ≤31 дня от max(gi_create_date) − 7 (хвост уточняется). Строки
  // агрегируем в (поставка, товар, дата) — отчёт бывает дробнее.
  if (want.has("acceptance")) await runSource(db, "acceptance", null, async () => {
    const { data: last } = await db
      .from("raw_acceptance")
      .select("gi_create_date")
      .eq("store_id", DEMO_STORE_ID)
      .order("gi_create_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const from = new Date();
    if (last?.gi_create_date) {
      from.setTime(new Date(last.gi_create_date as string).getTime());
      from.setDate(from.getDate() - 7);
    } else {
      from.setDate(from.getDate() - days);
    }
    const to = new Date(from);
    to.setDate(to.getDate() + ACCEPTANCE_WINDOW_DAYS - 1);
    const today = new Date();
    if (to > today) to.setTime(today.getTime());

    const rows = await fetchAcceptanceReport(token!, isoDate(from), isoDate(to));
    const agg = new Map<string, Record<string, unknown> & { count: number; total: number }>();
    for (const r of rows) {
      if (r.incomeId == null || !r.giCreateDate) continue;
      const giDate = String(r.giCreateDate).slice(0, 10);
      const nmId = r.nmID ?? 0;
      const key = `${r.incomeId}|${nmId}|${giDate}`;
      const acc = agg.get(key) ?? {
        store_id: DEMO_STORE_ID,
        income_id: r.incomeId,
        nm_id: nmId,
        gi_create_date: giDate,
        count: 0,
        total: 0,
        subject_name: r.subjectName ?? null,
      };
      acc.count += r.count ?? 0;
      acc.total = Math.round((acc.total + (r.total ?? 0)) * 100) / 100;
      agg.set(key, acc);
    }
    return chunkedUpsert(
      db,
      "raw_acceptance",
      [...agg.values()],
      "store_id,income_id,nm_id,gi_create_date",
    );
  }, counts, errors);

  // ── Воронка продаж → raw_funnel_daily ────────────────────────────────────
  // sales-funnel v3 history: разбивка по дням, партии по 20 nmId с паузами.
  // Все товары кабинета; РНП читает таблицу как есть.
  if (want.has("funnel")) await runSource(db, "funnel", null, async () => {
    const { data: prods, error: prodErr } = await db
      .from("products")
      .select("nm_id")
      .eq("store_id", DEMO_STORE_ID);
    if (prodErr) throw new Error(prodErr.message);
    const nmIds = [...new Set((prods ?? []).map((p) => Number(p.nm_id)).filter((n) => n > 0))];
    if (!nmIds.length) return 0;

    const end = new Date();
    const begin = new Date();
    begin.setDate(begin.getDate() - (FUNNEL_WINDOW_DAYS - 1));

    let total = 0;
    for (let i = 0; i < nmIds.length; i += FUNNEL_BATCH) {
      if (i > 0) await new Promise((r) => setTimeout(r, FUNNEL_WAIT_MS));
      const data = await fetchSalesFunnelHistory(
        token!,
        nmIds.slice(i, i + FUNNEL_BATCH),
        isoDate(begin),
        isoDate(end),
      );
      const rows: Record<string, unknown>[] = [];
      for (const item of data) {
        const nm = item.product?.nmId;
        if (!nm) continue;
        for (const h of item.history ?? []) {
          if (!h.date) continue;
          rows.push({
            store_id: DEMO_STORE_ID,
            nm_id: nm,
            stat_date: String(h.date).slice(0, 10),
            open_card_count: h.openCount ?? 0,
            add_to_cart_count: h.cartCount ?? 0,
            orders_count: h.orderCount ?? 0,
            orders_sum_rub: h.orderSum ?? 0,
            buyouts_count: h.buyoutCount ?? 0,
            buyouts_sum_rub: h.buyoutSum ?? 0,
            add_to_cart_conversion: h.addToCartConversion ?? null,
            cart_to_order_conversion: h.cartToOrderConversion ?? null,
            buyout_percent: h.buyoutPercent ?? null,
          });
        }
      }
      total += await chunkedUpsert(db, "raw_funnel_daily", rows, "store_id,nm_id,stat_date");
    }
    return total;
  }, counts, errors);

  // ── Тарифы WB → wb_commission_tariffs / wb_box_tariffs ──────────────────
  // Справочники для прогнозной юнит-экономики (2 дешёвых запроса).
  if (want.has("tariffs")) await runSource(db, "tariffs", null, async () => {
    const nowIso = new Date().toISOString();
    const commission = await fetchCommissionTariffs(token!);
    // Тарифы коробов: на дату позже dtTillMax WB отдаёт пустой список (наш
    // локальный день опережает московский) — при пустоте пробуем вчера
    let box = await fetchBoxTariffs(token!, isoDate(new Date()));
    if (!box.length) {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      box = await fetchBoxTariffs(token!, isoDate(y));
    }

    const cRows = commission
      .filter((c) => c.subjectID != null)
      .map((c) => ({
        store_id: DEMO_STORE_ID,
        subject_id: c.subjectID,
        parent_name: c.parentName ?? null,
        subject_name: c.subjectName ?? null,
        kgvp_marketplace: c.kgvpMarketplace ?? 0,
        kgvp_supplier: c.kgvpSupplier ?? 0,
        kgvp_supplier_express: c.kgvpSupplierExpress ?? 0,
        paid_storage_kgvp: c.paidStorageKgvp ?? 0,
        updated_at: nowIso,
      }));
    let n = await chunkedUpsert(db, "wb_commission_tariffs", cRows, "store_id,subject_id");

    const bRows = box.map((b) => ({
      store_id: DEMO_STORE_ID,
      warehouse_name: b.warehouseName,
      delivery_base: b.deliveryBase,
      delivery_liter: b.deliveryLiter,
      storage_base: b.storageBase,
      storage_liter: b.storageLiter,
      expr_pct: b.exprPct,
      dt_from: b.dtFrom,
      dt_till: b.dtTill,
      updated_at: nowIso,
    }));
    n += await chunkedUpsert(db, "wb_box_tariffs", bRows, "store_id,warehouse_name");
    return n;
  }, counts, errors);

  // ── Выплаты WB → приход в кассу ──────────────────────────────────────────
  // Маркетплейс перечисляет деньги за отчётный период — заводим это приходом
  // автоматически, иначе касса врёт до тех пор, пока кто-то не внесёт руками.
  if (want.has("finance")) await runSource(db, "wb-payouts", null, async () => {
    const res = await syncWbPayoutsToCash(
      db,
      { id: "", name: "Синхронизация WB", role: "owner", roleLabel: "Система" },
      120,
    );
    return res.created;
  }, counts, errors);

  // ── Баланс кабинета WB (сколько маркетплейс должен продавцу) ─────────────
  if (want.has("finance")) await runSource(db, "balance", null, async () => {
    const b = await fetchAccountBalance(token!);
    const { error } = await db.from("wb_balance").upsert(
      {
        store_id: DEMO_STORE_ID,
        currency: b.currency ?? "RUB",
        current_amount: Number(b.current ?? 0),
        for_withdraw: Number(b.for_withdraw ?? 0),
        checked_at: new Date().toISOString(),
      },
      { onConflict: "store_id" },
    );
    if (error) throw new Error(error.message);
    return 1;
  }, counts, errors);

  // ── Кэш агрегатов (0022 + 0026): тяжёлая агрегация raw_* один раз здесь,
  // страницы читают готовые мини-таблицы мгновенно ─────────────────────────
  if (want.has("orders") || want.has("sales")) {
    await runSource(db, "aggregates", null, async () => {
      const { data, error } = await db.rpc("refresh_agg_daily", {
        p_store: DEMO_STORE_ID,
        p_days: 60,
      });
      if (error) throw new Error(error.message);
      // Месячный кэш продаж — основа ОПиУ (окно 3 месяца; старое WB не меняет)
      const { data: months, error: mErr } = await db.rpc("refresh_sales_month", {
        p_store: DEMO_STORE_ID,
        p_months: 3,
      });
      if (mErr) throw new Error(mErr.message);
      return Number(data ?? 0) + Number(months ?? 0);
    }, counts, errors);
  }

  // ── Статус интеграции ────────────────────────────────────────────────────
  const meta = decodeTokenMeta(token);
  await db.from("integration_credentials").upsert(
    {
      store_id: DEMO_STORE_ID,
      provider: "wb",
      status: "valid",
      scopes: meta.scopes,
      last_checked_at: new Date().toISOString(),
    },
    { onConflict: "store_id,provider" },
  );

  return {
    ok: errors.length === 0,
    seller,
    counts,
    errors,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
