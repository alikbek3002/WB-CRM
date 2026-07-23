import { NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Приёмка в Москве (КП 4.3: «Товар прибыл» + обязательный комментарий + факт. кол-во).
// Система считает время в пути. Роль supply:receive (приёмщик).
const receiveSchema = z.object({
  receivedQty: z.number().int().min(0),
  receiptComment: z.string().trim().min(1).max(500),
});

// Локальная разница в днях между 'yyyy-mm-dd' и сегодня (пояс UTC+5/6)
function daysSince(shipDate: string): number {
  const [y, m, d] = shipDate.slice(0, 10).split("-").map(Number);
  const from = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((today.getTime() - from.getTime()) / 86_400_000));
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!can(session.role, "supply:receive")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = receiveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin || !UUID.test(id)) {
    return NextResponse.json({ ok: true, persisted: false, receipt: parsed.data });
  }

  // Читаем дату отгрузки (для времени в пути) и статус (guard повторной приёмки)
  const { data: supply, error: readErr } = await admin
    .from("supplies")
    .select("ship_date, status")
    .eq("id", id)
    .single();
  if (readErr || !supply) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Принимать можно только карточку в пути/приехавшую — повторная приёмка
  // откатила бы стадию фул-фирмы и испортила transit_days
  if (supply.status !== "in_transit" && supply.status !== "arrived") {
    return NextResponse.json({ error: "already_received" }, { status: 409 });
  }

  const now = new Date();
  const { error } = await admin
    .from("supplies")
    .update({
      status: "received",
      received_at: now.toISOString(),
      received_qty: parsed.data.receivedQty,
      receipt_comment: parsed.data.receiptComment,
      transit_days: daysSince(supply.ship_date as string),
    })
    .eq("id", id);

  if (error) {
    console.error("[supplies/receive] update failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  invalidateWbData();
  return NextResponse.json({ ok: true, persisted: true });
}
