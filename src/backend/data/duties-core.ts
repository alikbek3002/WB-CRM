// Генерация регламентных задач дня — ЧИСТЫЙ модуль (supabase-js + относительные
// импорты): используется и веб-ридерами (supabase.ts), и Telegram-ботом/планировщиком.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_ORG_ID } from "../../shared/constants";
import type {
  DutyEmployeeStat,
  DutyStats,
  DutyStatsPeriod,
} from "../../shared/types";

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

// ─── Статистика дисциплины за период (веб /duties + инструмент ИИ) ───────────
// Только чтение (генерацию нарядов НЕ трогаем — вызывается и из-под
// unstable_cache, где запись недопустима). Своевременность считаем по факту
// completed_at <= due_at, а не по флагу отчёта: задача, закрытая без отчёта,
// раньше проходила как «вовремя».

type DutyStatRow = {
  id: string;
  assignee_id: string;
  task_date: string;
  due_at: string;
  status: "pending" | "done" | "missed";
  completed_at: string | null;
  template: { title: string } | { title: string }[] | null;
  assignee: { full_name: string | null } | { full_name: string | null }[] | null;
};

function shiftIso(base: string, days: number): string {
  const d = new Date(`${base}T12:00:00`); // полдень — без сдвига дня на границах TZ
  d.setDate(d.getDate() + days);
  return localIsoDate(d);
}

function aggregateDutyPeriod(
  rows: DutyStatRow[],
  days: 7 | 30,
  from: string,
): DutyStatsPeriod {
  type Acc = {
    name: string;
    total: number;
    done: number;
    missed: number;
    doneOnTime: number;
    byTemplate: Map<string, { missed: number; late: number }>;
  };
  const byEmployee = new Map<string, Acc>();

  for (const r of rows) {
    if (r.task_date < from) continue;
    // pending не оцениваем: сегодняшние — день не кончился, исторические —
    // ensureDutyAssignments пометит их missed после дедлайна
    if (r.status === "pending") continue;

    const assignee = Array.isArray(r.assignee) ? r.assignee[0] : r.assignee;
    const template = Array.isArray(r.template) ? r.template[0] : r.template;
    const acc = byEmployee.get(r.assignee_id) ?? {
      name: assignee?.full_name ?? "—",
      total: 0,
      done: 0,
      missed: 0,
      doneOnTime: 0,
      byTemplate: new Map<string, { missed: number; late: number }>(),
    };

    acc.total += 1;
    const title = template?.title ?? "Обязанность";
    const t = acc.byTemplate.get(title) ?? { missed: 0, late: 0 };
    if (r.status === "done") {
      acc.done += 1;
      // done без completed_at (легаси) консервативно считаем «не вовремя»
      const onTime = Boolean(
        r.completed_at && new Date(r.completed_at) <= new Date(r.due_at),
      );
      if (onTime) acc.doneOnTime += 1;
      else t.late += 1;
    } else {
      acc.missed += 1;
      t.missed += 1;
    }
    if (t.missed + t.late > 0) acc.byTemplate.set(title, t);
    byEmployee.set(r.assignee_id, acc);
  }

  const employees: DutyEmployeeStat[] = [...byEmployee.entries()]
    .filter(([, a]) => a.total > 0)
    .map(([assigneeId, a]) => {
      const completionPct = Math.round((a.done / a.total) * 100);
      const onTimePct = Math.round((a.doneOnTime / a.total) * 100);
      // Вовремя = 1 балл, с опозданием = 0.5, просрочено = 0
      const score = Math.round(0.5 * completionPct + 0.5 * onTimePct);
      return {
        assigneeId,
        assigneeName: a.name,
        total: a.total,
        done: a.done,
        missed: a.missed,
        doneOnTime: a.doneOnTime,
        completionPct,
        onTimePct,
        score,
        grade:
          score >= 80 ? ("good" as const) : score >= 50 ? ("ok" as const) : ("bad" as const),
        problems: [...a.byTemplate.entries()]
          .map(([title, v]) => ({ title, ...v }))
          .sort((x, y) => y.missed * 2 + y.late - (x.missed * 2 + x.late))
          .slice(0, 3),
      };
    })
    .sort((x, y) => y.score - x.score);

  const totals = employees.reduce(
    (s, e) => ({
      total: s.total + e.total,
      done: s.done + e.done,
      onTime: s.onTime + e.doneOnTime,
    }),
    { total: 0, done: 0, onTime: 0 },
  );

  return {
    days,
    from,
    employees,
    teamCompletionPct: totals.total ? Math.round((totals.done / totals.total) * 100) : 0,
    teamOnTimePct: totals.total ? Math.round((totals.onTime / totals.total) * 100) : 0,
  };
}

export async function getDutyStats(db: SupabaseClient): Promise<DutyStats> {
  const today = localIsoDate();
  const from30 = shiftIso(today, -29);
  const from7 = shiftIso(today, -6);

  // Батчи по 1000 — PostgREST молча режет выборку, а объём растёт с командой.
  // pending не тянем вовсе (агрегатор их пропускает) — заодно свежие вставки
  // ensureDutyAssignments (всегда pending) не сдвигают offset между страницами.
  // Сортировка ASC + дедуп по id страхуют от сдвигов при конкурентных апдейтах.
  const PAGE = 1000;
  const byId = new Map<string, DutyStatRow>();
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await db
      .from("duty_assignments")
      .select(
        "id, assignee_id, task_date, due_at, status, completed_at, template:duty_templates(title), assignee:profiles(full_name)",
      )
      .eq("org_id", DEMO_ORG_ID)
      .gte("task_date", from30)
      .neq("status", "pending")
      .order("task_date", { ascending: true })
      .order("id", { ascending: true })
      .range(start, start + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as DutyStatRow[];
    for (const r of page) byId.set(r.id, r);
    if (page.length < PAGE) break;
  }
  const rows = [...byId.values()];

  return {
    d7: aggregateDutyPeriod(rows, 7, from7),
    d30: aggregateDutyPeriod(rows, 30, from30),
  };
}
