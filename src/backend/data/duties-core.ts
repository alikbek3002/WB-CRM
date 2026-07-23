// Генерация регламентных задач дня — ЧИСТЫЙ модуль (supabase-js + относительные
// импорты): используется и веб-ридерами (supabase.ts), и Telegram-ботом/планировщиком.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_ORG_ID } from "../../shared/constants";

export function localIsoDate(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

type DutyTemplateRow = {
  id: string;
  role: string;
  assignee_user_id: string | null;
  frequency: "daily" | "weekly";
  weekday: number | null;
  due_time: string;
};

// Идемпотентно: создаёт недостающие назначения на сегодня (ignoreDuplicates),
// статусы не трогает; просроченные pending помечает missed.
export async function ensureDutyAssignments(db: SupabaseClient): Promise<void> {
  const today = new Date();
  const taskDate = localIsoDate(today);
  const weekday = ((today.getDay() + 6) % 7) + 1; // 1=пн … 7=вс

  const { data: templates, error } = await db
    .from("duty_templates")
    .select("id, role, assignee_user_id, frequency, weekday, due_time")
    .eq("org_id", DEMO_ORG_ID)
    .eq("active", true);
  if (error) throw error;

  const todays = ((templates ?? []) as DutyTemplateRow[]).filter(
    (t) => t.frequency === "daily" || Number(t.weekday) === weekday,
  );

  if (todays.length) {
    const roleNeeded = [...new Set(todays.filter((t) => !t.assignee_user_id).map((t) => t.role))];
    const membersByRole = new Map<string, string[]>();
    if (roleNeeded.length) {
      const { data: members, error: memErr } = await db
        .from("org_members")
        .select("user_id, role")
        .eq("org_id", DEMO_ORG_ID)
        .in("role", roleNeeded);
      if (memErr) throw memErr;
      for (const m of members ?? []) {
        const arr = membersByRole.get(m.role as string) ?? [];
        arr.push(m.user_id as string);
        membersByRole.set(m.role as string, arr);
      }
    }

    const rows: Record<string, unknown>[] = [];
    for (const t of todays) {
      const assignees = t.assignee_user_id
        ? [t.assignee_user_id]
        : (membersByRole.get(t.role) ?? []);
      const dueAt = new Date(`${taskDate}T${t.due_time}`).toISOString();
      for (const uid of assignees) {
        rows.push({
          org_id: DEMO_ORG_ID,
          template_id: t.id,
          assignee_id: uid,
          task_date: taskDate,
          due_at: dueAt,
        });
      }
    }
    if (rows.length) {
      const { error: insErr } = await db
        .from("duty_assignments")
        .upsert(rows, {
          onConflict: "template_id,assignee_id,task_date",
          ignoreDuplicates: true,
        });
      if (insErr) throw insErr;
    }
  }

  const { error: missErr } = await db
    .from("duty_assignments")
    .update({ status: "missed" })
    .eq("org_id", DEMO_ORG_ID)
    .eq("status", "pending")
    .lt("due_at", new Date().toISOString());
  if (missErr) throw missErr;
}
