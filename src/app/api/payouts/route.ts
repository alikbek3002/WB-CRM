import { NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { createPayoutRequest } from "@/backend/data/payouts-core";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Заявка на выплату: зарплата, подрядчик, счёт фабрики, возмещение.
const payoutSchema = z.object({
  kind: z.enum(["salary", "contractor", "factory", "reimbursement", "other"]),
  title: z.string().trim().min(1).max(140),
  amount: z.number().positive().max(1_000_000_000),
  currency: z.enum(["rub", "cny", "uzs", "kgs"]).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  payee: z.string().trim().max(120).nullable().optional(),
  payeeUserId: z.string().regex(UUID).nullable().optional(), // адресат из команды
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  categoryId: z.string().regex(UUID).nullable().optional(),
  factoryId: z.string().regex(UUID).nullable().optional(),
  supplyId: z.string().regex(UUID).nullable().optional(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "payout:request")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = payoutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ ok: true, persisted: false });

  // Заявка привязана к профилю: без реального пользователя её некому платить
  if (!UUID.test(session.user.id)) {
    return NextResponse.json(
      { error: "forbidden", message: "Войдите под своим аккаунтом, чтобы запросить выплату." },
      { status: 403 },
    );
  }

  const result = await createPayoutRequest(
    admin,
    {
      id: session.user.id,
      name: session.user.name,
      role: session.role,
      roleLabel: session.roleLabel,
    },
    parsed.data,
  );
  if (!result.ok) {
    const status = result.code === "forbidden" ? 403 : result.code === "db_error" ? 500 : 400;
    return NextResponse.json({ error: result.code, message: result.message }, { status });
  }

  invalidateWbData();
  return NextResponse.json({ ok: true, id: result.id, message: result.message });
}
