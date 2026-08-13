// Себестоимость товара — ЕДИНОЕ место расчёта для всех входов: веб (приёмка
// поставки), Telegram-бот и ИИ-ассистент. Раньше формула жила прямо в
// api/supplies/[id]/receive, а инструмент ИИ receive_supply её просто не вызывал —
// приёмка через бота молча не обновляла себестоимость.
//
// ЧТО ВХОДИТ В СЕБЕСТОИМОСТЬ ЕДИНИЦЫ:
//   отшив на фабрике + карго (доставка) + услуги фул-фирмы.
// Все три — затраты на доведение товара до склада WB, поэтому они капитализируются
// в запас и списываются в ОПиУ через себестоимость проданного, а не как расход
// периода. Статьи «Карго и доставка» и «Фулфилмент» имеют in_pnl = false
// (миграция 0037) — иначе те же деньги вычитались бы из прибыли дважды.
//
// Чистый модуль (npm + относительные импорты) — работает и в Turbopack, и в tsx.

import type { SupabaseClient } from "@supabase/supabase-js";
import { rateToBase, type CurrencyRateMap } from "../../shared/currency";
import { readCurrencyRateMap } from "./currency-core";

// Себестоимость считается в базовой валюте — сомах (shared/currency.ts).
// Курс: зафиксированный на поставке имеет приоритет над текущим из «Валют».
// Курсы правятся руками, и без фиксации правка задним числом переписала бы
// себестоимость уже закрытых партий.
function toBaseAt(
  amount: number,
  currency: string,
  rate: number | null,
  rates: CurrencyRateMap,
): number {
  return amount * (rate && rate > 0 ? rate : rateToBase(currency, rates));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export type CostItemInput = {
  productId: string | null;
  quantity: number;
  receivedQty: number | null;
  sewingCost: number;
  sewingCurrency: string;
  sewingRateToRub: number | null;
};

export type CostBreakdown = {
  productId: string;
  qty: number; // принято (или отгружено, если приёмки ещё не было)
  sewingRub: number; // сом на единицу
  cargoRub: number;
  fulfillmentRub: number;
  unitCostRub: number; // сумма трёх
};

/**
 * Себестоимость единицы по каждой позиции поставки.
 *
 * Карго и услуги ФФ — общие на всю поставку, поэтому делятся между позициями
 * ПРОПОРЦИОНАЛЬНО КОЛИЧЕСТВУ: доля позиции = qty_i / Σqty. После деления на
 * qty_i это даёт одинаковую надбавку на единицу для всех позиций
 * (cargoTotal / Σqty) — что и правильно, когда товар однотипный и место в
 * карго занимает по штукам, а не по стоимости.
 *
 * Недостача удорожает единицу: делим на ПРИНЯТОЕ, а не на отгруженное.
 * Это осознанное поведение — за потерянный в пути товар всё равно заплачено.
 */
export function computeBatchCosts(
  items: CostItemInput[],
  cargoRubTotal: number,
  fulfillmentRubTotal: number,
  rates: CurrencyRateMap = {},
): CostBreakdown[] {
  const qtyOf = (i: CostItemInput) =>
    i.receivedQty != null && i.receivedQty > 0 ? i.receivedQty : i.quantity;

  const base = items.reduce((t, i) => t + qtyOf(i), 0);
  if (base <= 0) return [];

  const cargoPerUnit = cargoRubTotal / base;
  const ffPerUnit = fulfillmentRubTotal / base;

  const out: CostBreakdown[] = [];
  for (const i of items) {
    const qty = qtyOf(i);
    if (!i.productId || qty <= 0) continue;
    const sewingRub =
      toBaseAt(i.sewingCost, i.sewingCurrency, i.sewingRateToRub, rates) / qty;
    out.push({
      productId: i.productId,
      qty,
      sewingRub: round2(sewingRub),
      cargoRub: round2(cargoPerUnit),
      fulfillmentRub: round2(ffPerUnit),
      unitCostRub: round2(sewingRub + cargoPerUnit + ffPerUnit),
    });
  }
  return out;
}

/**
 * Средневзвешенная себестоимость при приходе новой партии:
 *   (остаток × старая цена + принято × цена партии) / (остаток + принято)
 *
 * Без этого прибыль скакала бы: подорожавшая партия из 50 шт переписывала
 * себестоимость 5000 шт уже лежащего остатка.
 *
 * Остаток берётся со складов WB (agg_stock_by_product). Товар, который ещё
 * лежит у фул-фирмы и не уехал на WB, в остатке не виден — средневзвешенная
 * будет смещена в сторону новой партии. Приемлемое приближение: точного учёта
 * собственного склада в системе нет.
 */
export function weightedAverageCost(
  oldRub: number,
  stockQty: number,
  batchRub: number,
  receivedQty: number,
): number {
  if (stockQty <= 0 || oldRub <= 0 || receivedQty <= 0) return round2(batchRub);
  return round2((stockQty * oldRub + receivedQty * batchRub) / (stockQty + receivedQty));
}

export type CostApplyResult = {
  updated: number; // сколько товаров пересчитано
  items: (CostBreakdown & { previousRub: number; appliedRub: number })[];
};

/**
 * Пересчитать и записать себестоимость всех товаров поставки.
 * Вызывается после приёмки — и из HTTP-роута, и из инструмента ИИ.
 */
export async function applySupplyCost(
  db: SupabaseClient,
  supplyId: string,
  actorId: string | null,
): Promise<CostApplyResult> {
  const empty: CostApplyResult = { updated: 0, items: [] };

  const { data: supplyRow, error: supErr } = await db
    .from("supplies")
    .select(
      "store_id, cargo_cost, cargo_currency, cargo_rate_to_rub, fulfillment_cost_rub, fulfillment_partner_id, product_id, quantity, received_qty, sewing_cost, sewing_currency",
    )
    .eq("id", supplyId)
    .single();
  if (supErr || !supplyRow) return empty;
  const supply = supplyRow as unknown as Record<string, unknown>;
  const storeId = String(supply.store_id ?? "");

  // Позиции. Если их нет — поставка заведена по старой схеме «один товар на
  // карточку»: собираем одну синтетическую позицию из полей самой поставки.
  const { data: rawRows } = await db
    .from("supply_items")
    .select("product_id, quantity, received_qty, sewing_cost, sewing_currency, sewing_rate_to_rub")
    .eq("supply_id", supplyId);
  const rows = (rawRows ?? []) as unknown as Record<string, unknown>[];

  const items: CostItemInput[] = rows.length
    ? rows.map((r) => ({
        productId: (r.product_id as string) ?? null,
        quantity: Number(r.quantity ?? 0),
        receivedQty: r.received_qty == null ? null : Number(r.received_qty),
        sewingCost: Number(r.sewing_cost ?? 0),
        sewingCurrency: String(r.sewing_currency ?? "kgs"),
        sewingRateToRub: r.sewing_rate_to_rub == null ? null : Number(r.sewing_rate_to_rub),
      }))
    : [
        {
          productId: (supply.product_id as string) ?? null,
          quantity: Number(supply.quantity ?? 0),
          receivedQty: supply.received_qty == null ? null : Number(supply.received_qty),
          sewingCost: Number(supply.sewing_cost ?? 0),
          sewingCurrency: String(supply.sewing_currency ?? "kgs"),
          sewingRateToRub: null,
        },
      ];

  const totalQty = items.reduce(
    (t, i) => t + (i.receivedQty != null && i.receivedQty > 0 ? i.receivedQty : i.quantity),
    0,
  );

  const rates = await readCurrencyRateMap(db);
  const cargoRubTotal = toBaseAt(
    Number(supply.cargo_cost ?? 0),
    String(supply.cargo_currency ?? "kgs"),
    supply.cargo_rate_to_rub == null ? null : Number(supply.cargo_rate_to_rub),
    rates,
  );
  const partnerId = supply.fulfillment_partner_id ? String(supply.fulfillment_partner_id) : null;

  // Услуги ФФ: фактическая сумма имеет приоритет над тарифом партнёра
  let ffRubTotal = Number(supply.fulfillment_cost_rub ?? 0);
  if (!ffRubTotal && partnerId) {
    const { data: partnerRow } = await db
      .from("fulfillment_partners")
      .select("rate_per_unit_rub")
      .eq("id", partnerId)
      .maybeSingle();
    const partner = partnerRow as unknown as { rate_per_unit_rub?: number } | null;
    ffRubTotal = Number(partner?.rate_per_unit_rub ?? 0) * totalQty;
  }

  const batch = computeBatchCosts(items, cargoRubTotal, ffRubTotal, rates);
  if (batch.length === 0) return empty;

  // Остатки на складах WB — база для средневзвешенной
  const stockByProduct = new Map<string, number>();
  const { data: stock } = await db.rpc("agg_stock_by_product", { p_store: storeId });
  for (const r of (stock ?? []) as { product_id: string; on_stock: number }[]) {
    stockByProduct.set(r.product_id, Number(r.on_stock ?? 0));
  }

  const now = new Date().toISOString();
  const result: CostApplyResult = { updated: 0, items: [] };

  for (const b of batch) {
    const { data: prodRow } = await db
      .from("products")
      .select("cost_price, cost_sewing_rub, cost_cargo_rub, cost_fulfillment_rub")
      .eq("id", b.productId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (!prodRow) continue;
    const prod = prodRow as unknown as Record<string, unknown>;

    const stockQty = stockByProduct.get(b.productId) ?? 0;
    const prevRub = Number(prod.cost_price ?? 0);

    // Каждую составляющую усредняем отдельно, чтобы разбивка сходилась с итогом
    const avg = (oldV: number, newV: number) =>
      weightedAverageCost(oldV, stockQty, newV, b.qty);
    const sewing = avg(Number(prod.cost_sewing_rub ?? 0), b.sewingRub);
    const cargo = avg(Number(prod.cost_cargo_rub ?? 0), b.cargoRub);
    const ff = avg(Number(prod.cost_fulfillment_rub ?? 0), b.fulfillmentRub);
    const applied = round2(sewing + cargo + ff);

    const { error: updErr } = await db
      .from("products")
      .update({
        cost_price: applied,
        cost_sewing_rub: sewing,
        cost_cargo_rub: cargo,
        cost_fulfillment_rub: ff,
        cost_price_source: "supply",
        cost_price_updated_at: now,
      })
      .eq("id", b.productId)
      .eq("store_id", storeId);
    if (updErr) {
      console.error("[cost-core] не удалось записать себестоимость:", updErr.message);
      continue;
    }

    result.updated += 1;
    result.items.push({ ...b, previousRub: prevRub, appliedRub: applied });

    const { error: histErr } = await db.from("product_cost_history").insert({
      product_id: b.productId,
      cost_price: applied,
      source: "supply",
      supply_id: supplyId,
      created_by: actorId,
      sewing_rub: b.sewingRub,
      cargo_rub: b.cargoRub,
      fulfillment_rub: b.fulfillmentRub,
      qty: b.qty,
    });
    if (histErr) console.error("[cost-core] история себестоимости:", histErr.message);
  }

  return result;
}
