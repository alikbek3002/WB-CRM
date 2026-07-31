import { NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { mirrorSupplyPaymentToCash } from "@/backend/data/cash-core";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Оплата по поставке (КП 4.2: финансисты — товар/карго, мультивалюта). Роль supply:pay.
const paymentSchema = z.object({
  kind: z.enum(["goods", "cargo"]),
  amount: z.number().min(0),
  currency: z.enum(["cny", "uzs", "rub"]),
  paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(500).nullable().optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!can(session.role, "supply:pay")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = paymentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin || !UUID.test(id)) {
    return NextResponse.json({ ok: true, persisted: false, payment: parsed.data });
  }

  const { data: payment, error } = await admin
    .from("supply_payments")
    .insert({
      supply_id: id,
      kind: parsed.data.kind,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      paid_at: parsed.data.paidAt,
      note: parsed.data.note ?? null,
    })
    .select("id, supply:supplies(title)")
    .single();

  if (error || !payment) {
    console.error("[supplies/payments] insert failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  // Деньги ушли со счёта — отражаем это в кассе (см. mirrorSupplyPaymentToCash)
  const supply = Array.isArray(payment.supply) ? payment.supply[0] : payment.supply;
  await mirrorSupplyPaymentToCash(
    admin,
    {
      id: session.user.id,
      name: session.user.name,
      role: session.role,
      roleLabel: session.roleLabel,
    },
    {
      id: String(payment.id),
      kind: parsed.data.kind,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      paidAt: parsed.data.paidAt,
      note: parsed.data.note ?? null,
      supplyTitle: (supply as { title?: string } | null)?.title ?? null,
    },
  );

  invalidateWbData();
  return NextResponse.json({ ok: true, persisted: true });
}
