import { NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { createCashAccount } from "@/backend/data/cash-core";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Счёт компании: наличные, расчётный счёт, карта, кошелёк в юанях…
const accountSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["cash", "bank", "card", "wb", "other"]),
  currency: z.enum(["rub", "cny", "uzs"]),
  openingBalance: z.number().min(-1_000_000_000).max(1_000_000_000).optional(),
});

// Правка счёта: переименовать, поправить стартовый остаток, убрать в архив
const patchSchema = z.object({
  id: z.string().regex(UUID),
  name: z.string().trim().min(1).max(80).optional(),
  openingBalance: z.number().min(-1_000_000_000).max(1_000_000_000).optional(),
  archived: z.boolean().optional(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "finance:expense")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = accountSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ ok: true, persisted: false });

  const result = await createCashAccount(
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
    return NextResponse.json({ error: result.code, message: result.message }, { status });
  }

  invalidateWbData("cash", "finance-refs");
  return NextResponse.json({ ok: true, persisted: true, id: result.id });
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!can(session.role, "finance:expense")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ ok: true, persisted: false });

  const patch: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.openingBalance !== undefined) patch.opening_balance = parsed.data.openingBalance;
  if (parsed.data.archived !== undefined) patch.archived = parsed.data.archived;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const { error } = await admin.from("cash_accounts").update(patch).eq("id", parsed.data.id);
  if (error) {
    console.error("[finance/cash/accounts] update failed:", error);
    return NextResponse.json({ error: "db_error", message: error.message }, { status: 500 });
  }

  invalidateWbData("cash", "finance-refs");
  return NextResponse.json({ ok: true, persisted: true });
}
