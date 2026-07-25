// Инструменты ИИ-ассистента: реальные ДЕЙСТВИЯ в системе по команде из чата.
// Права проверяются здесь же (не доверяем модели). Чистый модуль.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "../../shared/constants";
import { can, type MemberRole } from "../../shared/rbac";
import { localIsoDate } from "../data/duties-core";
import { cancelTask, completeTask, type TaskActor } from "../data/tasks-core";
import { notifyProfile, tgEsc } from "../telegram/notify";
import type { SnapshotUser } from "./snapshot";

// ── Описания инструментов для Claude (какие доступны — зависит от роли) ──

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export function toolsForRole(role: MemberRole): ToolDef[] {
  const tools: ToolDef[] = [];
  if (["owner", "admin", "manager"].includes(role)) {
    tools.push({
      name: "create_task",
      description:
        "Создать задачу сотруднику. Используй, когда пользователь просит поставить/назначить задачу кому-то из команды. Сотруднику придёт уведомление в Telegram.",
      input_schema: {
        type: "object",
        properties: {
          assignee: { type: "string", description: "Имя или логин сотрудника (например «Алия» или aliya)" },
          title: { type: "string", description: "Формулировка задачи" },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"], description: "Приоритет (по умолчанию normal)" },
          due_date: { type: "string", description: "Срок yyyy-mm-dd (необязательно)" },
        },
        required: ["assignee", "title"],
      },
    });
  }
  if (["owner", "admin", "manager"].includes(role)) {
    tools.push({
      name: "cancel_task",
      description:
        "Отменить (убрать) задачу. Используй, когда просят снять/удалить/отменить задачу. Задачу ищем по части названия.",
      input_schema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Часть названия задачи" },
          reason: { type: "string", description: "Причина отмены (необязательно)" },
        },
        required: ["task"],
      },
    });
    tools.push({
      name: "team_report",
      description:
        "Отчёт руководителю по команде: кто что сделал (отчёты по закрытым задачам), у кого что в работе и просрочено, дисциплина по регламенту за сегодня. Используй на вопросы «что сделала команда», «кто чем занят», «покажи отчёты».",
      input_schema: {
        type: "object",
        properties: {
          days: { type: "number", description: "За сколько последних дней брать закрытые задачи (по умолчанию 1 — сегодня)" },
          person: { type: "string", description: "Имя сотрудника, если интересует кто-то один (необязательно)" },
        },
        required: [],
      },
    });
  }

  if (can(role, "tasks:view")) {
    tools.push({
      name: "my_tasks",
      description:
        "Показать текущие задачи сотрудника (открытые и в работе). Используй на «какие у меня задачи», «что мне сегодня делать».",
      input_schema: { type: "object", properties: {}, required: [] },
    });
    tools.push({
      name: "complete_task",
      description:
        "Закрыть задачу с отчётом о выполнении. ОТЧЁТ ОБЯЗАТЕЛЕН — это текст о том, что реально сделано. Если сотрудник просит закрыть задачу, но не рассказал, ЧТО сделано, — сначала спроси у него отчёт и только потом вызывай инструмент. Задачу ищем по части названия.",
      input_schema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Часть названия задачи (например «фото карточки»)" },
          report: { type: "string", description: "Отчёт: что именно сделано, цифры, что осталось" },
        },
        required: ["task", "report"],
      },
    });
  }

  if (can(role, "duty:complete")) {
    tools.push({
      name: "complete_my_duty",
      description:
        "Закрыть СВОЮ задачу регламента на сегодня с текстом отчёта. Используй, когда пользователь говорит «отметь выполненной мою задачу … отчёт: …».",
      input_schema: {
        type: "object",
        properties: {
          duty: { type: "string", description: "Часть названия задачи (например «отзывы» или «КИЗы»)" },
          report: { type: "string", description: "Текст отчёта о выполнении" },
        },
        required: ["duty", "report"],
      },
    });
  }
  if (can(role, "products:view")) {
    tools.push({
      name: "product_info",
      description:
        "Найти товар по названию и получить его цифры: продажи за 30 дней, остаток, топ-склады. Используй для вопросов про конкретный товар, которого нет в сводке.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Часть названия товара (например «пижама с длинным рукавом»)" },
        },
        required: ["query"],
      },
    });
  }
  return tools;
}

// ── Исполнение (сервер, с проверкой прав) ──

async function execCreateTask(
  db: SupabaseClient,
  user: SnapshotUser,
  input: { assignee?: string; title?: string; priority?: string; due_date?: string },
): Promise<string> {
  if (!["owner", "admin", "manager"].includes(user.role)) {
    return "Ошибка: у вас нет права назначать задачи.";
  }
  const q = String(input.assignee ?? "").trim();
  const title = String(input.title ?? "").trim();
  if (!q || !title) return "Ошибка: нужны имя сотрудника и текст задачи.";

  const safe = q.replace(/[\\%_]/g, (m) => "\\" + m);
  const { data: candidates } = await db
    .from("profiles")
    .select("id, full_name, login")
    .or(`full_name.ilike.%${safe}%,login.ilike.${safe}`)
    .limit(5);
  if (!candidates?.length) return `Сотрудник «${q}» не найден. Уточните имя или логин.`;
  if (candidates.length > 1) {
    return `Нашлось несколько: ${candidates.map((c) => c.full_name).join(", ")}. Уточните, кому именно.`;
  }
  const assignee = candidates[0];

  const priority = ["low", "normal", "high", "urgent"].includes(String(input.priority))
    ? String(input.priority)
    : "normal";
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(input.due_date ?? "")) ? String(input.due_date) : null;

  const { data, error } = await db
    .from("tasks")
    .insert({
      org_id: DEMO_ORG_ID,
      title,
      priority,
      due_date: due,
      status: "open",
      assignee_id: assignee.id,
    })
    .select("id")
    .single();
  if (error || !data) return `Не удалось создать задачу: ${error?.message ?? "ошибка БД"}`;

  void notifyProfile(
    String(assignee.id),
    `📬 <b>Вам новая задача</b> от ${tgEsc(user.name)} (${tgEsc(user.roleLabel)}):\n«${tgEsc(title)}»\nПриоритет: <b>${priority}</b>${due ? `\nСрок: <b>${due}</b>` : ""}\n\nОткрыть: /menu → 🗒 Мои задачи`,
  );
  return `Задача создана и назначена: ${assignee.full_name}. Уведомление в Telegram отправлено (если привязан).`;
}

// ── Задачи: поиск по части названия среди доступных сотруднику ──────────────

type TaskRow = {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  assignee_id: string | null;
  assignee: { full_name: string | null } | { full_name: string | null }[] | null;
};

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

const actorOf = (user: SnapshotUser): TaskActor => ({
  id: user.id,
  name: user.name,
  role: user.role,
  roleLabel: user.roleLabel,
});

// Активные задачи: свои — всем, чужие — только руководителям
async function findActiveTasks(
  db: SupabaseClient,
  user: SnapshotUser,
  query: string,
): Promise<TaskRow[]> {
  let q = db
    .from("tasks")
    .select("id, title, status, due_date, assignee_id, assignee:profiles!tasks_assignee_id_fkey(full_name)")
    .eq("org_id", DEMO_ORG_ID)
    .in("status", ["open", "in_progress"])
    .limit(50);
  if (!["owner", "admin", "manager"].includes(user.role)) q = q.eq("assignee_id", user.id);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as TaskRow[];
  const norm = query.trim().toLowerCase();
  return norm ? rows.filter((r) => r.title.toLowerCase().includes(norm)) : rows;
}

async function execMyTasks(db: SupabaseClient, user: SnapshotUser): Promise<string> {
  if (!can(user.role, "tasks:view")) return "Ошибка: нет доступа к задачам.";
  const { data, error } = await db
    .from("tasks")
    .select("title, status, priority, due_date")
    .eq("org_id", DEMO_ORG_ID)
    .eq("assignee_id", user.id)
    .in("status", ["open", "in_progress"])
    .order("due_date", { nullsFirst: false })
    .limit(30);
  if (error) return `Не удалось получить задачи: ${error.message}`;
  const rows = data ?? [];
  if (!rows.length) return "Открытых задач нет.";
  return rows
    .map(
      (t) =>
        `• ${t.title} — ${t.status === "in_progress" ? "в работе" : "открыта"}` +
        `, приоритет ${t.priority}` +
        (t.due_date ? `, срок ${t.due_date}` : ""),
    )
    .join("\n");
}

async function execCompleteTask(
  db: SupabaseClient,
  user: SnapshotUser,
  input: { task?: string; report?: string },
): Promise<string> {
  if (!can(user.role, "tasks:view")) return "Ошибка: нет доступа к задачам.";
  const q = String(input.task ?? "").trim();
  const report = String(input.report ?? "").trim();
  if (!q) return "Ошибка: укажите, какую задачу закрыть.";
  // Правило системы: без отчёта задача не закрывается ни через одну точку входа
  if (!report) {
    return "Отчёт обязателен. Спроси у сотрудника, ЧТО именно сделано, и повтори вызов с текстом отчёта.";
  }

  const matches = await findActiveTasks(db, user, q);
  if (!matches.length) return `Активная задача «${q}» не найдена.`;
  if (matches.length > 1) {
    return `Нашлось несколько задач: ${matches.map((m) => `«${m.title}»`).join(", ")}. Уточни, какую именно закрыть.`;
  }
  const result = await completeTask(db, matches[0].id, actorOf(user), report);
  return result.message;
}

async function execCancelTask(
  db: SupabaseClient,
  user: SnapshotUser,
  input: { task?: string; reason?: string },
): Promise<string> {
  if (!["owner", "admin", "manager"].includes(user.role)) {
    return "Ошибка: отменять задачи может только руководитель.";
  }
  const q = String(input.task ?? "").trim();
  if (!q) return "Ошибка: укажите, какую задачу отменить.";
  const matches = await findActiveTasks(db, user, q);
  if (!matches.length) return `Активная задача «${q}» не найдена.`;
  if (matches.length > 1) {
    return `Нашлось несколько задач: ${matches.map((m) => `«${m.title}»`).join(", ")}. Уточни, какую отменить.`;
  }
  const result = await cancelTask(db, matches[0].id, actorOf(user), input.reason?.trim());
  return result.message;
}

// ── Отчёт руководителю: что команда сделала / что висит / дисциплина ────────
async function execTeamReport(
  db: SupabaseClient,
  user: SnapshotUser,
  input: { days?: number; person?: string },
): Promise<string> {
  if (!["owner", "admin", "manager"].includes(user.role)) {
    return "Ошибка: сводка по команде доступна только руководителю.";
  }
  const days = Math.min(30, Math.max(1, Math.round(Number(input.days) || 1)));
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  const person = String(input.person ?? "").trim().toLowerCase();
  const matchPerson = (name: string | null | undefined) =>
    !person || (name ?? "").toLowerCase().includes(person);

  const [doneRes, activeRes, dutyRes] = await Promise.all([
    db
      .from("tasks")
      .select("title, completion_report, completed_at, completed_on_time, assignee:profiles!tasks_assignee_id_fkey(full_name)")
      .eq("org_id", DEMO_ORG_ID)
      .eq("status", "done")
      .gte("completed_at", since.toISOString())
      .order("completed_at", { ascending: false })
      .limit(50),
    db
      .from("tasks")
      .select("title, status, due_date, assignee:profiles!tasks_assignee_id_fkey(full_name)")
      .eq("org_id", DEMO_ORG_ID)
      .in("status", ["open", "in_progress"])
      .limit(50),
    db
      .from("duty_assignments")
      .select("status, assignee:profiles(full_name), template:duty_templates(title)")
      .eq("org_id", DEMO_ORG_ID)
      .eq("task_date", localIsoDate())
      .limit(100),
  ]);

  const lines: string[] = [];

  type DoneRow = { title: string; completion_report: string | null; completed_on_time: boolean | null; assignee: { full_name: string | null } | { full_name: string | null }[] | null };
  const done = ((doneRes.data ?? []) as unknown as DoneRow[]).filter((r) =>
    matchPerson(one(r.assignee)?.full_name),
  );
  lines.push(`ВЫПОЛНЕНО ЗАДАЧ за ${days === 1 ? "сегодня" : `${days} дн.`}: ${done.length}`);
  for (const r of done.slice(0, 15)) {
    lines.push(
      `• ${one(r.assignee)?.full_name ?? "—"}: «${r.title}»${r.completed_on_time === false ? " (после срока)" : ""}` +
        `\n  отчёт: ${(r.completion_report ?? "—").slice(0, 300)}`,
    );
  }

  type ActiveRow = { title: string; status: string; due_date: string | null; assignee: { full_name: string | null } | { full_name: string | null }[] | null };
  const active = ((activeRes.data ?? []) as unknown as ActiveRow[]).filter((r) =>
    matchPerson(one(r.assignee)?.full_name),
  );
  const today = localIsoDate();
  const overdue = active.filter((r) => r.due_date && r.due_date < today);
  lines.push("", `В РАБОТЕ/ОТКРЫТО: ${active.length}, из них просрочено: ${overdue.length}`);
  for (const r of overdue.slice(0, 10)) {
    lines.push(`• ПРОСРОЧЕНО — ${one(r.assignee)?.full_name ?? "—"}: «${r.title}» (срок ${r.due_date})`);
  }

  type DutyRow = { status: string; assignee: { full_name: string | null } | { full_name: string | null }[] | null; template: { title: string } | { title: string }[] | null };
  const duties = ((dutyRes.data ?? []) as unknown as DutyRow[]).filter((r) =>
    matchPerson(one(r.assignee)?.full_name),
  );
  const dutyDone = duties.filter((d) => d.status === "done").length;
  const dutyOpen = duties.filter((d) => d.status !== "done");
  lines.push("", `РЕГЛАМЕНТ СЕГОДНЯ: всего ${duties.length}, выполнено ${dutyDone}, не закрыто ${dutyOpen.length}`);
  for (const d of dutyOpen.slice(0, 10)) {
    lines.push(`• не закрыто — ${one(d.assignee)?.full_name ?? "—"}: ${one(d.template)?.title ?? "задача"}`);
  }

  return lines.join("\n");
}

async function execCompleteMyDuty(
  db: SupabaseClient,
  user: SnapshotUser,
  input: { duty?: string; report?: string },
): Promise<string> {
  if (!can(user.role, "duty:complete")) return "Ошибка: нет права закрывать задачи регламента.";
  const q = String(input.duty ?? "").trim();
  const report = String(input.report ?? "").trim();
  if (!q || !report) return "Ошибка: нужны название задачи и текст отчёта.";

  const { data } = await db
    .from("duty_assignments")
    .select("id, status, due_at, org_id, template:duty_templates(title)")
    .eq("assignee_id", user.id)
    .eq("task_date", localIsoDate())
    .limit(30);
  const rows = (data ?? []) as unknown as {
    id: string;
    status: string;
    due_at: string;
    org_id: string;
    template: { title: string } | { title: string }[] | null;
  }[];
  const norm = (s: string) => s.toLowerCase();
  const match = rows.find((r) => {
    const t = Array.isArray(r.template) ? r.template[0] : r.template;
    return norm(t?.title ?? "").includes(norm(q));
  });
  if (!match) {
    const titles = rows.map((r) => (Array.isArray(r.template) ? r.template[0] : r.template)?.title).filter(Boolean);
    return `Задача «${q}» на сегодня не найдена. Ваши задачи: ${titles.join("; ") || "нет"}.`;
  }
  if (match.status === "done") return "Эта задача уже закрыта.";

  const onTime = Date.now() <= new Date(match.due_at).getTime();
  await db.from("duty_reports").upsert(
    { org_id: match.org_id, assignment_id: match.id, user_id: user.id, content: report, on_time: onTime },
    { onConflict: "assignment_id" },
  );
  await db
    .from("duty_assignments")
    .update({ status: "done", completed_at: new Date().toISOString() })
    .eq("id", match.id);
  const t = Array.isArray(match.template) ? match.template[0] : match.template;
  return `Задача «${t?.title}» закрыта ${onTime ? "вовремя" : "после дедлайна"}, отчёт записан.`;
}

async function execProductInfo(
  db: SupabaseClient,
  user: SnapshotUser,
  input: { query?: string },
): Promise<string> {
  if (!can(user.role, "products:view")) return "Ошибка: нет доступа к товарам.";
  const q = String(input.query ?? "").trim();
  if (!q) return "Ошибка: укажите название товара.";
  const safe = q.replace(/[\\%_]/g, (m) => "\\" + m);

  const { data: prods } = await db
    .from("products")
    .select("id, nm_id, title, price_discounted_wb")
    .eq("store_id", DEMO_STORE_ID)
    .ilike("title", `%${safe}%`)
    .limit(3);
  if (!prods?.length) return `Товар «${q}» не найден в каталоге.`;

  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 29);
  const { data: salesAgg } = await db.rpc("agg_sales_by_nm", {
    p_store: DEMO_STORE_ID,
    p_since: since.toISOString(),
  });
  const salesByNm = new Map(
    ((salesAgg ?? []) as { nm_id: number; cnt: number }[]).map((r) => [Number(r.nm_id), Number(r.cnt)]),
  );

  const parts: string[] = [];
  for (const p of prods) {
    const { data: latest } = await db
      .from("stock_snapshots")
      .select("snapshot_date")
      .eq("product_id", p.id)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    let stockLine = "остатков нет";
    if (latest) {
      const { data: st } = await db
        .from("stock_snapshots")
        .select("warehouse, on_stock")
        .eq("product_id", p.id)
        .eq("snapshot_date", latest.snapshot_date as string)
        .limit(500);
      const byWh = new Map<string, number>();
      for (const s of st ?? []) {
        if (s.warehouse === "В пути (WB)") continue;
        byWh.set(s.warehouse as string, (byWh.get(s.warehouse as string) ?? 0) + Number(s.on_stock));
      }
      const total = [...byWh.values()].reduce((t, v) => t + v, 0);
      const top = [...byWh.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      stockLine = `остаток ${total} шт (топ: ${top.map(([w, v]) => `${w} ${v}`).join(", ")})`;
    }
    const sales30 = salesByNm.get(Number(p.nm_id)) ?? 0;
    const avg = sales30 / 30;
    parts.push(
      `${p.title} (арт. ${p.nm_id}): продажи 30д — ${sales30} шт (~${avg.toFixed(1)}/день), ${stockLine}` +
        (p.price_discounted_wb != null ? `, цена ${Math.round(Number(p.price_discounted_wb))} ₽` : ""),
    );
  }
  return parts.join("\n");
}

// Диспетчер: имя инструмента → исполнение. Возвращает текст для tool_result.
export async function executeTool(
  db: SupabaseClient,
  user: SnapshotUser,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    if (name === "create_task") return await execCreateTask(db, user, input);
    if (name === "my_tasks") return await execMyTasks(db, user);
    if (name === "complete_task") return await execCompleteTask(db, user, input);
    if (name === "cancel_task") return await execCancelTask(db, user, input);
    if (name === "team_report") return await execTeamReport(db, user, input);
    if (name === "complete_my_duty") return await execCompleteMyDuty(db, user, input);
    if (name === "product_info") return await execProductInfo(db, user, input);
    return `Неизвестный инструмент: ${name}`;
  } catch (e) {
    console.error(`[ai/tools] ${name}:`, e);
    return "Ошибка выполнения действия, попробуйте ещё раз.";
  }
}
