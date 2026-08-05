import { NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { createExpenseCategory } from "@/backend/data/cash-core";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Своя статья расхода/прихода.
// inPnl = false — движение активов (закуп товара, перевод владельцу): такие
// суммы не уменьшают прибыль периода, они учитываются через себестоимость.
const categorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  direction: z.enum(["in", "out"]),
  inPnl: z.boolean().optional(),
  emoji: z.string().trim().max(8).nullable().optional(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "finance:expense")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = categorySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ ok: true, persisted: false });

  const result = await createExpenseCategory(
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

  invalidateWbData("finance-refs", "expenses");
  return NextResponse.json({ ok: true, persisted: true, id: result.id });
}
