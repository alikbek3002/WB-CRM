import { NextResponse } from "next/server";
import { z } from "zod";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Выполнение регламентной задачи + отчёт. on_time фиксируется по дедлайну.
const completeSchema = z.object({
  report: z.string().trim().max(4000).optional().default(""),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!can(session.role, "duty:complete")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = completeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin || !UUID.test(id)) {
    return NextResponse.json({ ok: true, persisted: false });
  }

  const { data: assignment, error: readErr } = await admin
    .from("duty_assignments")
    .select("id, org_id, assignee_id, due_at, status, template:duty_templates(requires_report, title)")
    .eq("id", id)
    .single();
  if (readErr || !assignment) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (assignment.status === "done") {
    return NextResponse.json({ error: "already_done" }, { status: 409 });
  }

  const template = assignment.template as unknown as {
    requires_report: boolean;
    title: string;
  } | null;
  const report = parsed.data.report;
  if (template?.requires_report && !report) {
    return NextResponse.json({ error: "report_required" }, { status: 400 });
  }

  const now = new Date();
  const onTime = now.getTime() <= new Date(assignment.due_at as string).getTime();

  if (report) {
    // Автор отчёта — кто сдал (сессия); в демо-режиме ролей это может быть
    // руководитель, закрывающий задачу за исполнителя
    const authorId = UUID.test(session.user.id)
      ? session.user.id
      : (assignment.assignee_id as string);
    const { error: repErr } = await admin.from("duty_reports").upsert(
      {
        org_id: assignment.org_id,
        assignment_id: id,
        user_id: authorId,
        content: report,
        on_time: onTime,
      },
      { onConflict: "assignment_id" },
    );
    if (repErr) {
      console.error("[duties/complete] report insert failed:", repErr);
      return NextResponse.json({ error: "db_error" }, { status: 500 });
    }
  }

  const { error: updErr } = await admin
    .from("duty_assignments")
    .update({ status: "done", completed_at: now.toISOString() })
    .eq("id", id);
  if (updErr) {
    console.error("[duties/complete] status update failed:", updErr);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  // Иначе статистика дисциплины (кэш duty-stats) отстаёт до 5 минут
  invalidateWbData();
  return NextResponse.json({ ok: true, persisted: true, onTime });
}
