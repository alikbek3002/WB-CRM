import { NextResponse } from "next/server";
import { z } from "zod";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "@/shared/constants";
import { CURRENCY_CODES, rateToBase } from "@/shared/currency";
import { readCurrencyRateMap } from "@/backend/data/currency-core";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { invalidateWbData, SUPPLY_SCOPES } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Создание карточки отгрузки (КП 4.1). Роль supply:edit (закупщики Китай/Узбекистан).
// Позиция поставки: один артикул со своим количеством и отшивом.
// Карго и услуги фул-фирмы — общие на поставку, делятся между позициями
// пропорционально количеству (backend/data/cost-core.ts).
const itemSchema = z.object({
  productId: z.string().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(0),
  sewingCost: z.number().min(0),
  sewingCurrency: z.enum(CURRENCY_CODES),
});

const supplySchema = z.object({
  factoryId: z.string(),
  productId: z.string().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(0),
  shipDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sewingCost: z.number().min(0),
  sewingCurrency: z.enum(CURRENCY_CODES),
  cargoCost: z.number().min(0),
  cargoCurrency: z.enum(CURRENCY_CODES),
  // Несколько товаров в одном карго. Пусто — карточка старой схемы «один товар».
  items: z.array(itemSchema).max(50).optional(),
  fulfillmentPartnerId: z.string().nullable().optional(),
  // Куда разгружаем карго (0042): город фул-фирмы. Фиксируем на карточке —
  // подрядчика могут сменить, а факт «партия приехала в Казань» остаётся.
  unloadCity: z.string().trim().max(120).nullable().optional(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "supply:edit")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = supplySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  // Демо-режим (нет БД) — принимаем без записи
  if (!admin) {
    return NextResponse.json({ ok: true, persisted: false, supply: parsed.data });
  }

  // С реальной БД id обязаны быть настоящими UUID — не теряем связку молча
  if (!UUID.test(parsed.data.factoryId)) {
    return NextResponse.json({ error: "invalid_factory_id" }, { status: 400 });
  }
  if (parsed.data.productId && !UUID.test(parsed.data.productId)) {
    return NextResponse.json({ error: "invalid_product_id" }, { status: 400 });
  }
  const productId = parsed.data.productId ?? null;

  const items = parsed.data.items ?? [];
  for (const i of items) {
    if (i.productId && !UUID.test(i.productId)) {
      return NextResponse.json({ error: "invalid_product_id" }, { status: 400 });
    }
  }
  const partnerId = parsed.data.fulfillmentPartnerId ?? null;
  if (partnerId && !UUID.test(partnerId)) {
    return NextResponse.json({ error: "invalid_partner_id" }, { status: 400 });
  }

  // Курсы фиксируем на дату заведения: их правят руками во «Валютах», и без
  // фиксации правка задним числом переписала бы себестоимость закрытой партии.
  const rates = await readCurrencyRateMap(admin);
  const rateOf = (c: string) => rateToBase(c, rates);

  // Шапка: количество и отшив — сумма по позициям (при их наличии)
  const headQty = items.length
    ? items.reduce((t, i) => t + i.quantity, 0)
    : parsed.data.quantity;

  const { data, error } = await admin
    .from("supplies")
    .insert({
      org_id: DEMO_ORG_ID,
      store_id: DEMO_STORE_ID,
      factory_id: parsed.data.factoryId,
      product_id: productId,
      title: parsed.data.title,
      quantity: headQty,
      ship_date: parsed.data.shipDate,
      sewing_cost: parsed.data.sewingCost,
      sewing_currency: parsed.data.sewingCurrency,
      cargo_cost: parsed.data.cargoCost,
      cargo_currency: parsed.data.cargoCurrency,
      cargo_rate_to_rub: rateOf(parsed.data.cargoCurrency),
      fulfillment_partner_id: partnerId,
      unload_city: parsed.data.unloadCity?.trim() || null,
      status: "in_transit",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[supplies] insert failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  if (items.length) {
    const { error: itemsErr } = await admin.from("supply_items").insert(
      items.map((i) => ({
        supply_id: data.id,
        product_id: i.productId ?? null,
        title: i.title,
        quantity: i.quantity,
        sewing_cost: i.sewingCost,
        sewing_currency: i.sewingCurrency,
        sewing_rate_to_rub: rateOf(i.sewingCurrency),
      })),
    );
    if (itemsErr) {
      // Поставка без позиций посчитала бы себестоимость по пустой базе —
      // откатываем целиком, чтобы не оставить полуфабрикат.
      console.error("[supplies] insert items failed:", itemsErr);
      await admin.from("supplies").delete().eq("id", data.id);
      return NextResponse.json({ error: "db_error" }, { status: 500 });
    }
  }

  invalidateWbData(...SUPPLY_SCOPES);
  return NextResponse.json({ ok: true, persisted: true, id: data.id });
}
