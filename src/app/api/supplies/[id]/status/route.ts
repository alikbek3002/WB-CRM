import { NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Смена стадии фул-фирмы: принят → разбор → лежит (КП 4.3). Роль supply:receive.
// «Распределён» выставляется только через /distribute (когда разложен весь объём).
const statusSchema = z.object({
  status: z.enum(["sorting", "in_stock"]),
});

// Допустимые переходы вперёд по стадиям фул-фирмы
const STAGE_ORDER: Record<string, number> = {
  received: 0,
  sorting: 1,
  in_stock: 2,
};

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!can(session.role, "supply:receive")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = statusSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin || !UUID.test(id)) {
    return NextResponse.json({ ok: true, persisted: false, status: parsed.data.status });
  }

  // Guard: стадии фул-фирмы доступны только принятой карточке и только вперёд
  const { data: supply, error: readErr } = await admin
    .from("supplies")
    .select("status")
    .eq("id", id)
    .single();
  if (readErr || !supply) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const cur = STAGE_ORDER[supply.status as string];
  const next = STAGE_ORDER[parsed.data.status];
  if (cur === undefined || next <= cur) {
    return NextResponse.json(
      { error: "invalid_transition", from: supply.status, to: parsed.data.status },
      { status: 409 },
    );
  }

  const { error } = await admin
    .from("supplies")
    .update({ status: parsed.data.status })
    .eq("id", id);
  if (error) {
    console.error("[supplies/status] update failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  invalidateWbData();
  return NextResponse.json({ ok: true, persisted: true });
}
