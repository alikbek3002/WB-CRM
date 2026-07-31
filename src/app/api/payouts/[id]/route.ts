import { NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { cancelPayout, decidePayout, payPayout } from "@/backend/data/payouts-core";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Решение по заявке: согласовать, отклонить, оплатить, отменить свою.
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), note: z.string().trim().max(1000).nullable().optional() }),
  z.object({ action: z.literal("reject"), note: z.string().trim().max(1000).nullable().optional() }),
  z.object({
    action: z.literal("pay"),
    accountId: z.string().regex(UUID),
    paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    rateToRub: z.number().positive().max(100_000).nullable().optional(),
  }),
  z.object({ action: z.literal("cancel") }),
]);

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!can(session.role, "payout:request")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await context.params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ ok: true, persisted: false });

  const actor = {
    id: UUID.test(session.user.id) ? session.user.id : "",
    name: session.user.name,
    role: session.role,
    roleLabel: session.roleLabel,
  };

  const input = parsed.data;
  const result =
    input.action === "pay"
      ? await payPayout(admin, actor, id, input.accountId, {
          paidOn: input.paidOn ?? null,
          rateToRub: input.rateToRub ?? null,
        })
      : input.action === "cancel"
        ? await cancelPayout(admin, actor, id)
        : await decidePayout(admin, actor, id, input.action, input.note ?? null);

  if (!result.ok) {
    const status =
      result.code === "forbidden"
        ? 403
        : result.code === "not_found"
          ? 404
          : result.code === "db_error"
            ? 500
            : 409;
    return NextResponse.json({ error: result.code, message: result.message }, { status });
  }

  invalidateWbData();
  return NextResponse.json({ ok: true, message: result.message });
}
