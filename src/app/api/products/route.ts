import { NextResponse } from "next/server";
import { z } from "zod";
import { DEMO_STORE_ID } from "@/shared/constants";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { getProductList } from "@/backend/data";
import { invalidateWbData, PRODUCT_SCOPES } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
  const session = await getSession();
  if (!can(session.role, "products:view")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ products: await getProductList() });
}

// ─── Создание карточки товара ────────────────────────────────────────────────
// До подключения WB API карточки заводятся вручную (артикул WB = nm_id).

const createSchema = z.object({
  nmId: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  vendorCode: z.string().trim().max(100).optional().nullable(),
  brand: z.string().trim().max(100).optional().nullable(),
  category: z.string().trim().max(100).optional().nullable(),
  status: z.string().trim().max(50).optional().nullable(),
  costPrice: z.number().min(0).optional(),
  logisticsCost: z.number().min(0).optional(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "products:edit")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ ok: true, persisted: false, product: parsed.data });
  }

  const p = parsed.data;
  const { data, error } = await admin
    .from("products")
    .insert({
      store_id: DEMO_STORE_ID,
      nm_id: p.nmId,
      title: p.title,
      vendor_code: p.vendorCode || null,
      brand: p.brand || null,
      category: p.category || null,
      status: p.status || "Новинка",
      cost_price: p.costPrice ?? 0,
      logistics_cost: p.logisticsCost ?? 0,
      responsible_user_id: UUID.test(session.user.id) ? session.user.id : null,
    })
    .select("id")
    .single();

  if (error) {
    // unique (store_id, nm_id) — такой артикул уже есть
    if (error.code === "23505") {
      return NextResponse.json({ error: "duplicate_nm_id" }, { status: 409 });
    }
    console.error("[products] insert failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  if ((p.costPrice ?? 0) > 0) {
    await admin.from("product_cost_history").insert({
      product_id: data.id,
      cost_price: p.costPrice,
      source: "manual",
      created_by: UUID.test(session.user.id) ? session.user.id : null,
    });
  }

  invalidateWbData(...PRODUCT_SCOPES);
  return NextResponse.json({ ok: true, persisted: true, id: data.id });
}

// ─── Редактирование карточки ─────────────────────────────────────────────────

const patchSchema = z.object({
  id: z.string().regex(UUID),
  title: z.string().trim().min(1).max(200).optional(),
  vendorCode: z.string().trim().max(100).optional().nullable(),
  brand: z.string().trim().max(100).optional().nullable(),
  category: z.string().trim().max(100).optional().nullable(),
  status: z.string().trim().max(50).optional().nullable(),
  costPrice: z.number().min(0).optional(),
  logisticsCost: z.number().min(0).optional(),
});

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!can(session.role, "products:edit")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ ok: true, persisted: false });
  }

  const p = parsed.data;
  const patch: Record<string, unknown> = {};
  if (p.title !== undefined) patch.title = p.title;
  if (p.vendorCode !== undefined) patch.vendor_code = p.vendorCode || null;
  if (p.brand !== undefined) patch.brand = p.brand || null;
  if (p.category !== undefined) patch.category = p.category || null;
  if (p.status !== undefined) patch.status = p.status || null;
  if (p.costPrice !== undefined) {
    patch.cost_price = p.costPrice;
    patch.cost_price_source = "manual";
    patch.cost_price_updated_at = new Date().toISOString();
  }
  if (p.logisticsCost !== undefined) patch.logistics_cost = p.logisticsCost;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "empty_patch" }, { status: 400 });
  }

  const { data: updated, error } = await admin
    .from("products")
    .update(patch)
    .eq("id", p.id)
    .eq("store_id", DEMO_STORE_ID)
    .select("id");

  if (error) {
    console.error("[products] update failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (p.costPrice !== undefined) {
    await admin.from("product_cost_history").insert({
      product_id: p.id,
      cost_price: p.costPrice,
      source: "manual",
      created_by: UUID.test(session.user.id) ? session.user.id : null,
    });
  }

  invalidateWbData(...PRODUCT_SCOPES);
  return NextResponse.json({ ok: true, persisted: true });
}
