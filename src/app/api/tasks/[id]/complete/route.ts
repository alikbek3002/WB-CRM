import { NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { completeTask, TASK_REPORT_MAX } from "@/backend/data/tasks-core";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

// Отчёт ОБЯЗАТЕЛЕН — правило клиента: нельзя закрыть задачу одной кнопкой.
const schema = z.object({
  report: z.string().trim().min(1, "Отчёт обязателен").max(TASK_REPORT_MAX),
});

// Закрытие задачи с отчётом о выполнении (страница «Задачи», Telegram-бот).
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
    return NextResponse.json(
      { error: "report_required", message: "Отчёт обязателен: напишите, что именно сделано." },
      { status: 400 },
    );
  }

  const result = await completeTask(admin, id, {
    id: session.user.id,
    name: session.user.name,
    role: session.role,
    roleLabel: session.roleLabel,
  }, parsed.data.report);

  if (!result.ok) {
    const status =
      result.code === "not_found" ? 404
      : result.code === "forbidden" ? 403
      : result.code === "conflict" ? 409
      : result.code === "report_required" ? 400
      : 500;
    return NextResponse.json({ error: result.code, message: result.message }, { status });
  }

  invalidateWbData();
  return NextResponse.json({ ok: true, onTime: result.onTime, message: result.message });
}
