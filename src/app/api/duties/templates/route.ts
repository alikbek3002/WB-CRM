import { NextResponse } from "next/server";
import { z } from "zod";
import { DEMO_ORG_ID } from "@/shared/constants";
import { canEditDutyTemplate } from "@/shared/duties";
import { can, isMemberRole } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Регламент компании (duty_templates): кто, что и к какому часу делает.
// Правят директор (кому угодно, включая себя) и старший менеджер (кому угодно,
// кроме СВОЕГО регламента) — правило в shared/duties.ts, общее с интерфейсом.
const baseSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  role: z.string().trim().min(1).max(40),
  assigneeUserId: z.string().nullable().optional(),
  frequency: z.enum(["daily", "weekly"]),
  weekday: z.number().int().min(1).max(7).nullable().optional(),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/),
  hoursToComplete: z.number().int().min(1).max(24),
  requiresReport: z.boolean(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const patchSchema = baseSchema.partial().extend({ id: z.string() });

// Стабильный ключ обязанности: сид ищет по нему свои строки, поэтому у ручных
// пунктов префикс custom- и суффикс от времени создания — чтобы не столкнуться.
function makeCode(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `custom-${slug || "duty"}-${Date.now().toString(36)}`;
}

// Расписание должно быть непротиворечивым: у еженедельной обязанности обязан
// быть день недели, у ежедневной его быть не должно (иначе наряды не создадутся
// либо создадутся не в тот день — ensureDutyAssignments сверяет weekday).
function normalizeSchedule(
  frequency: "daily" | "weekly" | undefined,
  weekday: number | null | undefined,
): { ok: true; weekday: number | null } | { ok: false } {
  if (frequency === "weekly") {
    return weekday ? { ok: true, weekday } : { ok: false };
  }
  if (frequency === "daily") return { ok: true, weekday: null };
  return { ok: true, weekday: weekday ?? null };
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "duty:manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = baseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (!isMemberRole(parsed.data.role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  const target = {
    assigneeUserId: parsed.data.assigneeUserId ?? null,
    role: parsed.data.role,
  };
  // Заводить обязанность себе старшему менеджеру тоже нельзя — иначе запрет на
  // правку своего регламента обходится созданием новой строки.
  if (!canEditDutyTemplate(target, { userId: session.user.id, role: session.role })) {
    return NextResponse.json({ error: "own_duty_forbidden" }, { status: 403 });
  }

  const schedule = normalizeSchedule(parsed.data.frequency, parsed.data.weekday);
  if (!schedule.ok) {
    return NextResponse.json({ error: "weekday_required" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ ok: true, persisted: false, template: parsed.data });
  }
  if (target.assigneeUserId && !UUID.test(target.assigneeUserId)) {
    return NextResponse.json({ error: "invalid_assignee" }, { status: 400 });
  }

  const { data, error } = await admin
    .from("duty_templates")
    .insert({
      org_id: DEMO_ORG_ID,
      code: makeCode(parsed.data.title),
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      role: parsed.data.role,
      assignee_user_id: target.assigneeUserId,
      frequency: parsed.data.frequency,
      weekday: schedule.weekday,
      due_time: `${parsed.data.dueTime}:00`,
      hours_to_complete: parsed.data.hoursToComplete,
      requires_report: parsed.data.requiresReport,
      active: parsed.data.active ?? true,
      sort_order: parsed.data.sortOrder ?? 100,
      updated_at: new Date().toISOString(),
      updated_by: session.user.id,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[duties/templates] insert failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  invalidateWbData("duty-templates", "duty-stats");
  return NextResponse.json({ ok: true, persisted: true, id: data.id });
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!can(session.role, "duty:manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success || !UUID.test(parsed.data.id)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  if (parsed.data.role !== undefined && !isMemberRole(parsed.data.role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ ok: true, persisted: false });

  const { data: current, error: readErr } = await admin
    .from("duty_templates")
    .select("role, assignee_user_id, frequency, weekday")
    .eq("id", parsed.data.id)
    .eq("org_id", DEMO_ORG_ID)
    .single();
  if (readErr || !current) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const me = { userId: session.user.id, role: session.role };
  const before = {
    assigneeUserId: (current.assignee_user_id as string) ?? null,
    role: String(current.role),
  };
  // Проверяем и то, что правим, и то, во что превращаем: иначе ст. менеджер
  // переписал бы чужую обязанность на себя и дальше правил бы её свободно.
  const after = {
    assigneeUserId:
      parsed.data.assigneeUserId !== undefined
        ? parsed.data.assigneeUserId
        : before.assigneeUserId,
    role: parsed.data.role ?? before.role,
  };
  if (!canEditDutyTemplate(before, me) || !canEditDutyTemplate(after, me)) {
    return NextResponse.json({ error: "own_duty_forbidden" }, { status: 403 });
  }

  const frequency = parsed.data.frequency ?? (current.frequency as "daily" | "weekly");
  const weekday =
    parsed.data.weekday !== undefined
      ? parsed.data.weekday
      : (current.weekday as number | null);
  const schedule = normalizeSchedule(frequency, weekday);
  if (!schedule.ok) {
    return NextResponse.json({ error: "weekday_required" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: session.user.id,
  };
  if (parsed.data.title !== undefined) patch.title = parsed.data.title;
  if (parsed.data.description !== undefined) patch.description = parsed.data.description;
  if (parsed.data.role !== undefined) patch.role = parsed.data.role;
  if (parsed.data.assigneeUserId !== undefined) {
    if (parsed.data.assigneeUserId && !UUID.test(parsed.data.assigneeUserId)) {
      return NextResponse.json({ error: "invalid_assignee" }, { status: 400 });
    }
    patch.assignee_user_id = parsed.data.assigneeUserId;
  }
  if (parsed.data.frequency !== undefined) patch.frequency = parsed.data.frequency;
  if (parsed.data.frequency !== undefined || parsed.data.weekday !== undefined) {
    patch.weekday = schedule.weekday;
  }
  if (parsed.data.dueTime !== undefined) patch.due_time = `${parsed.data.dueTime}:00`;
  if (parsed.data.hoursToComplete !== undefined) {
    patch.hours_to_complete = parsed.data.hoursToComplete;
  }
  if (parsed.data.requiresReport !== undefined) {
    patch.requires_report = parsed.data.requiresReport;
  }
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;
  if (parsed.data.sortOrder !== undefined) patch.sort_order = parsed.data.sortOrder;

  const { error } = await admin
    .from("duty_templates")
    .update(patch)
    .eq("id", parsed.data.id)
    .eq("org_id", DEMO_ORG_ID);
  if (error) {
    console.error("[duties/templates] update failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  invalidateWbData("duty-templates", "duty-stats");
  return NextResponse.json({ ok: true, persisted: true });
}
