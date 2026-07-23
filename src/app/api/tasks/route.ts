import { NextResponse } from "next/server";
import { z } from "zod";
import { DEMO_ORG_ID } from "@/shared/constants";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { getTasks } from "@/backend/data";
import { invalidateWbData } from "@/backend/data/revalidate";
import { notifyProfile, tgEsc } from "@/backend/telegram/notify";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITY_RU: Record<string, string> = {
  low: "низкий",
  normal: "обычный",
  high: "высокий",
  urgent: "срочный",
};

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!can(session.role, "tasks:view")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // viewer видит только свои задачи (раздел 5.1) — в демо фильтруем по имени
  const tasks = await getTasks();
  const visible =
    session.role === "viewer"
      ? tasks.filter((t) => t.assignee === session.user.name)
      : tasks;
  return NextResponse.json({ tasks: visible });
}

const createSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  dueDate: z.string().date().nullable().optional(),
  assigneeId: z.string().regex(UUID).nullable().optional(),
});

// Создание задачи (модуль Задачи / Telegram-бот, разделы 11.5 и 10 плана).
export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "tasks:view")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    // Демо-режим без БД: подтверждаем приём, запись появится после Supabase
    return NextResponse.json({ ok: true, persisted: false, task: parsed.data });
  }

  // Назначать задачу ДРУГОМУ сотруднику могут только руководители
  const assigneeId = parsed.data.assigneeId ?? null;
  const isSelf = assigneeId !== null && assigneeId === session.user.id;
  const isLead = ["owner", "admin", "manager"].includes(session.role);
  if (assigneeId && !isSelf && !isLead) {
    return NextResponse.json({ error: "forbidden_assign" }, { status: 403 });
  }

  const { data, error } = await admin
    .from("tasks")
    .insert({
      org_id: DEMO_ORG_ID,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      priority: parsed.data.priority,
      due_date: parsed.data.dueDate ?? null,
      status: "open",
      assignee_id: assigneeId,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[tasks] insert failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  // Пуш исполнителю в Telegram: «вам пришла задача от …»
  if (assigneeId && !isSelf) {
    const due = parsed.data.dueDate ? `\nСрок: <b>${tgEsc(parsed.data.dueDate)}</b>` : "";
    void notifyProfile(
      assigneeId,
      `📬 <b>Вам новая задача</b> от ${tgEsc(session.user.name)} (${tgEsc(session.roleLabel)}):\n` +
        `«${tgEsc(parsed.data.title)}»\n` +
        `Приоритет: <b>${PRIORITY_RU[parsed.data.priority]}</b>${due}\n\n` +
        `Открыть: /menu → 🗒 Мои задачи`,
    );
  }

  invalidateWbData();
  return NextResponse.json({ ok: true, persisted: true, id: data.id });
}
