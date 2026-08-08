// Провайдер данных на реальной БД Supabase (service_role, обходит RLS).
// БД — единственный источник правды: пустые таблицы → честные нули/пустые
// списки (НЕ демо-данные). Mock (mock.ts) используется только когда Supabase
// вообще не настроен — см. dispatcher index.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "@/shared/constants";
import type {
  Currency,
  DashboardData,
  DailyPoint,
  DesignRequest,
  DutyItem,
  Factory,
  FinanceRow,
  FulfillmentPartner,
  FulfillmentSummary,
  FbsProductRow,
  FbsStocksView,
  FbsWarehouseRow,
  IntegrationStatus,
  PlanFactDay,
  CostPriceSource,
  ProductGroup,
  ProductListItem,
  ProductSizeStock,
  ProductStockRow,
  ProductUnitEcon,
  ReportsBoard,
  SalesPlanView,
  StocksOverview,
  RnpDay,
  RnpProduct,
  RnpWeek,
  SizeMatrix,
  Supply,
  SupplyCountry,
  SupplyPayment,
  SupplyStatus,
  Tariff,
  TaskItem,
  TaskReportItem,
  TeamMember,
  UnitEconRow,
  UnitEconView,
  WarehouseStock,
  WbDistribution,
  WbIncomeGroup,
} from "@/shared/types";
import {
  assembleSupply,
  computeFactories,
  computeFulfillment,
  type FactoryBase,
  type SupplyInput,
  type SupplyItemInput,
} from "@/shared/supply";
import { storeCurrency } from "./cash-core";

// ─── локальные хелперы дат (без toISOString — не сдвигают день в UTC+5/6) ────

function isoDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayLabel(iso: string) {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
}

// PostgREST режет ЛЮБОЙ ответ (включая rpc!) до 1000 строк — большие выборки
// тянем страницами через .range() до неполной страницы. Без этого agg_rnp_daily
// (~4.5k строк) и agg_stock_sizes (~1.4k) молча теряли данные.
//
// Страницы берём ПАЧКАМИ параллельно: раньше цикл был строго последовательным,
// и agg_rnp_daily (5 страниц) стоил 5 круговых задержек до Supabase (~0.5 с
// каждая) — это и делало РНП самой медленной вкладкой. Пачка из BATCH страниц
// сокращает 5 последовательных ожиданий до 2. Больше 3 параллельных запросов не
// берём: каждый прогоняет агрегат целиком, и шторм ловил statement timeout.
async function rpcAll<T>(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<T[]> {
  const PAGE = 1000;
  const BATCH = 3;
  const all: T[] = [];

  const page = async (index: number): Promise<T[]> => {
    const from = index * PAGE;
    const { data, error } = await db.rpc(fn, args).range(from, from + PAGE - 1);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return (data ?? []) as T[];
  };

  // Первая страница отдельно: у подавляющего большинства агрегатов она же и
  // последняя — лишние параллельные запросы делать незачем.
  const first = await page(0);
  all.push(...first);
  if (first.length < PAGE) return all;

  for (let start = 1; ; start += BATCH) {
    const batch = await Promise.all(
      Array.from({ length: BATCH }, (_, i) => page(start + i)),
    );
    for (const rows of batch) all.push(...rows);
    // Неполная страница внутри пачки = данные кончились
    if (batch.some((rows) => rows.length < PAGE)) return all;
  }
}

const MONTHS_RU = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const SIZES_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL", "4XL", "5XL"];

// Размеры в кабинете разнородные: буквенные (M, XL), возрастные («5 лет»,
// «9-12 мес», слитное «5лет»), ростовки (134, 146), числовые (42-44) и обувные
// («38-39 M6/W8»). Сортируем по «системе размеров», затем по величине внутри
// неё — иначе список в карточке идёт как попало (алфавитом «10 лет» < «2 года»).
function sizeRank(size: string): [number, number, string] {
  const s = size.trim();
  const upper = s.toUpperCase();

  const letter = SIZES_ORDER.indexOf(upper);
  if (letter >= 0) return [0, letter, upper];

  const num = s.match(/\d+/);
  if (num) {
    let value = Number(num[0]);
    // «9-12 мес» меньше года: без перевода в годы месяцы встают после
    // «2 года» (9 > 2) и порядок ломается.
    if (/мес/i.test(s)) value /= 12;
    return [1, value, upper];
  }

  return [2, 0, upper]; // one-size и прочее — в конец
}

function compareSizes(a: string, b: string): number {
  const [ga, va, sa] = sizeRank(a);
  const [gb, vb, sb] = sizeRank(b);
  return ga - gb || va - vb || sa.localeCompare(sb, "ru");
}

// Понедельник недели, к которой относится дата (локально)
function mondayOf(d: Date): Date {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}

// ISO-год и ISO-неделя даты
function isoWeekOf(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

// ─── Дашборд ─────────────────────────────────────────────────────────────────

export async function getDashboardData(
  db: SupabaseClient,
): Promise<DashboardData> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 29);

  // Агрегация в Postgres (rpc 0016): с реальными объёмами WB тянуть сырые
  // строки нельзя — PostgREST молча режет выборку до 1000 строк.
  const [dailyRes, salesRes, stockRes] = await Promise.all([
    db.rpc("agg_orders_daily", { p_store: DEMO_STORE_ID, p_since: since.toISOString() }),
    db.rpc("agg_sales_summary", { p_store: DEMO_STORE_ID, p_since: since.toISOString() }),
    db.rpc("agg_stock_by_warehouse", { p_store: DEMO_STORE_ID }),
  ]);
  if (dailyRes.error) throw dailyRes.error;
  if (salesRes.error) throw salesRes.error;
  if (stockRes.error) throw stockRes.error;

  type DailyRow = { day: string; qty: number; sum_rub: number };
  const byDay = new Map<string, DailyRow>(
    ((dailyRes.data ?? []) as DailyRow[]).map((r) => [r.day, r]),
  );
  let ordersQty = 0;
  let ordersRub = 0;
  for (const r of (dailyRes.data ?? []) as DailyRow[]) {
    ordersQty += Number(r.qty);
    ordersRub += Number(r.sum_rub);
  }

  const ordersDynamics: DailyPoint[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(since);
    d.setDate(d.getDate() + i);
    const iso = isoDate(d);
    const r = byDay.get(iso);
    ordersDynamics.push({
      date: iso,
      label: dayLabel(iso),
      qty: Number(r?.qty ?? 0),
      sumRub: Math.round(Number(r?.sum_rub ?? 0)),
    });
  }

  const salesRow = ((salesRes.data ?? []) as { qty: number; sum_rub: number }[])[0];
  const salesQty = Number(salesRow?.qty ?? 0);
  const salesRub = Math.round(Number(salesRow?.sum_rub ?? 0));

  const stocksByWarehouse: WarehouseStock[] = (
    (stockRes.data ?? []) as { warehouse: string; qty: number }[]
  ).map((r) => ({ warehouse: r.warehouse, qty: Number(r.qty) }));
  const stockQty = stocksByWarehouse.reduce((t, w) => t + w.qty, 0);

  // Оценка прибыли до подключения финотчётов WB (реальный расчёт — Фаза 2)
  const profitRub = Math.round(salesRub * 0.238);

  return {
    kpis: {
      profitRub,
      profitabilityPct: salesRub > 0 ? 23.8 : 0,
      salesRub: Math.round(salesRub),
      salesQty,
      ordersRub: Math.round(ordersRub),
      ordersQty,
      stockQty,
      stockWarehouses: stocksByWarehouse.length,
    },
    ordersDynamics,
    ordersTrend: ordersDynamics,
    stocksByWarehouse,
    updatedAt: new Date().toISOString(),
  };
}

// ─── Товары ──────────────────────────────────────────────────────────────────

export async function getProductList(
  db: SupabaseClient,
): Promise<ProductListItem[]> {
  // Все пять выборок независимы — раньше они шли строго друг за другом и стоили
  // пяти круговых задержек до Supabase (~0.5 с каждая, итого ~2.5 с только на
  // ожидание сети). Ни одна не использует результат предыдущей: связываются они
  // уже в памяти, в финальном map. Поэтому запускаем их одним Promise.all.
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 29);

  const ueTo = new Date();
  ueTo.setHours(0, 0, 0, 0);
  const ueFrom = new Date(ueTo);
  ueFrom.setDate(ueFrom.getDate() - 29);

  type SizeRow = { product_id: string; size: string | null; on_stock: number; in_transit: number };
  type SaleSizeRow = { nm_id: number; size: string | null; cnt: number };

  const [prodRes, stockRes, sizeRows, supplies, salesRes, saleSizeRows, ueRows] = await Promise.all([
    db
      .from("products")
      .select(
        "id, nm_id, vendor_code, title, brand, category, status, cost_price, cost_price_source, cost_price_updated_at, cost_sewing_rub, cost_cargo_rub, cost_fulfillment_rub, logistics_cost, photo_url, photos, description, price_wb, price_discounted_wb, group_id, group:product_groups(name), responsible:profiles(full_name)",
      )
      .eq("store_id", DEMO_STORE_ID)
      .order("nm_id"),
    // Остатки — последний снимок каждого товара, агрегированный в Postgres
    // (rpc 0016; сырые строки снапшотов PostgREST режет до 1000). Только on_stock:
    // транзит WB не смешиваем («В пути в МСК» — отдельная колонка из поставок).
    db.rpc("agg_stock_by_product", { p_store: DEMO_STORE_ID }),
    // Разбивка того же остатка по размерам — показывается прямо в карточке
    // товара. Через rpcAll: строк уже под тысячу (PostgREST режет на 1000).
    rpcAll<SizeRow>(db, "agg_stock_sizes", { p_store: DEMO_STORE_ID }),
    // В пути в Москву — по поставкам (in_transit/arrived)
    readSupplies(db),
    // Продажи за 30 дней по nm_id → скорость и «на сколько хватит»
    db.rpc("agg_sales_by_nm", {
      p_store: DEMO_STORE_ID,
      p_since: since.toISOString(),
    }),
    // Те же продажи в разрезе размеров (0038) → «на сколько хватит» каждого
    // размера. Строк nm×размер — за тысячу, поэтому rpcAll.
    rpcAll<SaleSizeRow>(db, "agg_sales_by_size", {
      p_store: DEMO_STORE_ID,
      p_since: since.toISOString(),
    }),
    // Юнит-экономика за 30 дней (agg_unit_econ 0035). Ошибка не роняет список:
    // до применения миграции/бэкфилла колонка «Маржа» просто пустая.
    readUnitEconAgg(db, ueFrom, ueTo).catch(() => [] as UnitEconAggRow[]),
  ]);

  if (prodRes.error) throw prodRes.error;
  const prods = prodRes.data;
  if (!prods || prods.length === 0) return [];

  if (stockRes.error) throw stockRes.error;
  const stockByProduct = new Map<string, number>(
    ((stockRes.data ?? []) as { product_id: string; on_stock: number }[]).map((r) => [
      r.product_id,
      Number(r.on_stock),
    ]),
  );

  // Размеры по товарам: остатки группируем как есть, финальный список (с
  // фильтром шума и скоростью продаж) собирается в map(p) — там известен nm_id.
  const normSize = (s: string | null | undefined) => s?.trim() || "б/р";
  const sizesByProduct = new Map<
    string,
    { size: string; onStock: number; inTransit: number }[]
  >();
  for (const r of sizeRows) {
    const list = sizesByProduct.get(r.product_id) ?? [];
    list.push({
      size: normSize(r.size),
      onStock: Number(r.on_stock ?? 0),
      inTransit: Number(r.in_transit ?? 0),
    });
    sizesByProduct.set(r.product_id, list);
  }

  // Продажи 30 дней в разрезе размеров: nm_id → размер → шт
  const salesBySize = new Map<number, Map<string, number>>();
  for (const r of saleSizeRows) {
    const nm = Number(r.nm_id);
    const m = salesBySize.get(nm) ?? new Map<string, number>();
    const key = normSize(r.size);
    m.set(key, (m.get(key) ?? 0) + Number(r.cnt));
    salesBySize.set(nm, m);
  }

  const inTransitByProduct = new Map<string, number>();
  for (const s of supplies) {
    if (!s.productId) continue;
    if (s.status !== "in_transit" && s.status !== "arrived") continue;
    inTransitByProduct.set(
      s.productId,
      (inTransitByProduct.get(s.productId) ?? 0) + s.quantity,
    );
  }

  if (salesRes.error) throw salesRes.error;
  const salesByNm = new Map<number, number>(
    ((salesRes.data ?? []) as { nm_id: number; cnt: number }[]).map((r) => [
      Number(r.nm_id),
      Number(r.cnt),
    ]),
  );

  const ueByNm = new Map(ueRows.map((r) => [Number(r.nm_id), r]));
  const useDailyStorage = ueRows.some((r) => Number(r.storage_rub) > 0);
  const useDetailAcceptance = ueRows.some((r) => Number(r.acceptance_rub) > 0);

  return prods.map((p) => {
    const responsible = p.responsible as { full_name?: string } | null;
    const group = p.group as { name?: string } | null;
    const nmId = Number(p.nm_id);
    const stockQty = stockByProduct.get(p.id as string) ?? 0;
    const salesRank30d = salesByNm.get(nmId) ?? 0;
    // делим на неокруглённую скорость (округление — только для отображения)
    const avgExact = salesRank30d / 30;
    const avgDailySales = Math.round(avgExact * 10) / 10;
    const daysOfCover = avgExact > 0 ? Math.round(stockQty / avgExact) : null;
    const isWeak = salesRank30d < 120 || (daysOfCover !== null && daysOfCover > 120);

    // Размерный ряд: остаток + скорость размера → «на сколько хватит».
    // Ноль остатка и транзита БЕЗ продаж — снятый с продажи размер, шум.
    // С продажами — вымытый размер: показываем нулём, это сигнал к дозаказу.
    const sizeSales = salesBySize.get(nmId) ?? new Map<string, number>();
    const seenSizes = new Set<string>();
    const sizes: ProductSizeStock[] = [];
    for (const s of sizesByProduct.get(p.id as string) ?? []) {
      seenSizes.add(s.size);
      const cnt = sizeSales.get(s.size) ?? 0;
      if (s.onStock === 0 && s.inTransit === 0 && cnt === 0) continue;
      sizes.push({
        ...s,
        sales30d: cnt,
        daysOfCover: cnt > 0 ? Math.round(s.onStock / (cnt / 30)) : null,
      });
    }
    for (const [size, cnt] of sizeSales) {
      if (cnt > 0 && !seenSizes.has(size)) {
        sizes.push({ size, onStock: 0, inTransit: 0, sales30d: cnt, daysOfCover: 0 });
      }
    }
    sizes.sort((a, b) => compareSizes(a.size, b.size));

    // Экономика за 30 дней: полный водопад из фактических отчётов WB
    const cost = Number(p.cost_price ?? 0);
    const ue = ueByNm.get(nmId);
    let econ: ProductUnitEcon | null = null;
    if (ue) {
      const netQty = Number(ue.sale_qty) - Number(ue.return_qty);
      const revenue = Number(ue.revenue_rub);
      if (netQty > 0 && revenue > 0) {
        const storage = Number(useDailyStorage ? ue.storage_rub : ue.storage_fin_rub);
        const acceptance = Number(
          useDetailAcceptance ? ue.acceptance_rub : ue.acceptance_fin_rub,
        );
        const advert = Number(ue.advert_rub);
        const cogs = cost * netQty;
        const fees =
          Number(ue.commission_rub) +
          Number(ue.acquiring_rub) +
          Number(ue.logistics_rub) +
          storage +
          acceptance +
          Number(ue.penalty_rub) +
          Number(ue.deduction_rub);
        const profit = revenue - fees - advert - cogs;
        econ = {
          periodDays: 30,
          saleQty: netQty,
          priceRub: Math.round(revenue / netQty),
          commissionRub: Math.round(
            (Number(ue.commission_rub) + Number(ue.acquiring_rub)) / netQty,
          ),
          logisticsRub: Math.round(Number(ue.logistics_rub) / netQty),
          storageRub: Math.round(storage / netQty),
          acceptanceRub: Math.round(acceptance / netQty),
          advertRub: Math.round(advert / netQty),
          costPrice: cost,
          profitPerUnitRub: Math.round(profit / netQty),
          profitRub: Math.round(profit),
          marginPct: Math.round((profit / revenue) * 1000) / 10,
          roiPct: cogs > 0 ? Math.round((profit / cogs) * 1000) / 10 : 0,
          drrPct: Math.round((advert / revenue) * 1000) / 10,
        };
      }
    }

    return {
      id: p.id as string,
      nmId,
      vendorCode: (p.vendor_code as string) ?? `ART-${String(p.nm_id).slice(0, 5)}`,
      title: (p.title as string) ?? "—",
      brand: (p.brand as string) ?? "—",
      category: (p.category as string) ?? "—",
      status: (p.status as string) ?? "—",
      costPrice: cost,
      costPriceSource: ((p.cost_price_source as CostPriceSource) ?? "manual"),
      costPriceUpdatedAt: (p.cost_price_updated_at as string) ?? null,
      costSewingRub: Number(p.cost_sewing_rub ?? 0),
      costCargoRub: Number(p.cost_cargo_rub ?? 0),
      costFulfillmentRub: Number(p.cost_fulfillment_rub ?? 0),
      econ,
      logisticsCost: Number(p.logistics_cost ?? 0),
      stockQty,
      sizes,
      groupId: (p.group_id as string) ?? null,
      groupName: group?.name ?? null,
      responsible: responsible?.full_name ?? "—",
      photoUrl: (p.photo_url as string) ?? null,
      photos: Array.isArray(p.photos) ? (p.photos as string[]) : [],
      description: (p.description as string) ?? null,
      priceWb: p.price_wb == null ? null : Number(p.price_wb),
      priceDiscountedWb:
        p.price_discounted_wb == null ? null : Number(p.price_discounted_wb),
      inTransitToMoscow: inTransitByProduct.get(p.id as string) ?? 0,
      avgDailySales,
      daysOfCover,
      salesRank30d,
      isWeak,
    };
  });
}

// ─── Юнит-экономика (agg_unit_econ, миграция 0035) ───────────────────────────

// Строка агрегата: все деньги по nm_id за период. Хранение и приёмка в двух
// вариантах: *_fin_rub — из финотчёта (обычно висит на nm_id=0), обычные — из
// детальных отчётов (paid_storage / acceptance_report), распределены по товарам.
type UnitEconAggRow = {
  nm_id: number;
  sale_qty: number;
  return_qty: number;
  revenue_rub: number;
  for_pay_rub: number;
  commission_rub: number;
  acquiring_rub: number;
  logistics_rub: number;
  storage_fin_rub: number;
  storage_rub: number;
  acceptance_fin_rub: number;
  acceptance_rub: number;
  penalty_rub: number;
  deduction_rub: number;
  advert_rub: number;
  advert_views: number;
  advert_clicks: number;
};

function readUnitEconAgg(
  db: SupabaseClient,
  from: Date,
  to: Date,
): Promise<UnitEconAggRow[]> {
  return rpcAll<UnitEconAggRow>(db, "agg_unit_econ", {
    p_store: DEMO_STORE_ID,
    p_from: isoDate(from),
    p_to: isoDate(to),
  });
}

export async function getUnitEconomics(
  db: SupabaseClient,
  days = 30,
): Promise<UnitEconView> {
  const to = new Date();
  to.setHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));

  const [agg, prodRes] = await Promise.all([
    readUnitEconAgg(db, from, to),
    db
      .from("products")
      .select("nm_id, title, category, photo_url, cost_price, cost_price_source")
      .eq("store_id", DEMO_STORE_ID),
  ]);
  if (prodRes.error) throw prodRes.error;
  const prodByNm = new Map(
    (prodRes.data ?? []).map((p) => [Number(p.nm_id), p]),
  );

  // Хранение/приёмка: детальные отчёты точнее (по товарам), но если они ещё не
  // синхронизированы — берём суммы финотчёта, чтобы итог всё равно сходился.
  const sumBy = (pick: (r: UnitEconAggRow) => number) =>
    agg.reduce((t, r) => t + Number(pick(r) ?? 0), 0);
  const storageDailyTotal = sumBy((r) => r.storage_rub);
  const storageFinTotal = sumBy((r) => r.storage_fin_rub);
  const useDailyStorage = storageDailyTotal > 0;
  const accDetailTotal = sumBy((r) => r.acceptance_rub);
  const accFinTotal = sumBy((r) => r.acceptance_fin_rub);
  const useDetailAcceptance = accDetailTotal > 0;

  const buildRow = (r: UnitEconAggRow): UnitEconRow => {
    const nm = Number(r.nm_id);
    const p = prodByNm.get(nm);
    const netQty = Number(r.sale_qty) - Number(r.return_qty);
    const revenue = Number(r.revenue_rub);
    const storage = Number(useDailyStorage ? r.storage_rub : r.storage_fin_rub);
    const acceptance = Number(
      useDetailAcceptance ? r.acceptance_rub : r.acceptance_fin_rub,
    );
    const costPrice = Number(p?.cost_price ?? 0);
    const cogs = costPrice * Math.max(netQty, 0);
    const fees =
      Number(r.commission_rub) +
      Number(r.acquiring_rub) +
      Number(r.logistics_rub) +
      storage +
      acceptance +
      Number(r.penalty_rub) +
      Number(r.deduction_rub);
    const advert = Number(r.advert_rub);
    const profit = revenue - fees - advert - cogs;
    return {
      nmId: nm,
      title: (p?.title as string) ?? (nm === 0 ? "Нераспределённое" : `Товар ${nm}`),
      photoUrl: (p?.photo_url as string) ?? null,
      category: (p?.category as string) ?? "—",
      saleQty: netQty,
      revenueRub: Math.round(revenue),
      commissionRub: Math.round(Number(r.commission_rub)),
      acquiringRub: Math.round(Number(r.acquiring_rub)),
      logisticsRub: Math.round(Number(r.logistics_rub)),
      storageRub: Math.round(storage),
      acceptanceRub: Math.round(acceptance),
      penaltyRub: Math.round(Number(r.penalty_rub)),
      deductionRub: Math.round(Number(r.deduction_rub)),
      advertRub: Math.round(advert),
      drrPct: revenue > 0 ? Math.round((advert / revenue) * 1000) / 10 : 0,
      costPrice,
      costPriceSource: p ? ((p.cost_price_source as CostPriceSource) ?? "manual") : null,
      cogsRub: Math.round(cogs),
      profitRub: Math.round(profit),
      profitPerUnitRub: netQty > 0 ? Math.round(profit / netQty) : 0,
      marginPct: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
      roiPct: cogs > 0 ? Math.round((profit / cogs) * 1000) / 10 : 0,
    };
  };

  const rows = agg
    .filter((r) => Number(r.nm_id) > 0)
    .map(buildRow)
    .filter(
      (r) =>
        r.saleQty !== 0 ||
        r.revenueRub !== 0 ||
        r.advertRub !== 0 ||
        r.storageRub !== 0 ||
        r.profitRub !== 0,
    )
    .sort((a, b) => b.profitRub - a.profitRub);

  // «Нераспределённое»: строка nm_id=0 из отчётов + сверка детального хранения
  // и приёмки с финотчётом (разница остаётся здесь, чтобы итог бился с ОПиУ)
  const zero = agg.find((r) => Number(r.nm_id) === 0);
  let unallocated: UnitEconRow | null = zero ? buildRow(zero) : null;
  const storageDelta = useDailyStorage ? Math.round(storageFinTotal - storageDailyTotal) : 0;
  const accDelta = useDetailAcceptance ? Math.round(accFinTotal - accDetailTotal) : 0;
  if (storageDelta !== 0 || accDelta !== 0) {
    unallocated = unallocated ?? {
      nmId: 0,
      title: "Нераспределённое",
      photoUrl: null,
      category: "—",
      saleQty: 0,
      revenueRub: 0,
      commissionRub: 0,
      acquiringRub: 0,
      logisticsRub: 0,
      storageRub: 0,
      acceptanceRub: 0,
      penaltyRub: 0,
      deductionRub: 0,
      advertRub: 0,
      drrPct: 0,
      costPrice: 0,
      costPriceSource: null,
      cogsRub: 0,
      profitRub: 0,
      profitPerUnitRub: 0,
      marginPct: 0,
      roiPct: 0,
    };
    unallocated.storageRub += storageDelta;
    unallocated.acceptanceRub += accDelta;
    unallocated.profitRub -= storageDelta + accDelta;
  }
  if (
    unallocated &&
    unallocated.revenueRub === 0 &&
    unallocated.profitRub === 0 &&
    unallocated.advertRub === 0 &&
    unallocated.storageRub === 0 &&
    unallocated.acceptanceRub === 0 &&
    unallocated.deductionRub === 0
  ) {
    unallocated = null;
  }

  const all = unallocated ? [...rows, unallocated] : rows;
  const total = (pick: (r: UnitEconRow) => number) =>
    all.reduce((t, r) => t + pick(r), 0);
  const totalRevenue = total((r) => r.revenueRub);
  const totalProfit = total((r) => r.profitRub);

  // Покрытие себестоимостью — по проданным штукам
  const soldQty = rows.reduce((t, r) => t + Math.max(r.saleQty, 0), 0);
  const coveredQty = rows.reduce(
    (t, r) => t + (r.costPrice > 0 ? Math.max(r.saleQty, 0) : 0),
    0,
  );

  return {
    from: isoDate(from),
    to: isoDate(to),
    days,
    rows,
    unallocated,
    totals: {
      saleQty: soldQty,
      revenueRub: totalRevenue,
      wbFeesRub: total(
        (r) =>
          r.commissionRub +
          r.acquiringRub +
          r.logisticsRub +
          r.storageRub +
          r.acceptanceRub +
          r.penaltyRub +
          r.deductionRub,
      ),
      advertRub: total((r) => r.advertRub),
      cogsRub: total((r) => r.cogsRub),
      profitRub: totalProfit,
      marginPct: totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 1000) / 10 : 0,
    },
    storageSource: useDailyStorage ? "daily" : "finance",
    costCoveragePct: soldQty > 0 ? Math.round((coveredQty / soldQty) * 100) : 0,
  };
}

// ─── Поставки FBW: приёмки складов WB (raw_incomes) ──────────────────────────

export async function getWbIncomes(db: SupabaseClient): Promise<WbIncomeGroup[]> {
  const since = new Date();
  since.setDate(since.getDate() - 90);

  type Row = {
    income_id: number;
    income_date: string | null;
    date_close: string | null;
    warehouse: string | null;
    status: string | null;
    nm_id: number;
    quantity: number;
  };
  // PostgREST режет ответ до 1000 строк — тянем страницами
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let fromIdx = 0; ; fromIdx += PAGE) {
    const { data, error } = await db
      .from("raw_incomes")
      .select("income_id, income_date, date_close, warehouse, status, nm_id, quantity")
      .eq("store_id", DEMO_STORE_ID)
      .gte("income_date", isoDate(since))
      .order("income_date", { ascending: false })
      .range(fromIdx, fromIdx + PAGE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE) break;
  }
  if (!rows.length) return [];

  const { data: prods } = await db
    .from("products")
    .select("nm_id, title")
    .eq("store_id", DEMO_STORE_ID);
  const titleByNm = new Map(
    (prods ?? []).map((p) => [Number(p.nm_id), String(p.title)]),
  );

  const groups = new Map<
    number,
    WbIncomeGroup & { qtyByNm: Map<number, number> }
  >();
  for (const r of rows) {
    const id = Number(r.income_id);
    const g = groups.get(id) ?? {
      incomeId: id,
      date: r.income_date ?? "",
      dateClose: r.date_close,
      warehouse: r.warehouse ?? "—",
      totalQty: 0,
      positions: 0,
      status: r.status ?? "—",
      items: [],
      qtyByNm: new Map<number, number>(),
    };
    g.totalQty += Number(r.quantity ?? 0);
    const nm = Number(r.nm_id);
    if (nm > 0) g.qtyByNm.set(nm, (g.qtyByNm.get(nm) ?? 0) + Number(r.quantity ?? 0));
    if (r.date_close && (!g.dateClose || r.date_close > g.dateClose)) g.dateClose = r.date_close;
    groups.set(id, g);
  }

  return [...groups.values()]
    .sort((a, b) => (b.date > a.date ? 1 : -1))
    .slice(0, 20)
    .map((g) => ({
      incomeId: g.incomeId,
      date: g.date,
      dateClose: g.dateClose,
      warehouse: g.warehouse,
      totalQty: g.totalQty,
      positions: g.qtyByNm.size,
      status: g.status,
      items: [...g.qtyByNm.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([nm, qty]) => ({
          nmId: nm,
          title: titleByNm.get(nm) ?? `Товар ${nm}`,
          qty,
        })),
    }));
}

// ─── Цепочка поставок (Фабрики · Поставки · Фул-фирма) ────────────────────────

// Читает поставки + оплаты + распределения и собирает карточки Supply.
// Возвращает [] если поставок нет (обёртки решают, отдавать ли null).
async function readSupplies(db: SupabaseClient): Promise<Supply[]> {
  const { data: rows, error } = await db
    .from("supplies")
    .select(
      "id, factory_id, product_id, title, quantity, ship_date, sewing_cost, sewing_currency, cargo_cost, cargo_currency, cargo_rate_to_rub, fulfillment_partner_id, fulfillment_cost_rub, status, received_at, received_qty, receipt_comment, transit_days, factory:factories(name, country), partner:fulfillment_partners(name, rate_per_unit_rub), responsible:profiles!supplies_responsible_user_id_fkey(full_name)",
    )
    .eq("org_id", DEMO_ORG_ID)
    .order("ship_date", { ascending: false });
  if (error) throw error;
  if (!rows || rows.length === 0) return [];

  const ids = rows.map((r) => r.id as string);
  const [paymentsRes, distsRes, itemsRes] = await Promise.all([
    db
      .from("supply_payments")
      .select("id, supply_id, kind, amount, currency, paid_at, note")
      .in("supply_id", ids),
    db
      .from("wb_distributions")
      .select("id, supply_id, warehouse, quantity")
      .in("supply_id", ids),
    db
      .from("supply_items")
      .select(
        "id, supply_id, product_id, title, quantity, received_qty, sewing_cost, sewing_currency, sewing_rate_to_rub",
      )
      .in("supply_id", ids),
  ]);
  // Ошибка вторичного чтения → оплаты/распределения/позиции нельзя считать
  // «пустыми» (иначе долг фабрике покажется на всю сумму) — пробрасываем.
  if (paymentsRes.error) throw paymentsRes.error;
  if (distsRes.error) throw distsRes.error;
  if (itemsRes.error) throw itemsRes.error;

  const itemsBySupply = new Map<string, SupplyItemInput[]>();
  for (const i of (itemsRes.data ?? []) as unknown as Record<string, unknown>[]) {
    const sid = String(i.supply_id);
    const list = itemsBySupply.get(sid) ?? [];
    list.push({
      id: String(i.id),
      productId: (i.product_id as string) ?? null,
      title: (i.title as string) ?? "—",
      quantity: Number(i.quantity ?? 0),
      receivedQty: i.received_qty == null ? null : Number(i.received_qty),
      sewingCost: Number(i.sewing_cost ?? 0),
      sewingCurrency: i.sewing_currency as Currency,
      sewingRateToRub: i.sewing_rate_to_rub == null ? null : Number(i.sewing_rate_to_rub),
    });
    itemsBySupply.set(sid, list);
  }

  const paymentsBySupply = new Map<string, SupplyPayment[]>();
  for (const p of paymentsRes.data ?? []) {
    const sid = p.supply_id as string;
    const list = paymentsBySupply.get(sid) ?? [];
    list.push({
      id: p.id as string,
      kind: p.kind as SupplyPayment["kind"],
      amount: Number(p.amount ?? 0),
      currency: p.currency as Currency,
      paidAt: (p.paid_at as string) ?? "",
      note: (p.note as string) ?? null,
    });
    paymentsBySupply.set(sid, list);
  }

  const distsBySupply = new Map<string, WbDistribution[]>();
  for (const d of distsRes.data ?? []) {
    const sid = d.supply_id as string;
    const list = distsBySupply.get(sid) ?? [];
    list.push({
      id: d.id as string,
      warehouse: d.warehouse as string,
      quantity: Number(d.quantity ?? 0),
    });
    distsBySupply.set(sid, list);
  }

  return rows.map((r) => {
    const factory = r.factory as { name?: string; country?: string } | null;
    const partner = r.partner as { name?: string; rate_per_unit_rub?: number } | null;
    const responsible = r.responsible as { full_name?: string } | null;
    const input: SupplyInput = {
      id: r.id as string,
      factoryId: r.factory_id as string,
      factoryName: factory?.name ?? "—",
      country: (factory?.country as SupplyCountry) ?? "china",
      productId: (r.product_id as string) ?? null,
      title: (r.title as string) ?? "—",
      quantity: Number(r.quantity ?? 0),
      shipDate: (r.ship_date as string) ?? "",
      sewingCost: Number(r.sewing_cost ?? 0),
      sewingCurrency: r.sewing_currency as Currency,
      cargoCost: Number(r.cargo_cost ?? 0),
      cargoCurrency: r.cargo_currency as Currency,
      cargoRateToRub: r.cargo_rate_to_rub == null ? null : Number(r.cargo_rate_to_rub),
      status: r.status as SupplyStatus,
      receivedAt: (r.received_at as string) ?? null,
      receivedQty: r.received_qty == null ? null : Number(r.received_qty),
      receiptComment: (r.receipt_comment as string) ?? null,
      transitDays: r.transit_days == null ? null : Number(r.transit_days),
      responsible: responsible?.full_name ?? "—",
      items: itemsBySupply.get(r.id as string) ?? [],
      fulfillmentPartnerId: (r.fulfillment_partner_id as string) ?? null,
      fulfillmentPartnerName: partner?.name ?? null,
      fulfillmentRatePerUnitRub: Number(partner?.rate_per_unit_rub ?? 0),
      fulfillmentCostRub: r.fulfillment_cost_rub == null ? null : Number(r.fulfillment_cost_rub),
      payments: paymentsBySupply.get(r.id as string) ?? [],
      distributions: distsBySupply.get(r.id as string) ?? [],
    };
    return assembleSupply(input);
  });
}

export async function getSupplies(db: SupabaseClient): Promise<Supply[]> {
  return readSupplies(db);
}

// Группы товаров (0039): справочник для селектов и фильтра. Счётчики товаров
// в группе клиент считает сам из списка товаров — лишний запрос не нужен.
export async function getProductGroups(
  db: SupabaseClient,
): Promise<ProductGroup[]> {
  const { data, error } = await db
    .from("product_groups")
    .select("id, name")
    .eq("org_id", DEMO_ORG_ID)
    .order("name");
  if (error) throw error;
  return (data ?? []).map((g) => ({
    id: g.id as string,
    name: g.name as string,
  }));
}

export async function getFactories(db: SupabaseClient): Promise<Factory[]> {
  const { data, error } = await db
    .from("factories")
    .select("id, name, country, note")
    .eq("org_id", DEMO_ORG_ID)
    .order("name");
  if (error) throw error;
  if (!data || data.length === 0) return [];

  const base: FactoryBase[] = data.map((f) => ({
    id: f.id as string,
    name: f.name as string,
    country: f.country as SupplyCountry,
    note: (f.note as string) ?? null,
  }));
  return computeFactories(base, await readSupplies(db));
}

export async function getFulfillment(
  db: SupabaseClient,
): Promise<FulfillmentSummary> {
  return computeFulfillment(await readSupplies(db));
}

// Фул-фирмы с тарифом + сколько им начислено/оплачено по всем поставкам
export async function getFulfillmentPartners(
  db: SupabaseClient,
): Promise<FulfillmentPartner[]> {
  const { data, error } = await db
    .from("fulfillment_partners")
    .select("id, name, rate_per_unit_rub, note, archived")
    .eq("org_id", DEMO_ORG_ID)
    .order("archived")
    .order("name");
  if (error) throw error;
  if (!data || data.length === 0) return [];

  const supplies = await readSupplies(db);
  return (data as unknown as Record<string, unknown>[]).map((p) => {
    const own = supplies.filter((s) => s.fulfillmentPartnerId === p.id);
    const chargedRub = own.reduce((t, s) => t + s.fulfillmentRub, 0);
    const paidRub = own.reduce((t, s) => t + s.paidFulfillmentRub, 0);
    return {
      id: String(p.id),
      name: String(p.name),
      ratePerUnitRub: Number(p.rate_per_unit_rub ?? 0),
      note: (p.note as string) ?? null,
      archived: Boolean(p.archived),
      suppliesCount: own.length,
      chargedRub,
      paidRub,
      owedRub: Math.max(0, chargedRub - paidRub),
    };
  });
}

// ─── Финансы ─────────────────────────────────────────────────────────────────

export async function getFinanceRows(
  db: SupabaseClient,
): Promise<FinanceRow[]> {
  const { data, error } = await db
    .from("raw_finance_report")
    .select(
      "amount, commission, logistics, storage_fee, penalty, period_start",
    )
    .eq("store_id", DEMO_STORE_ID)
    .order("period_start");
  if (error) throw error;
  if (!data || data.length === 0) return [];

  const byMonth = new Map<string, FinanceRow>();
  for (const r of data) {
    const d = new Date(r.period_start as string);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const period = `${MONTHS_RU[d.getMonth()]} ${d.getFullYear()}`;
    const row =
      byMonth.get(key) ??
      ({
        period,
        salesRub: 0,
        commissionRub: 0,
        logisticsRub: 0,
        storageRub: 0,
        penaltyRub: 0,
        toPayRub: 0,
        profitRub: 0,
      } as FinanceRow);
    row.salesRub += Number(r.amount ?? 0);
    row.commissionRub += Number(r.commission ?? 0);
    row.logisticsRub += Number(r.logistics ?? 0);
    row.storageRub += Number(r.storage_fee ?? 0);
    row.penaltyRub += Number(r.penalty ?? 0);
    byMonth.set(key, row);
  }

  return [...byMonth.values()].map((r) => {
    const toPayRub =
      r.salesRub - r.commissionRub - r.logisticsRub - r.storageRub - r.penaltyRub;
    return {
      ...r,
      salesRub: Math.round(r.salesRub),
      commissionRub: Math.round(r.commissionRub),
      logisticsRub: Math.round(r.logisticsRub),
      storageRub: Math.round(r.storageRub),
      penaltyRub: Math.round(r.penaltyRub),
      toPayRub: Math.round(toPayRub),
      profitRub: Math.round(toPayRub - r.salesRub * 0.36),
    };
  });
}

// ─── План продаж WB (полугодие): план/факт по дням ───────────────────────────

// Текущее полугодие WB (клиент: план со 2 июля). Дефолт до ввода суммы.
// Период программы WB «скидка за выполнение плана»: полугодие 02.07–31.12
const DEFAULT_PLAN_START = "2026-07-02";
const DEFAULT_PLAN_END = "2026-12-31";

export async function getSalesPlanView(
  db: SupabaseClient,
): Promise<SalesPlanView> {
  const today = isoDate(new Date());

  // Актуальный план: период, охватывающий сегодня; иначе — последний
  const { data: plans, error: planErr } = await db
    .from("sales_plans")
    .select("period_start, period_end, amount_rub")
    .eq("store_id", DEMO_STORE_ID)
    .order("period_start", { ascending: false })
    .limit(5);
  if (planErr) throw planErr;
  const active =
    (plans ?? []).find(
      (p) => (p.period_start as string) <= today && today <= (p.period_end as string),
    ) ?? (plans ?? [])[0];

  const periodStart = (active?.period_start as string) ?? DEFAULT_PLAN_START;
  const periodEnd = (active?.period_end as string) ?? DEFAULT_PLAN_END;
  const amountRub = Number(active?.amount_rub ?? 0);

  const { data: daily, error: dailyErr } = await db.rpc("agg_sales_daily", {
    p_store: DEMO_STORE_ID,
    p_since: `${periodStart}T00:00:00`,
  });
  if (dailyErr) throw dailyErr;
  const factByDay = new Map(
    ((daily ?? []) as { day: string; sum_rub: number }[]).map((r) => [
      r.day,
      Math.round(Number(r.sum_rub)),
    ]),
  );

  // Серия день-за-днём: весь период (план), факт — по прошедшим дням
  const days: PlanFactDay[] = [];
  const start = new Date(`${periodStart}T00:00:00`);
  const end = new Date(`${periodEnd}T00:00:00`);
  const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
  const dailyPlanRub = Math.round(amountRub / totalDays);
  let factToDateRub = 0;
  let passedDays = 0;
  const pastFacts: number[] = []; // полные прошедшие дни (без сегодняшнего)
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = isoDate(d);
    const isFuture = iso > today;
    const factRub = factByDay.get(iso) ?? 0;
    if (!isFuture) {
      factToDateRub += factRub;
      passedDays += 1;
      if (iso < today) pastFacts.push(factRub);
    }
    days.push({ date: iso, label: dayLabel(iso), planRub: dailyPlanRub, factRub, isFuture });
  }

  const planToDateRub = dailyPlanRub * passedDays;
  // «Осталось дней» — как в ЛК: сегодня ещё можно продавать, считаем его
  const remainingDays = Math.max(1, totalDays - passedDays + (passedDays > 0 ? 1 : 0));
  const remainingRub = Math.max(0, Math.round(amountRub - factToDateRub));

  // Текущий темп — средний факт за последние 14 полных дней (сегодняшний день
  // неполный и занизил бы прогноз)
  const tail = pastFacts.slice(-14);
  const avgDailyFactRub = tail.length
    ? Math.round(tail.reduce((t, v) => t + v, 0) / tail.length)
    : 0;
  const futureDays = Math.max(0, totalDays - passedDays);
  const forecastRub = Math.round(factToDateRub + avgDailyFactRub * futureDays);

  // Валюта кабинета: statistics-заказы приходят в ней же (сверено с финотчётом)
  const currency = await storeCurrency(db);

  return {
    hasPlan: amountRub > 0,
    periodStart,
    periodEnd,
    amountRub,
    factToDateRub,
    planToDateRub,
    completionPct: planToDateRub > 0 ? Math.round((factToDateRub / planToDateRub) * 100) : 0,
    completionTotalPct:
      amountRub > 0 ? Math.round((factToDateRub / amountRub) * 1000) / 10 : 0,
    dailyPlanRub,
    neededDailyRub: amountRub > 0 ? Math.max(0, Math.round(remainingRub / remainingDays)) : 0,
    remainingRub,
    remainingDays,
    avgDailyFactRub,
    forecastRub,
    forecastPct: amountRub > 0 ? Math.round((forecastRub / amountRub) * 100) : 0,
    currency,
    days,
  };
}

// ─── Касса, расходы и ОПиУ (миграция 0024) ───────────────────────────────────
// Логика живёт в чистом модуле cash-core (его же использует Telegram-бот и ИИ) —
// здесь только ре-экспорт, чтобы страницы читали данные через общий data-слой.

export {
  getCashOverview,
  getExpensesView,
  getFinanceRefs,
  getPayrollView,
  getPnlView,
  listMembers,
} from "./cash-core";

// ─── Задачи ──────────────────────────────────────────────────────────────────

export async function getTasks(db: SupabaseClient): Promise<TaskItem[]> {
  const { data, error } = await db
    .from("tasks")
    .select(
      "id, title, description, status, priority, due_date, assignee_id, created_by, completion_report, completed_at, completed_on_time, assignee:profiles!tasks_assignee_id_fkey(full_name), product:products(title)",
    )
    .eq("org_id", DEMO_ORG_ID)
    .neq("status", "cancelled")
    .order("created_at");
  if (error) throw error;
  if (!data || data.length === 0) return [];

  return data.map((t) => {
    const assignee = t.assignee as { full_name?: string } | null;
    const product = t.product as { title?: string } | null;
    return {
      id: t.id as string,
      title: t.title as string,
      description: (t.description as string) ?? null,
      status: t.status as TaskItem["status"],
      priority: t.priority as TaskItem["priority"],
      assignee: assignee?.full_name ?? "—",
      assigneeId: (t.assignee_id as string) ?? null,
      createdById: (t.created_by as string) ?? null,
      dueDate: (t.due_date as string) ?? null,
      productLabel: product?.title ?? null,
      report: (t.completion_report as string) ?? null,
      completedAt: (t.completed_at as string) ?? null,
      completedOnTime: (t.completed_on_time as boolean) ?? null,
    };
  });
}

// ─── Интеграции ──────────────────────────────────────────────────────────────

const INTEGRATION_META: Record<
  IntegrationStatus["provider"],
  { title: string; hint: string; scopes: string[] }
> = {
  wb: {
    title: "Wildberries API",
    hint: "JWT-токен селлера (ЛК WB → Настройки → Доступ к API). Хранится в Supabase Vault.",
    scopes: ["Статистика", "Аналитика", "Контент", "Продвижение", "Финансы"],
  },
  claude: {
    title: "Claude API (AI-аналитика)",
    hint: "Ключ платформы (ANTHROPIC_API_KEY) или пользовательский через Vault.",
    scopes: ["claude-sonnet-5", "claude-opus-4-8"],
  },
  telegram: {
    title: "Telegram-бот",
    hint: "Токен бота (BotFather) + webhook. Уведомления и задачи.",
    scopes: ["Задачи", "Уведомления", "Сводки"],
  },
};

export async function getIntegrations(
  db: SupabaseClient,
): Promise<IntegrationStatus[]> {
  const { data, error } = await db
    .from("integration_credentials")
    .select("provider, status, scopes, last_checked_at")
    .eq("store_id", DEMO_STORE_ID);
  if (error) throw error;

  // Нет строки по провайдеру — честный статус «pending» (не подключено)
  const byProvider = new Map((data ?? []).map((r) => [r.provider as string, r]));
  const providers: IntegrationStatus["provider"][] = ["wb", "claude", "telegram"];
  return providers.map((provider) => {
    const row = byProvider.get(provider);
    const meta = INTEGRATION_META[provider];
    const raw = (row?.status as string) ?? "pending";
    const status: IntegrationStatus["status"] =
      raw === "revoked" ? "invalid" : (raw as IntegrationStatus["status"]);
    return {
      provider,
      title: meta.title,
      status,
      hint: meta.hint,
      scopes: (row?.scopes as string[]) ?? meta.scopes,
      lastSyncAt: (row?.last_checked_at as string) ?? null,
    };
  });
}

// ─── Тарифы ──────────────────────────────────────────────────────────────────

export async function getTariffs(db: SupabaseClient): Promise<Tariff[]> {
  const { data, error } = await db
    .from("tariffs")
    .select(
      "code, name, price_month, max_stores, max_products, ai_tokens_month, sync_interval_min",
    )
    .order("price_month");
  if (error) throw error;
  if (!data || data.length === 0) return [];

  const { data: org, error: orgErr } = await db
    .from("orgs")
    .select("plan_code")
    .eq("id", DEMO_ORG_ID)
    .maybeSingle();
  if (orgErr) throw orgErr;
  const currentCode = (org?.plan_code as string) ?? "trial";

  return data.map((t) => ({
    code: t.code as string,
    name: t.name as string,
    priceMonth: Number(t.price_month),
    maxStores: Number(t.max_stores),
    maxProducts: t.max_products === null ? null : Number(t.max_products),
    aiTokensMonth: Number(t.ai_tokens_month),
    syncIntervalMin: Number(t.sync_interval_min),
    current: t.code === currentCode,
  }));
}

// ─── Команда ─────────────────────────────────────────────────────────────────

const ROLE_ORDER: Record<string, number> = {
  owner: 0, admin: 1, manager: 2, analyst: 3, viewer: 4,
};

export async function getTeam(db: SupabaseClient): Promise<TeamMember[]> {
  const { data, error } = await db
    .from("org_members")
    .select("role, created_at, profile:profiles(id, full_name, email)")
    .eq("org_id", DEMO_ORG_ID);
  if (error) throw error;
  if (!data || data.length === 0) return [];

  return data
    .map((m) => {
      const p = m.profile as unknown as {
        id: string;
        full_name?: string;
        email?: string;
      } | null;
      return {
        id: p?.id ?? (m.role as string),
        name: p?.full_name ?? "—",
        email: p?.email ?? "—",
        role: m.role as string,
        joinedAt: m.created_at as string,
      };
    })
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
}

// ─── Остатки по складам (страница «Остатки») ─────────────────────────────────

export async function getStocksOverview(
  db: SupabaseClient,
): Promise<StocksOverview> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 29);

  const [whRes, prodRes, ordRes] = await Promise.all([
    db.rpc("agg_stock_by_warehouse", { p_store: DEMO_STORE_ID }),
    db.rpc("agg_stock_by_product", { p_store: DEMO_STORE_ID }),
    db.rpc("agg_orders_by_warehouse", {
      p_store: DEMO_STORE_ID,
      p_since: since.toISOString(),
    }),
  ]);
  if (whRes.error) throw whRes.error;
  if (prodRes.error) throw prodRes.error;
  if (ordRes.error) throw ordRes.error;

  const ordersByWh = new Map(
    ((ordRes.data ?? []) as { warehouse: string; cnt: number }[]).map((r) => [
      r.warehouse,
      Number(r.cnt),
    ]),
  );

  const warehouses = ((whRes.data ?? []) as { warehouse: string; qty: number }[]).map(
    (r) => {
      const qty = Number(r.qty);
      const orders30d = ordersByWh.get(r.warehouse) ?? 0;
      return {
        warehouse: r.warehouse,
        qty,
        orders30d,
        daysOfCover: orders30d > 0 ? Math.round(qty / (orders30d / 30)) : null,
      };
    },
  );
  const products = (prodRes.data ?? []) as {
    product_id: string;
    on_stock: number;
    in_transit: number;
  }[];

  return {
    warehouses,
    totalQty: warehouses.reduce((t, w) => t + w.qty, 0),
    inTransitQty: products.reduce((t, p) => t + Number(p.in_transit), 0),
    productsWithStock: products.filter((p) => Number(p.on_stock) > 0).length,
  };
}

// Остатки одного товара по складам и размерам (последний снимок товара).
// Строк немного (склады × размеры одного товара) — читаем напрямую.
export async function getProductStocks(
  db: SupabaseClient,
  productId: string,
): Promise<ProductStockRow[]> {
  const { data: latest, error: latestErr } = await db
    .from("stock_snapshots")
    .select("snapshot_date")
    .eq("product_id", productId)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) throw latestErr;
  if (!latest) return [];

  const { data, error } = await db
    .from("stock_snapshots")
    .select("warehouse, size, on_stock, in_transit")
    .eq("product_id", productId)
    .eq("snapshot_date", latest.snapshot_date as string)
    .limit(2000);
  if (error) throw error;

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    warehouse: r.warehouse as string,
    size: (r.size as string) ?? "—",
    onStock: Number(r.on_stock ?? 0),
    inTransit: Number(r.in_transit ?? 0),
  }));
}

// Заказы товара по складам за 30 дней → скорость каждого склада
export async function getProductWarehouseOrders(
  db: SupabaseClient,
  nmId: number,
): Promise<Map<string, number>> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 29);
  const { data, error } = await db.rpc("agg_product_orders_by_warehouse", {
    p_store: DEMO_STORE_ID,
    p_nm: nmId,
    p_since: since.toISOString(),
  });
  if (error) throw error;
  return new Map(
    ((data ?? []) as { warehouse: string; cnt: number }[]).map((r) => [
      r.warehouse,
      Number(r.cnt),
    ]),
  );
}

// ─── Остатки FBS — личные склады продавца (0041) ─────────────────────────────

export async function getFbsStocks(db: SupabaseClient): Promise<FbsStocksView> {
  type AggRow = {
    product_id: string;
    warehouse_id: number;
    warehouse_name: string;
    size: string;
    qty: number;
    snapshot_date: string;
  };
  // Агрегат может отдать больше 1000 строк (товар×склад×размер) — только rpcAll
  const [aggRows, whRes, prodRes] = await Promise.all([
    rpcAll<AggRow>(db, "agg_fbs_stock_latest", { p_store: DEMO_STORE_ID }),
    db
      .from("fbs_warehouses")
      .select("warehouse_id, name, is_deleting")
      .eq("store_id", DEMO_STORE_ID),
    db
      .from("products")
      .select("id, nm_id, title, photo_url")
      .eq("store_id", DEMO_STORE_ID),
  ]);
  if (whRes.error) throw whRes.error;
  if (prodRes.error) throw prodRes.error;

  const prodById = new Map(
    (prodRes.data ?? []).map((p) => [
      p.id as string,
      {
        nmId: Number(p.nm_id),
        title: (p.title as string) ?? "—",
        photoUrl: (p.photo_url as string) ?? null,
      },
    ]),
  );

  const qtyByWh = new Map<number, number>();
  const prodsByWh = new Map<number, Set<string>>();
  const byProduct = new Map<string, FbsProductRow>();
  let snapshotDate: string | null = null;

  for (const r of aggRows) {
    const wid = Number(r.warehouse_id);
    const qty = Number(r.qty);
    snapshotDate = r.snapshot_date ?? snapshotDate;
    qtyByWh.set(wid, (qtyByWh.get(wid) ?? 0) + qty);
    const set = prodsByWh.get(wid) ?? new Set<string>();
    set.add(r.product_id);
    prodsByWh.set(wid, set);

    const info = prodById.get(r.product_id);
    let row = byProduct.get(r.product_id);
    if (!row) {
      row = {
        productId: r.product_id,
        nmId: info?.nmId ?? 0,
        title: info?.title ?? "—",
        photoUrl: info?.photoUrl ?? null,
        totalQty: 0,
        warehouses: [],
        sizes: [],
      };
      byProduct.set(r.product_id, row);
    }
    row.totalQty += qty;
    const wh = row.warehouses.find((w) => w.warehouseId === wid);
    if (wh) wh.qty += qty;
    else row.warehouses.push({ warehouseId: wid, name: r.warehouse_name, qty });
    const sizeKey = r.size?.trim() || "б/р";
    const sz = row.sizes.find((s) => s.size === sizeKey);
    if (sz) sz.qty += qty;
    else row.sizes.push({ size: sizeKey, qty });
  }

  // Склады из справочника: и пустые тоже — их видно приглушёнными
  const warehouses: FbsWarehouseRow[] = (whRes.data ?? [])
    .filter((w) => !w.is_deleting)
    .map((w) => ({
      warehouseId: Number(w.warehouse_id),
      name: (w.name as string) ?? "—",
      qty: qtyByWh.get(Number(w.warehouse_id)) ?? 0,
      productsCount: prodsByWh.get(Number(w.warehouse_id))?.size ?? 0,
    }))
    .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, "ru"));

  const products = [...byProduct.values()];
  for (const p of products) {
    p.warehouses.sort((a, b) => b.qty - a.qty);
    p.sizes.sort((a, b) => compareSizes(a.size, b.size));
  }
  products.sort((a, b) => b.totalQty - a.totalQty);

  return {
    snapshotDate,
    totalQty: products.reduce((t, p) => t + p.totalQty, 0),
    warehouses,
    products,
  };
}

// ─── Дизайн карточек (заявки) ────────────────────────────────────────────────

export async function getDesignRequests(
  db: SupabaseClient,
): Promise<DesignRequest[]> {
  // У design_requests ДВА FK на profiles — имена FK обязательны (грабли embed)
  const { data, error } = await db
    .from("design_requests")
    .select(
      "id, title, brief, references_text, status, product_id, result_url, result_comment, review_comment, created_at, updated_at, product:products(title, photo_url), requester:profiles!design_requests_requester_id_fkey(full_name), assignee:profiles!design_requests_assignee_id_fkey(full_name)",
    )
    .eq("org_id", DEMO_ORG_ID)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw error;

  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const product = r.product as { title?: string; photo_url?: string } | null;
    const requester = r.requester as { full_name?: string } | null;
    const assignee = r.assignee as { full_name?: string } | null;
    return {
      id: r.id as string,
      title: r.title as string,
      brief: (r.brief as string) ?? null,
      referencesText: (r.references_text as string) ?? null,
      status: r.status as DesignRequest["status"],
      productId: (r.product_id as string) ?? null,
      productTitle: product?.title ?? null,
      productPhotoUrl: product?.photo_url ?? null,
      requesterName: requester?.full_name ?? "—",
      assigneeName: assignee?.full_name ?? null,
      resultUrl: (r.result_url as string) ?? null,
      resultComment: (r.result_comment as string) ?? null,
      reviewComment: (r.review_comment as string) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  });
}

// ─── Регламент обязанностей и отчёты ─────────────────────────────────────────

type DutyTemplateRow = {
  id: string;
  code: string;
  title: string;
  description: string | null;
  role: string;
  assignee_user_id: string | null;
  frequency: "daily" | "weekly";
  weekday: number | null;
  due_time: string;
  hours_to_complete: number;
  requires_report: boolean;
  sort_order: number;
};

// Генерация назначений — вынесена в чистый модуль (используется и ботом).
export { ensureDutyAssignments } from "./duties-core";
import { ensureDutyAssignments as ensureDuties } from "./duties-core";

// Генерация нарядов — идемпотентная запись в БД (3–4 запроса к Supabase, ~1.5 с).
// Раньше она шла на КАЖДЫЙ рендер «Регламента» и «Отчётов», из-за чего эти две
// вкладки были единственными, что оставались медленными даже с тёплым кэшем.
// Наряды и так генерирует cron (/api/cron/duties); ленивый вызов здесь —
// подстраховка. Пять минут: наряды выдаются на день, а пометка просроченных
// (missed) считается от due_time с точностью до часа — задержка в пределах
// пяти минут на неё не влияет, зато вкладка перестаёт платить ~2 с за проверку.
const ENSURE_DUTIES_TTL_MS = 5 * 60_000;
let ensureDutiesAt = 0;
let ensureDutiesInFlight: Promise<void> | null = null;

async function ensureDutiesThrottled(db: SupabaseClient): Promise<void> {
  if (Date.now() - ensureDutiesAt < ENSURE_DUTIES_TTL_MS) return;
  // Параллельные рендеры не должны запускать генерацию несколько раз
  ensureDutiesInFlight ??= ensureDuties(db)
    .then(() => {
      ensureDutiesAt = Date.now();
    })
    .finally(() => {
      ensureDutiesInFlight = null;
    });
  return ensureDutiesInFlight;
}

async function readDuties(
  db: SupabaseClient,
  date: string,
  assigneeId?: string,
): Promise<DutyItem[]> {
  await ensureDutiesThrottled(db);

  let q = db
    .from("duty_assignments")
    .select(
      "id, task_date, due_at, status, completed_at, template:duty_templates(code, title, description, frequency, due_time, hours_to_complete, requires_report, sort_order), assignee:profiles(id, full_name), report:duty_reports(content, on_time)",
    )
    .eq("org_id", DEMO_ORG_ID)
    .eq("task_date", date);
  if (assigneeId) q = q.eq("assignee_id", assigneeId);
  const { data, error } = await q;
  if (error) throw error;

  return ((data ?? []) as Record<string, unknown>[])
    .map((r) => {
      const t = r.template as {
        code: string; title: string; description: string | null;
        frequency: "daily" | "weekly"; due_time: string;
        hours_to_complete: number; requires_report: boolean; sort_order: number;
      };
      const a = r.assignee as { id: string; full_name: string | null };
      const rep = r.report as { content: string; on_time: boolean }[] | { content: string; on_time: boolean } | null;
      const report = Array.isArray(rep) ? (rep[0] ?? null) : rep;
      return {
        id: r.id as string,
        code: t.code,
        title: t.title,
        description: t.description,
        frequency: t.frequency,
        dueAt: r.due_at as string,
        dueLabel: `до ${String(t.due_time).slice(0, 5)}`,
        hoursToComplete: Number(t.hours_to_complete),
        status: r.status as DutyItem["status"],
        completedAt: (r.completed_at as string) ?? null,
        requiresReport: Boolean(t.requires_report),
        reportContent: report?.content ?? null,
        reportOnTime: report?.on_time ?? null,
        assigneeId: a?.id ?? "",
        assigneeName: a?.full_name ?? "—",
        sortOrder: t.sort_order,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(({ sortOrder: _sortOrder, ...item }) => item);
}

export async function getMyDuties(
  db: SupabaseClient,
  userId: string,
): Promise<DutyItem[]> {
  return readDuties(db, isoDate(new Date()), userId);
}

export async function getReportsBoard(
  db: SupabaseClient,
  date?: string,
): Promise<ReportsBoard> {
  const day = date ?? isoDate(new Date());
  const items = await readDuties(db, day);
  return {
    date: day,
    total: items.length,
    done: items.filter((i) => i.status === "done").length,
    onTime: items.filter((i) => i.status === "done" && i.reportOnTime !== false).length,
    missed: items.filter((i) => i.status === "missed").length,
    pending: items.filter((i) => i.status === "pending").length,
    items,
  };
}

// Статистика дисциплины за период — в чистом модуле (нужна и инструменту ИИ).
export { getDutyStats } from "./duties-core";

// Отчёты по задачам, закрытым за день (руководству — страница «Отчёты»)
export async function getTaskReports(
  db: SupabaseClient,
  date?: string,
): Promise<TaskReportItem[]> {
  const day = date ?? isoDate(new Date());
  const { data, error } = await db
    .from("tasks")
    .select(
      "id, title, due_date, completion_report, completed_at, completed_on_time, assignee:profiles!tasks_assignee_id_fkey(full_name)",
    )
    .eq("org_id", DEMO_ORG_ID)
    .eq("status", "done")
    .gte("completed_at", `${day}T00:00:00`)
    .lte("completed_at", `${day}T23:59:59.999`)
    .order("completed_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []).map((t) => {
    const assignee = t.assignee as { full_name?: string } | null;
    return {
      id: t.id as string,
      title: t.title as string,
      assignee: assignee?.full_name ?? "—",
      report: (t.completion_report as string) ?? null,
      completedAt: t.completed_at as string,
      onTime: (t.completed_on_time as boolean) ?? null,
      dueDate: (t.due_date as string) ?? null,
    };
  });
}

// ─── РНП (недельная сетка план/факт из raw_*) ────────────────────────────────

export async function getRnpProducts(
  db: SupabaseClient,
): Promise<RnpProduct[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const curMonday = mondayOf(today);
  const windowStart = new Date(curMonday);
  windowStart.setDate(windowStart.getDate() - 28); // 5 недель окно

  // Заказы/продажи/остатки — дневные агрегаты в Postgres (rpc 0016/0022).
  // agg_rnp_daily (~4.5k строк) и agg_stock_sizes (~1.4k) — через rpcAll:
  // PostgREST режет и rpc-ответы до 1000 строк (терялись данные РНП!).
  //
  // Товары раньше читались ОТДЕЛЬНЫМ ожиданием перед этим блоком — только ради
  // списка pids для фильтра планов. Планы теперь отбираются inner-join'ом по
  // products.store_id, поэтому все восемь запросов идут параллельно (минус одна
  // круговая задержка, плюс исчез URL с 300+ uuid в параметре .in()).
  type StockSizeRow = { product_id: string; size: string | null; on_stock: number; in_transit: number; in_production: number };
  type RnpDailyRow = { nm_id: number; day: string; orders_qty: number; orders_sum: number; sales_qty: number; sales_sum: number; spp_avg: number };
  const [prodRes, plansRes, stock, rnpDaily, funnelRes, advertRes, ueRows, tariffRes] = await Promise.all([
    db.from("products").select("id, nm_id, title, status, category, cost_price, logistics_cost, responsible:profiles(full_name)").eq("store_id", DEMO_STORE_ID).order("nm_id"),
    db.from("rnp_plans").select("product_id, iso_year, iso_week, plan_orders, plan_sales, plan_views, giveaways, products!inner(store_id)").eq("products.store_id", DEMO_STORE_ID),
    rpcAll<StockSizeRow>(db, "agg_stock_sizes", { p_store: DEMO_STORE_ID }),
    rpcAll<RnpDailyRow>(db, "agg_rnp_daily", { p_store: DEMO_STORE_ID, p_since: windowStart.toISOString() }),
    db.from("raw_funnel_daily").select("nm_id, stat_date, open_card_count, add_to_cart_count, orders_count, buyouts_count").eq("store_id", DEMO_STORE_ID).gte("stat_date", isoDate(windowStart)),
    db.from("raw_advert_daily").select("nm_id, stat_date, views, clicks, sum").eq("store_id", DEMO_STORE_ID).gte("stat_date", isoDate(windowStart)),
    // Факт удержаний по товарам за окно (ошибка не роняет РНП — фолбэк на тарифы)
    readUnitEconAgg(db, windowStart, today).catch(() => [] as UnitEconAggRow[]),
    db.from("wb_commission_tariffs").select("subject_name, kgvp_marketplace").eq("store_id", DEMO_STORE_ID),
  ]);

  if (prodRes.error) throw prodRes.error;
  const products = prodRes.data;
  if (!products || products.length === 0) return [];

  for (const res of [plansRes, funnelRes, advertRes]) {
    if (res.error) throw res.error;
  }
  const plans = plansRes.data ?? [];
  const funnel = funnelRes.data ?? [];
  const advert = advertRes.data ?? [];
  const ueByNm = new Map(ueRows.map((r) => [Number(r.nm_id), r]));
  // Комиссия по категории (тарифы WB) — фолбэк, когда продаж в окне не было
  const tariffByCategory = new Map(
    (tariffRes.data ?? []).map((t) => [
      String(t.subject_name ?? "").toLowerCase(),
      Number(t.kgvp_marketplace ?? 0),
    ]),
  );

  // Группировка дневных агрегатов по артикулу
  const dailyByNm = new Map<number, RnpDailyRow[]>();
  for (const r of rnpDaily) {
    const list = dailyByNm.get(Number(r.nm_id)) ?? [];
    list.push(r);
    dailyByNm.set(Number(r.nm_id), list);
  }

  // 5 недель (от старой к текущей) + дневные слоты текущей недели
  const weekMondays: Date[] = [];
  for (let i = 4; i >= 0; i--) {
    const m = new Date(curMonday);
    m.setDate(m.getDate() - i * 7);
    weekMondays.push(m);
  }
  const weekKeys = weekMondays.map((m) => isoWeekOf(m));
  const daySlots: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(curMonday);
    d.setDate(d.getDate() + i);
    daySlots.push(d);
  }

  const rnpProducts = products.map((p) => {
    const nm = Number(p.nm_id);
    const pd = dailyByNm.get(nm) ?? [];
    const byDate = new Map(pd.map((r) => [r.day, r]));
    const pf = funnel.filter((f) => Number(f.nm_id) === nm);
    const pa = advert.filter((a) => Number(a.nm_id) === nm);
    const pl = plans.filter((x) => x.product_id === p.id);
    const pstock = stock.filter((x) => x.product_id === p.id);
    const planByWeek = new Map(pl.map((x) => [`${x.iso_year}-${x.iso_week}`, x]));
    const curPlan = planByWeek.get(`${weekKeys[4].year}-${weekKeys[4].week}`);

    // Дни текущей недели
    const days: RnpDay[] = daySlots.map((d) => {
      const key = isoDate(d);
      const row = byDate.get(key);
      const f = pf.find((x) => x.stat_date === key);
      const a = pa.find((x) => x.stat_date === key);
      const ordersFact = Number(row?.orders_qty ?? 0);
      const ordersSumRub = Math.round(Number(row?.orders_sum ?? 0));
      const salesFact = Number(row?.sales_qty ?? 0);
      const salesSumRub = Math.round(Number(row?.sales_sum ?? 0));
      const spp = Number(row?.spp_avg ?? 0);
      const opens = Number(f?.open_card_count ?? 0);
      const cartQty = Number(f?.add_to_cart_count ?? 0);
      const views = Number(a?.views ?? 0);
      const clicks = Number(a?.clicks ?? 0);
      return {
        date: key,
        label: `${dayLabel(key)} ${WEEKDAYS[d.getDay()]}`,
        ordersFact,
        ordersPlan: curPlan?.plan_orders ? Math.round(Number(curPlan.plan_orders) / 7) : 0,
        sppPct: Math.round(spp * 10) / 10,
        salesFact,
        salesPlan: curPlan?.plan_sales ? Math.round(Number(curPlan.plan_sales) / 7) : 0,
        avgCheck: salesFact ? Math.round(salesSumRub / salesFact) : 0,
        giveaways: 0,
        ordersSumRub,
        salesSumRub,
        views,
        clicks,
        ctrPct: views ? Math.round((clicks / views) * 1000) / 10 : 0,
        cartQty,
        cartPct: opens ? Math.round((cartQty / opens) * 1000) / 10 : 0,
        orderPct: cartQty ? Math.round((ordersFact / cartQty) * 1000) / 10 : 0,
        croPct: opens ? Math.round((ordersFact / opens) * 10000) / 100 : 0,
      };
    });

    // Недели (суммы дневных агрегатов внутри недельного окна)
    const weeks: RnpWeek[] = weekMondays.map((wm, wi) => {
      const wEnd = new Date(wm);
      wEnd.setDate(wEnd.getDate() + 7);
      const wRows = pd.filter((r) => {
        const t = new Date(`${r.day}T00:00:00`);
        return t >= wm && t < wEnd;
      });
      const wk = weekKeys[wi];
      const plan = planByWeek.get(`${wk.year}-${wk.week}`);
      return {
        label: `Нед ${wk.week}`,
        ordersFact: wRows.reduce((t, r) => t + Number(r.orders_qty), 0),
        ordersPlan: Number(plan?.plan_orders ?? 0),
        salesFact: wRows.reduce((t, r) => t + Number(r.sales_qty), 0),
        salesPlan: Number(plan?.plan_sales ?? 0),
        ordersSumRub: Math.round(wRows.reduce((t, r) => t + Number(r.orders_sum), 0)),
        salesSumRub: Math.round(wRows.reduce((t, r) => t + Number(r.sales_sum), 0)),
      };
    });
    weeks.push({
      label: "ИТОГ",
      ordersFact: weeks.reduce((t, w) => t + w.ordersFact, 0),
      ordersPlan: weeks.reduce((t, w) => t + w.ordersPlan, 0),
      salesFact: weeks.reduce((t, w) => t + w.salesFact, 0),
      salesPlan: weeks.reduce((t, w) => t + w.salesPlan, 0),
      ordersSumRub: weeks.reduce((t, w) => t + w.ordersSumRub, 0),
      salesSumRub: weeks.reduce((t, w) => t + w.salesSumRub, 0),
    });

    // Матрица размеров (rpc уже отдаёт последний снимок товара)
    const latestStock = pstock;
    const present = SIZES_ORDER.filter((sz) => latestStock.some((r) => r.size === sz));
    const sizes = present.length ? present : SIZES_ORDER.slice(0, 9);
    const sumBy = (field: "on_stock" | "in_transit" | "in_production") =>
      sizes.map((sz) => latestStock.filter((r) => r.size === sz).reduce((t, r) => t + Number(r[field] ?? 0), 0));
    const onStock = sumBy("on_stock");
    const inTransit = sumBy("in_transit");
    const inProd = sumBy("in_production");
    const sizeMatrix: SizeMatrix = {
      sizes,
      rows: [
        { label: "На складе", values: onStock },
        { label: "В пути", values: inTransit },
        { label: "Общий", values: sizes.map((_, i) => onStock[i] + inTransit[i]) },
        { label: "В пошиве", values: inProd },
      ],
    };

    // Экономика (окно 5 недель). Удержания — факт из отчётов WB (agg_unit_econ);
    // если продаж в окне не было — прогноз: комиссия по тарифу категории,
    // логистика из карточки товара.
    const winOrdersQty = pd.reduce((t, r) => t + Number(r.orders_qty), 0);
    const winSalesQty = pd.reduce((t, r) => t + Number(r.sales_qty), 0);
    const ordersSumWin = pd.reduce((t, r) => t + Number(r.orders_sum), 0);
    const priceRub = winOrdersQty ? Math.round(ordersSumWin / winOrdersQty) : 0;
    const cost = Number(p.cost_price ?? 0);
    const ue = ueByNm.get(nm);
    const netQty = ue ? Number(ue.sale_qty) - Number(ue.return_qty) : 0;
    const tariffPct =
      tariffByCategory.get(String(p.category ?? "").toLowerCase()) || 24.5;
    let commission = Math.round((priceRub * tariffPct) / 100);
    let logistics = Number(p.logistics_cost ?? 0);
    let storagePerUnit = 0;
    if (ue && netQty > 0) {
      commission = Math.round(
        (Number(ue.commission_rub) + Number(ue.acquiring_rub)) / netQty,
      );
      logistics = Math.round(Number(ue.logistics_rub) / netQty);
      storagePerUnit = Math.round(Number(ue.storage_rub) / netQty);
    }
    const profitPerUnit = priceRub - cost - commission - logistics - storagePerUnit;
    const totalViews = pa.reduce((t, a) => t + Number(a.views ?? 0), 0);
    const totalClicks = pa.reduce((t, a) => t + Number(a.clicks ?? 0), 0);
    const totalSpend = pa.reduce((t, a) => t + Number(a.sum ?? 0), 0);
    const totalOpens = pf.reduce((t, f) => t + Number(f.open_card_count ?? 0), 0);
    const funnelOrders = pf.reduce((t, f) => t + Number(f.orders_count ?? 0), 0);
    const funnelBuyouts = pf.reduce((t, f) => t + Number(f.buyouts_count ?? 0), 0);
    const daysWithOrders = pd.filter((r) => Number(r.orders_qty) > 0);
    const spp = daysWithOrders.length
      ? daysWithOrders.reduce((t, r) => t + Number(r.spp_avg), 0) / daysWithOrders.length
      : 0;

    const responsible = p.responsible as { full_name?: string } | null;
    return {
      id: p.id as string,
      nmId: nm,
      tabLabel: (p.title as string)?.split(" ")[0] ?? String(nm),
      title: (p.title as string) ?? "—",
      status: (p.status as string) ?? "—",
      responsible: responsible?.full_name ?? "—",
      economics: {
        costPrice: cost,
        logistics,
        priceRub,
        // Прибыль за окно: факт (реализация − удержания − реклама − себестоимость),
        // если отчёт WB уже покрыл окно; иначе оценка по прибыли с единицы
        profitRub:
          ue && Number(ue.revenue_rub) > 0
            ? Math.round(
                Number(ue.revenue_rub) -
                  Number(ue.commission_rub) -
                  Number(ue.acquiring_rub) -
                  Number(ue.logistics_rub) -
                  Number(ue.storage_rub) -
                  Number(ue.acceptance_rub) -
                  Number(ue.penalty_rub) -
                  Number(ue.deduction_rub) -
                  Number(ue.advert_rub) -
                  cost * Math.max(netQty, 0),
              )
            : Math.round(profitPerUnit * Math.max(winSalesQty, 1)),
        marginPct: priceRub ? Math.round((profitPerUnit / priceRub) * 1000) / 10 : 0,
        profitabilityPct: cost ? Math.round((profitPerUnit / cost) * 1000) / 10 : 0,
        drrPct: ordersSumWin ? Math.round((totalSpend / ordersSumWin) * 1000) / 10 : 0,
        ctrPct: totalViews ? Math.round((totalClicks / totalViews) * 1000) / 10 : 0,
        views: totalViews,
        buyoutPct: funnelOrders ? Math.round((funnelBuyouts / funnelOrders) * 1000) / 10 : 0,
        croPct: totalOpens ? Math.round((funnelOrders / totalOpens) * 10000) / 100 : 0,
        sppPct: Math.round(spp * 10) / 10,
      },
      sizeMatrix,
      days,
      weeks,
    };
  });

  // Кабинет на сотни SKU: в РНП показываем топ по заказам за окно
  // (вкладку на каждый из 268 товаров интерфейс не вместит)
  return rnpProducts
    .sort((a, b) => {
      const sum = (x: RnpProduct) => x.weeks[x.weeks.length - 1]?.ordersSumRub ?? 0;
      return sum(b) - sum(a);
    })
    .slice(0, 12);
}
