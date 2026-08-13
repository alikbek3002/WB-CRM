import { NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { reconcileAccount } from "@/backend/data/cash-core";
import { invalidateWbData, MONEY_SCOPES } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Сверка остатка счёта: человек вписывает, сколько денег ФАКТИЧЕСКИ есть
// (выписка банка, пересчёт наличных), разницу система пишет корректирующей
// операцией. Это основной способ вносить деньги руками — суммы от WB больше
// не подставляются автоматически (миграция 0045).
const reconcileSchema = z.object({
  accountId: z.string().regex(UUID),
  // Ноль — законная сверка («денег на счёте нет»), минус — овердрафт/долг по карте
  actualBalance: z.number().min(-1_000_000_000).max(1_000_000_000_000),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "finance:expense")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = reconcileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ ok: true, persisted: false });

  const result = await reconcileAccount(
    admin,
    {
      id: UUID.test(session.user.id) ? session.user.id : "",
      name: session.user.name,
      role: session.role,
      roleLabel: session.roleLabel,
    },
    parsed.data,
  );
  if (!result.ok) {
    const status = result.code === "forbidden" ? 403 : result.code === "db_error" ? 500 : 400;
    if (result.code === "db_error") console.error("[finance/cash/reconcile] failed:", result.message);
    return NextResponse.json({ error: result.code, message: result.message }, { status });
  }

  invalidateWbData(...MONEY_SCOPES);
  return NextResponse.json({
    ok: true,
    persisted: true,
    id: result.id,
    amountRub: result.amountRub,
    message: result.message,
  });
}
