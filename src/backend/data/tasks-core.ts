// Жизненный цикл задачи — ЕДИНОЕ место правил для всех входов: веб (API-роуты),
// Telegram-бот (кнопки) и ИИ-ассистент (инструменты). Ключевое требование
// клиента: закрыть задачу без отчёта нельзя — сотрудник обязан написать, что
// реально сделано, и руководство это видит.
//
// Чистый модуль (npm + относительные импорты) — работает и в Turbopack, и в tsx.

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyProfile, notifyRoles, tgEsc } from "../telegram/notify";

export type TaskActor = {
  id: string;
  name: string;
  role: string;
  roleLabel: string;
};

export type TaskResult =
  | { ok: true; title: string; onTime: boolean | null; message: string }
  | { ok: false; code: "not_found" | "forbidden" | "conflict" | "report_required" | "db_error"; message: string };

const LEAD_ROLES = ["owner", "admin", "manager"];
const isLead = (role: string) => LEAD_ROLES.includes(role);

// Максимальная длина отчёта (защита от вставки простыни в текстовое поле)
export const TASK_REPORT_MAX = 2000;

type TaskRow = {
  id: string;
  title: string;
  status: string;
  assignee_id: string | null;
  due_date: string | null;
  org_id: string;
};

async function loadTask(db: SupabaseClient, taskId: string): Promise<TaskRow | null> {
  const { data, error } = await db
    .from("tasks")
    .select("id, title, status, assignee_id, due_date, org_id")
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as TaskRow) ?? null;
}

// Менять задачу может исполнитель либо руководитель (owner/admin/manager)
function mayChange(task: TaskRow, actor: TaskActor): boolean {
  return task.assignee_id === actor.id || isLead(actor.role);
}

// ── Взять в работу: open → in_progress ──────────────────────────────────────
export async function startTask(
  db: SupabaseClient,
  taskId: string,
  actor: TaskActor,
): Promise<TaskResult> {
  const task = await loadTask(db, taskId);
  if (!task) return { ok: false, code: "not_found", message: "Задача не найдена." };
  if (!mayChange(task, actor)) {
    return { ok: false, code: "forbidden", message: "Можно менять только свои задачи." };
  }
  if (task.status === "done") {
    return { ok: false, code: "conflict", message: "Задача уже закрыта." };
  }
  if (task.status === "in_progress") {
    return { ok: true, title: task.title, onTime: null, message: "Задача уже в работе." };
  }
  const { error } = await db
    .from("tasks")
    .update({ status: "in_progress", updated_at: new Date().toISOString() })
    .eq("id", taskId);
  if (error) return { ok: false, code: "db_error", message: error.message };
  return { ok: true, title: task.title, onTime: null, message: `«${task.title}» — взято в работу.` };
}

// ── Закрыть задачу: ОБЯЗАТЕЛЕН отчёт о выполнении ───────────────────────────
// Отчёт уходит руководству пушем — директор и старшие менеджеры видят,
// что именно сделал сотрудник, не заходя в систему.
export async function completeTask(
  db: SupabaseClient,
  taskId: string,
  actor: TaskActor,
  reportRaw: string,
): Promise<TaskResult> {
  const report = String(reportRaw ?? "").trim();
  if (!report) {
    return {
      ok: false,
      code: "report_required",
      message: "Отчёт обязателен: напишите, что именно сделано.",
    };
  }

  const task = await loadTask(db, taskId);
  if (!task) return { ok: false, code: "not_found", message: "Задача не найдена." };
  if (!mayChange(task, actor)) {
    return { ok: false, code: "forbidden", message: "Можно закрывать только свои задачи." };
  }
  if (task.status === "done") {
    return { ok: false, code: "conflict", message: "Задача уже закрыта." };
  }

  // Вовремя ли: по концу дня дедлайна (срока может не быть → null)
  const onTime = task.due_date
    ? Date.now() <= new Date(`${task.due_date}T23:59:59`).getTime()
    : null;

  const { error } = await db
    .from("tasks")
    .update({
      status: "done",
      completion_report: report.slice(0, TASK_REPORT_MAX),
      completed_at: new Date().toISOString(),
      completed_by: actor.id,
      completed_on_time: onTime,
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId);
  if (error) return { ok: false, code: "db_error", message: error.message };

  // Руководству — отчёт целиком (best effort, не роняет закрытие задачи)
  const lateMark = onTime === false ? " ⏰ <i>после срока</i>" : "";
  void notifyRoles(
    ["owner", "admin", "manager"],
    `✅ <b>Задача выполнена</b>${lateMark}\n` +
      `«${tgEsc(task.title)}»\n` +
      `Исполнитель: <b>${tgEsc(actor.name)}</b> (${tgEsc(actor.roleLabel)})\n\n` +
      `<b>Отчёт:</b>\n${tgEsc(report.slice(0, 1500))}`,
  );

  return {
    ok: true,
    title: task.title,
    onTime,
    message:
      onTime === false
        ? `«${task.title}» закрыта после срока, отчёт записан и отправлен руководству.`
        : `«${task.title}» закрыта, отчёт записан и отправлен руководству.`,
  };
}

// ── Отменить задачу (только руководители) ───────────────────────────────────
export async function cancelTask(
  db: SupabaseClient,
  taskId: string,
  actor: TaskActor,
  reason?: string,
): Promise<TaskResult> {
  if (!isLead(actor.role)) {
    return { ok: false, code: "forbidden", message: "Отменять задачи может только руководитель." };
  }
  const task = await loadTask(db, taskId);
  if (!task) return { ok: false, code: "not_found", message: "Задача не найдена." };
  if (task.status === "done") {
    return { ok: false, code: "conflict", message: "Закрытую задачу отменить нельзя." };
  }
  const { error } = await db
    .from("tasks")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", taskId);
  if (error) return { ok: false, code: "db_error", message: error.message };

  if (task.assignee_id && task.assignee_id !== actor.id) {
    void notifyProfile(
      task.assignee_id,
      `⚪️ <b>Задача отменена</b>\n«${tgEsc(task.title)}»\n` +
        `Отменил: ${tgEsc(actor.name)} (${tgEsc(actor.roleLabel)})` +
        (reason ? `\nПричина: ${tgEsc(reason)}` : ""),
    );
  }
  return { ok: true, title: task.title, onTime: null, message: `«${task.title}» отменена.` };
}
