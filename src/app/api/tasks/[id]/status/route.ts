import { NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { cancelTask, startTask } from "@/backend/data/tasks-core";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

// Переходы БЕЗ отчёта. Закрытие задачи сюда НЕ входит — только через
// /complete с обязательным отчётом (см. tasks-core.completeTask).
const schema = z.object({
  action: z.enum(["start", "cancel"]),
  reason: z.string().max(500).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!can(session.role, "tasks:view")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: "supabase_not_configured" }, { status: 503 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const actor = {
    id: session.user.id,
    name: session.user.name,
    role: session.role,
    roleLabel: session.roleLabel,
  };
  const result =
    parsed.data.action === "start"
      ? await startTask(admin, id, actor)
      : await cancelTask(admin, id, actor, parsed.data.reason);

  if (!result.ok) {
    const status =
      result.code === "not_found" ? 404
      : result.code === "forbidden" ? 403
      : result.code === "conflict" ? 409
      : 500;
    return NextResponse.json({ error: result.code, message: result.message }, { status });
  }

  invalidateWbData();
  return NextResponse.json({ ok: true, message: result.message });
}
