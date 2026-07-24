// Синхронизация данных Wildberries → Supabase.
// Источники: карточки (контент+фото+описание), цены, остатки, заказы, продажи.
// Пользовательские поля товара (себестоимость, статус, ответственный) НЕ трогаем.
// Каждый источник фиксируется в sync_runs; статус токена — в integration_credentials.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_STORE_ID } from "@/shared/constants";
import {
  decodeTokenMeta,
  fetchAllCards,
  fetchOrders,
  fetchPrices,
  fetchSales,
  fetchSellerInfo,
  fetchWarehouseRemains,
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

async function chunkedUpsert(
  db: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
): Promise<number> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await db
      .from(table)
      .upsert(rows.slice(i, i + CHUNK), { onConflict });
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
  const { data: run } = await db
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
export const WB_SYNC_SOURCES = ["cards", "stocks", "orders", "sales"] as const;
export type WbSyncSource = (typeof WB_SYNC_SOURCES)[number];

// days — стартовое окно заказов/продаж при пустой БД (дальше — по курсору
// last_change_date); maxBatches — партий по 80k за запуск (интерактив 2, cron больше);
// sources — какие источники тянуть (по умолчанию все).
export async function runWbSync(
  db: SupabaseClient,
  days = 30,
  maxBatches = 2,
  sources: readonly WbSyncSource[] = WB_SYNC_SOURCES,
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
