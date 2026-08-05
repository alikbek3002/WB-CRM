import { NextResponse } from "next/server";
import { z } from "zod";
import { DEMO_ORG_ID } from "@/shared/constants";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Фул-фирма с тарифом за единицу приёмки/разбора/упаковки. Начисление за
// поставку = тариф × принято (перебивается фактической суммой на карточке).
// Эти деньги входят в себестоимость единицы, а не в расходы периода.
const partnerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  ratePerUnitRub: z.number().min(0).max(100000),
  note: z.string().trim().max(500).nullable().optional(),
});

const patchSchema = partnerSchema.partial().extend({
  id: z.string(),
  archived: z.boolean().optional(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "fulfillment:manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = partnerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ ok: true, persisted: false, partner: parsed.data });
  }

  const { data, error } = await admin
    .from("fulfillment_partners")
    .insert({
      org_id: DEMO_ORG_ID,
      name: parsed.data.name,
      rate_per_unit_rub: parsed.data.ratePerUnitRub,
      note: parsed.data.note ?? null,
    })
    .select("id")
    .single();

  if (error) {
    // Имя уникально в рамках организации
    if (error.code === "23505") {
      return NextResponse.json({ error: "duplicate_name" }, { status: 409 });
    }
    console.error("[fulfillment/partners] insert failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  invalidateWbData("fulfillment", "fulfillment-partners");
  return NextResponse.json({ ok: true, persisted: true, id: data.id });
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!can(session.role, "fulfillment:manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success || !UUID.test(parsed.data.id)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ ok: true, persisted: false });

  const patch: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.ratePerUnitRub !== undefined) {
    patch.rate_per_unit_rub = parsed.data.ratePerUnitRub;
  }
  if (parsed.data.note !== undefined) patch.note = parsed.data.note;
  if (parsed.data.archived !== undefined) patch.archived = parsed.data.archived;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  const { error } = await admin
    .from("fulfillment_partners")
    .update(patch)
    .eq("id", parsed.data.id)
    .eq("org_id", DEMO_ORG_ID);

  if (error) {
    console.error("[fulfillment/partners] update failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  // Тариф меняет расчёт начислений — обновляем и сводку фул-фирмы.
  // Себестоимость уже принятых партий НЕ пересчитывается: она зафиксирована
  // на момент приёмки (см. product_cost_history).
  invalidateWbData("fulfillment", "fulfillment-partners");
  return NextResponse.json({ ok: true, persisted: true });
}
