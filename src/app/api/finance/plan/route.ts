import { NextResponse } from "next/server";
import { z } from "zod";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "@/shared/constants";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// План продаж WB на период (полугодие). Сумму берут из кабинета WB.
const planSchema = z
  .object({
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amountRub: z.number().min(0).max(100_000_000_000),
  })
  .refine((v) => v.periodStart < v.periodEnd, {
    message: "period_start must be before period_end",
  });

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "finance:plan")) {
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
  if (!admin) {
    return NextResponse.json({ ok: true, persisted: false });
  }

  const { error } = await admin.from("sales_plans").upsert(
    {
      org_id: DEMO_ORG_ID,
      store_id: DEMO_STORE_ID,
      period_start: parsed.data.periodStart,
      period_end: parsed.data.periodEnd,
      amount_rub: parsed.data.amountRub,
      created_by: UUID.test(session.user.id) ? session.user.id : null,
    },
    { onConflict: "store_id,period_start" },
  );
  if (error) {
    console.error("[finance/plan] upsert failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  invalidateWbData();
  return NextResponse.json({ ok: true, persisted: true });
}
