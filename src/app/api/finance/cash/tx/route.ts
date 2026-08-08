import { NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { confirmWbPayoutReceived, createCashTx, deleteCashTx } from "@/backend/data/cash-core";
import { invalidateWbData, MONEY_SCOPES } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Операция кассы: расход / приход / перевод между счетами.
// Валюту и курс определяет сервер по счёту (см. cash-core) — клиент их не шлёт.
const txSchema = z.object({
  kind: z.enum(["in", "out", "transfer"]),
  accountId: z.string().regex(UUID),
  toAccountId: z.string().regex(UUID).nullable().optional(),
  categoryId: z.string().regex(UUID).nullable().optional(),
  amount: z.number().positive().max(1_000_000_000),
  amountTo: z.number().positive().max(1_000_000_000).nullable().optional(),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  rateToRub: z.number().positive().max(100_000).nullable().optional(),
  personId: z.string().regex(UUID).nullable().optional(), // кому платим (сотрудник)
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "finance:expense")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = txSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ ok: true, persisted: false });

  const result = await createCashTx(
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
    if (result.code === "db_error") console.error("[finance/cash/tx] insert failed:", result.message);
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

// Подтверждение поступления выплаты WB: деньги от маркетплейса доходят до
// счёта с задержкой, до подтверждения операция «в обработке» и не в остатках.
const confirmSchema = z.object({
  action: z.literal("confirm_received"),
  id: z.string().regex(UUID),
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!can(session.role, "finance:expense")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ ok: true, persisted: false });

  const result = await confirmWbPayoutReceived(
    admin,
    {
      id: UUID.test(session.user.id) ? session.user.id : "",
      name: session.user.name,
      role: session.role,
      roleLabel: session.roleLabel,
    },
    parsed.data.id,
    parsed.data.receivedOn ?? null,
  );
  if (!result.ok) {
    const status = result.code === "forbidden" ? 403 : result.code === "db_error" ? 500 : 400;
    return NextResponse.json({ error: result.code, message: result.message }, { status });
  }

  invalidateWbData(...MONEY_SCOPES);
  return NextResponse.json({ ok: true, persisted: true, message: result.message });
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!can(session.role, "finance:expense")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ ok: true, persisted: false });

  const result = await deleteCashTx(
    admin,
    {
      id: UUID.test(session.user.id) ? session.user.id : "",
      name: session.user.name,
      role: session.role,
      roleLabel: session.roleLabel,
    },
    id,
  );
  if (!result.ok) {
    const status = result.code === "forbidden" ? 403 : result.code === "db_error" ? 500 : 400;
    return NextResponse.json({ error: result.code, message: result.message }, { status });
  }

  invalidateWbData(...MONEY_SCOPES);
  return NextResponse.json({ ok: true, persisted: true });
}
