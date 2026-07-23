import { NextResponse } from "next/server";
import { z } from "zod";
import { DEMO_PRODUCT_IDS } from "@/shared/constants";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const planSchema = z.object({
  productId: z.string(),
  isoYear: z.number().int().min(2020).max(2100),
  isoWeek: z.number().int().min(1).max(53),
  planOrders: z.number().int().min(0).nullable().optional(),
  planSales: z.number().int().min(0).nullable().optional(),
  planViews: z.number().int().min(0).nullable().optional(),
  giveaways: z.number().int().min(0).optional(),
});

// Демо-id товаров РНП (p1..p4) → реальные uuid строк products (сид).
// UUID передаётся как есть; неизвестный id — persisted:false.
function resolveProductId(id: string): string | null {
  if (id in DEMO_PRODUCT_IDS) {
    return DEMO_PRODUCT_IDS[id as keyof typeof DEMO_PRODUCT_IDS];
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuid.test(id) ? id : null;
}

// Инлайн-редактирование планов РНП (раздел 11.2). Роль manager+ (раздел 5.1).
// Upsert в rnp_plans по unique (product_id, iso_year, iso_week).
export async function PUT(request: Request) {
  const session = await getSession();
  if (!can(session.role, "rnp:edit")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = planSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  const productId = resolveProductId(parsed.data.productId);

  if (!admin || !productId) {
    // Нет БД или неизвестный товар — принимаем без записи (демо)
    return NextResponse.json({ ok: true, persisted: false, plan: parsed.data });
  }

  const { error } = await admin.from("rnp_plans").upsert(
    {
      product_id: productId,
      iso_year: parsed.data.isoYear,
      iso_week: parsed.data.isoWeek,
      plan_orders: parsed.data.planOrders ?? null,
      plan_sales: parsed.data.planSales ?? null,
      plan_views: parsed.data.planViews ?? null,
      giveaways: parsed.data.giveaways ?? 0,
    },
    { onConflict: "product_id,iso_year,iso_week" },
  );

  if (error) {
    console.error("[rnp/plans] upsert failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  invalidateWbData();
  return NextResponse.json({ ok: true, persisted: true, plan: parsed.data });
}
