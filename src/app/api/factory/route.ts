import { NextResponse } from "next/server";
import { z } from "zod";
import { DEMO_ORG_ID } from "@/shared/constants";
import { CURRENCY_CODES } from "@/shared/currency";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

// Создание фабрики (КП: закупщик выбирает страну Китай/Узбекистан). Роль factory:edit.
// currency — в чём фабрика выставляет счёт: её подставит карточка поставки в
// отшив и карго. Раньше валюту угадывали по стране, и китайская фабрика со
// счётами в долларах заводилась «в юанях».
const factorySchema = z.object({
  name: z.string().trim().min(1).max(200),
  country: z.enum(["china", "uzbekistan"]),
  currency: z.enum(CURRENCY_CODES).optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "factory:edit")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = factorySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ ok: true, persisted: false, factory: parsed.data });
  }

  const { data, error } = await admin
    .from("factories")
    .insert({
      org_id: DEMO_ORG_ID,
      name: parsed.data.name,
      country: parsed.data.country,
      currency:
        parsed.data.currency ?? (parsed.data.country === "uzbekistan" ? "uzs" : "cny"),
      note: parsed.data.note ?? null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[factory] insert failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  invalidateWbData("factories");
  return NextResponse.json({ ok: true, persisted: true, id: data.id });
}
