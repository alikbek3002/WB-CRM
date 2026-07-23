import { NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Распределение по складам Wildberries (КП 4.4). Роль supply:receive.
const distSchema = z.object({
  warehouse: z.string().trim().min(1).max(120),
  quantity: z.number().int().min(1),
});

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
  const parsed = distSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin || !UUID.test(id)) {
    return NextResponse.json({ ok: true, persisted: false, distribution: parsed.data });
  }

  // Распределять можно только принятый товар и не больше остатка приёмки
  const { data: supply, error: readErr } = await admin
    .from("supplies")
    .select("status, quantity, received_qty")
    .eq("id", id)
    .single();
  if (readErr || !supply) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (supply.received_qty == null) {
    return NextResponse.json({ error: "not_received_yet" }, { status: 409 });
  }

  const { data: existing, error: distErr } = await admin
    .from("wb_distributions")
    .select("quantity")
    .eq("supply_id", id);
  if (distErr) {
    console.error("[supplies/distribute] read failed:", distErr);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
  const already = (existing ?? []).reduce((t, d) => t + Number(d.quantity ?? 0), 0);
  const remaining = Number(supply.received_qty) - already;
  if (parsed.data.quantity > remaining) {
    return NextResponse.json(
      { error: "exceeds_remaining", remaining },
      { status: 400 },
    );
  }

  const { error } = await admin.from("wb_distributions").insert({
    supply_id: id,
    warehouse: parsed.data.warehouse,
    quantity: parsed.data.quantity,
  });
  if (error) {
    console.error("[supplies/distribute] insert failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  // «Распределён по WB» — только когда разложен весь принятый объём;
  // частичное распределение стадию не меняет
  const distributedNow = already + parsed.data.quantity;
  if (distributedNow >= Number(supply.received_qty)) {
    const { error: statusErr } = await admin
      .from("supplies")
      .update({ status: "distributed" })
      .eq("id", id);
    if (statusErr) {
      console.error("[supplies/distribute] status update failed:", statusErr);
    }
  }

  invalidateWbData();
  return NextResponse.json({
    ok: true,
    persisted: true,
    remaining: Number(supply.received_qty) - distributedNow,
  });
}
