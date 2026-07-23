// Инструменты ИИ-ассистента: реальные ДЕЙСТВИЯ в системе по команде из чата.
// Права проверяются здесь же (не доверяем модели). Чистый модуль.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "../../shared/constants";
import { can, type MemberRole } from "../../shared/rbac";
import { localIsoDate } from "../data/duties-core";
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
    if (name === "complete_my_duty") return await execCompleteMyDuty(db, user, input);
    if (name === "product_info") return await execProductInfo(db, user, input);
    return `Неизвестный инструмент: ${name}`;
  } catch (e) {
    console.error(`[ai/tools] ${name}:`, e);
    return "Ошибка выполнения действия, попробуйте ещё раз.";
  }
}
