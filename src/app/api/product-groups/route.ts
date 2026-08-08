import { NextResponse } from "next/server";
import { z } from "zod";
import { DEMO_ORG_ID } from "@/shared/constants";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { getProductGroups } from "@/backend/data";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Группы товаров (0039): создание/переименование/удаление — только директор,
// админ и ст. менеджер (products:groups). Список групп видят все, кому доступны
// товары: он нужен фильтру на «Товарах».

export async function GET() {
  const session = await getSession();
  if (!can(session.role, "products:view")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ groups: await getProductGroups() });
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "products:groups")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ ok: true, persisted: false });

  const { data, error } = await admin
    .from("product_groups")
    .insert({
      org_id: DEMO_ORG_ID,
      name: parsed.data.name,
      created_by: UUID.test(session.user.id) ? session.user.id : null,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "duplicate_name" }, { status: 409 });
    }
    console.error("[product-groups] insert failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  invalidateWbData("product-groups");
  return NextResponse.json({ ok: true, persisted: true, id: data.id });
}

const renameSchema = z.object({
  id: z.string().regex(UUID),
  name: z.string().trim().min(1).max(80),
});

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!can(session.role, "products:groups")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = renameSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ ok: true, persisted: false });

  const { data, error } = await admin
    .from("product_groups")
    .update({ name: parsed.data.name })
    .eq("id", parsed.data.id)
    .eq("org_id", DEMO_ORG_ID)
    .select("id");

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "duplicate_name" }, { status: 409 });
    }
    console.error("[product-groups] rename failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Имя группы вшито в список товаров (groupName) — сбрасываем и его
  invalidateWbData("product-groups", "products");
  return NextResponse.json({ ok: true, persisted: true });
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!can(session.role, "products:groups")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ ok: true, persisted: false });

  // FK products.group_id — on delete set null: товары остаются без группы
  const { data, error } = await admin
    .from("product_groups")
    .delete()
    .eq("id", id)
    .eq("org_id", DEMO_ORG_ID)
    .select("id");

  if (error) {
    console.error("[product-groups] delete failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  invalidateWbData("product-groups", "products");
  return NextResponse.json({ ok: true, persisted: true });
}
