// Планировщик уведомлений мини-помощника. Вызывается раз в минуту:
//   • из процесса бота (scripts/run-bot.ts, setInterval) — локально/VPS;
//   • из cron-роута /api/cron/notify — на хостинге.
// Всё идемпотентно: утренняя отправка помечается notified_at, напоминание —
// reminded_at, вечерняя сводка — по одной записи в системном журнале дня.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DEMO_ORG_ID } from "../../shared/constants";
import { ensureDutyAssignments, localIsoDate } from "../data/duties-core";
import { sendToTelegramId, tgEsc } from "./notify";

const MORNING_HOUR = 9; // рассылка задач дня после 09:00
const EVENING_HOUR = 19; // сводка руководству после 19:30
const EVENING_MINUTE = 30;
const REMIND_BEFORE_MIN = 60; // напоминание за час до дедлайна

let _db: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (_db) return _db;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase не настроен");
  _db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _db;
}

type DutyNotifyRow = {
  id: string;
  assignee_id: string;
  due_at: string;
  status: string;
  notified_at: string | null;
  reminded_at: string | null;
  template: { title: string } | { title: string }[] | null;
  assignee: { full_name: string | null; telegram_id: number | null } | { full_name: string | null; telegram_id: number | null }[] | null;
};

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

async function todaysAssignments(): Promise<DutyNotifyRow[]> {
  const { data, error } = await db()
    .from("duty_assignments")
    .select(
      "id, assignee_id, due_at, status, notified_at, reminded_at, template:duty_templates(title), assignee:profiles(full_name, telegram_id)",
    )
    .eq("org_id", DEMO_ORG_ID)
    .eq("task_date", localIsoDate())
    .limit(200);
  if (error) throw error;
  return (data ?? []) as unknown as DutyNotifyRow[];
}

// ── Утро: список задач дня каждому сотруднику с привязанным Telegram ──
async function morningDigest(now: Date): Promise<void> {
  if (now.getHours() < MORNING_HOUR) return;
  const rows = await todaysAssignments();
  const pendingUnnotified = rows.filter((r) => !r.notified_at);
  if (!pendingUnnotified.length) return;

  // группируем по сотруднику
  const byUser = new Map<string, DutyNotifyRow[]>();
  for (const r of pendingUnnotified) {
    const arr = byUser.get(r.assignee_id) ?? [];
    arr.push(r);
    byUser.set(r.assignee_id, arr);
  }

  for (const [, list] of byUser) {
    const assignee = one(list[0].assignee);
    const ids = list.map((r) => r.id);
    if (assignee?.telegram_id) {
      const lines = [
        `☀️ Доброе утро, ${tgEsc((assignee.full_name ?? "").split(" ")[0] || "коллега")}!`,
        `<b>Ваши задачи по регламенту на сегодня:</b>`,
        "",
      ];
      [...list]
        .sort((a, b) => a.due_at.localeCompare(b.due_at))
        .forEach((r, i) => {
          lines.push(`${i + 1}. ${tgEsc(one(r.template)?.title ?? "Задача")} — до <b>${fmtTime(r.due_at)}</b>`);
        });
      lines.push("", "Выполнили — отметьте в боте: /menu → 📋 Регламент сегодня");
      await sendToTelegramId(assignee.telegram_id, lines.join("\n"));
    }
    // Помечаем в любом случае (нет Telegram — не долбимся каждую минуту)
    await db()
      .from("duty_assignments")
      .update({ notified_at: new Date().toISOString() })
      .in("id", ids);
  }
}

// ── Напоминание за час до дедлайна (только невыполненные) ──
async function deadlineReminders(now: Date): Promise<void> {
  const rows = await todaysAssignments();
  const soon = rows.filter((r) => {
    if (r.status !== "pending" || r.reminded_at) return false;
    const left = new Date(r.due_at).getTime() - now.getTime();
    return left > 0 && left <= REMIND_BEFORE_MIN * 60_000;
  });
  for (const r of soon) {
    const assignee = one(r.assignee);
    if (assignee?.telegram_id) {
      const mins = Math.max(1, Math.round((new Date(r.due_at).getTime() - now.getTime()) / 60_000));
      await sendToTelegramId(
        assignee.telegram_id,
        `⏰ <b>Напоминание:</b> через ${mins} мин дедлайн задачи\n«${tgEsc(one(r.template)?.title ?? "Задача")}» (до ${fmtTime(r.due_at)}).\n\nСдать отчёт: /menu → 📋 Регламент сегодня`,
      );
    }
    await db().from("duty_assignments").update({ reminded_at: new Date().toISOString() }).eq("id", r.id);
  }
}

// ── Вечер: сводка дисциплины руководству (директор + ст. менеджеры) ──
// Отметка «уже отправлено» — sync_runs с source='funnel' не трогаем; используем
// отдельную запись в telegram_sessions с фиктивным chat_id -1 (простое K/V).
async function eveningSummary(now: Date): Promise<void> {
  if (now.getHours() < EVENING_HOUR || (now.getHours() === EVENING_HOUR && now.getMinutes() < EVENING_MINUTE)) return;
  const today = localIsoDate();

  const { data: flag } = await db()
    .from("telegram_sessions")
    .select("data")
    .eq("chat_id", -1)
    .maybeSingle();
  if ((flag?.data as { eveningSent?: string } | null)?.eveningSent === today) return;

  const rows = await todaysAssignments();
  if (!rows.length) return;
  const done = rows.filter((r) => r.status === "done").length;
  const missed = rows.filter((r) => r.status === "missed" || r.status === "pending");
  const lines = [
    `🌙 <b>Итоги дня по регламенту</b> (${today})`,
    "",
    `Всего задач: ${rows.length} · выполнено: ${done} · не закрыто: ${missed.length}`,
  ];
  if (missed.length) {
    lines.push("", "<b>Не закрыты:</b>");
    missed.slice(0, 12).forEach((r) => {
      lines.push(`• ${tgEsc(one(r.assignee)?.full_name ?? "—")} — ${tgEsc(one(r.template)?.title ?? "задача")}`);
    });
  }
  lines.push("", "Подробнее: CRM → Отчёты");

  // руководству с привязанным Telegram
  const { data: leads } = await db()
    .from("org_members")
    .select("user_id, role")
    .eq("org_id", DEMO_ORG_ID)
    .in("role", ["owner", "manager"]);
  const ids = [...new Set((leads ?? []).map((m) => m.user_id as string))];
  if (ids.length) {
    const { data: profiles } = await db()
      .from("profiles")
      .select("telegram_id")
      .in("id", ids)
      .not("telegram_id", "is", null);
    for (const p of profiles ?? []) {
      await sendToTelegramId(p.telegram_id as number, lines.join("\n"));
    }
  }

  await db()
    .from("telegram_sessions")
    .upsert(
      { chat_id: -1, data: { eveningSent: today }, updated_at: new Date().toISOString() },
      { onConflict: "chat_id" },
    );
}

// ── Авто-синк WB (в проде): дёргаем cron-роут веба ──
// Через HTTP, а не напрямую: работают invalidateWbData и guard параллельных
// запусков. APP_URL задаётся на хостинге; локально пропускается.
//
// Два трека — чтобы не заваливать запросами ни ВБ, ни наш сервер:
//   • LIVE — остатки/заказы/продажи: инкрементально, часто (по умолч. 30 мин);
//   • FULL — то же + карточки/цены (полная выгрузка каталога): редко (по умолч. 6 ч).
// Когда подходит FULL — он тянет и живые данные, поэтому LIVE в этот тик не дублируем.
// Периоды настраиваются: WB_SYNC_LIVE_MIN (мин, ≥10), WB_SYNC_FULL_HOURS (ч, ≥1).
function intFromEnv(name: string, def: number, min: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? Math.floor(v) : def;
}

let lastLiveKey = "";
let lastFullKey = "";
function autoSyncWb(now: Date): void {
  const appUrl = process.env.APP_URL;
  const secret = process.env.CRON_SECRET;
  if (!appUrl || !secret) return;

  const liveMin = intFromEnv("WB_SYNC_LIVE_MIN", 30, 10);
  const fullHours = intFromEnv("WB_SYNC_FULL_HOURS", 6, 1);
  const day = localIsoDate(now);
  const minsOfDay = now.getHours() * 60 + now.getMinutes();
  const liveKey = `${day}#live#${Math.floor(minsOfDay / liveMin)}`;
  const fullKey = `${day}#full#${Math.floor(now.getHours() / fullHours)}`;

  // Первый тик после старта процесса: только запоминаем текущие слоты, синк НЕ
  // запускаем. Иначе каждый деплой/рестарт стартует синк, который убивается
  // рестартом контейнера → сирота sync_runs «running» → guard блокирует 502 до
  // 15 мин (ловили дважды). Данные и так свежие: прошлый слот отработал.
  if (!lastFullKey) {
    lastFullKey = fullKey;
    lastLiveKey = liveKey;
    return;
  }

  let mode: "live" | "full" | null = null;
  if (fullKey !== lastFullKey) {
    mode = "full";
    lastFullKey = fullKey;
    lastLiveKey = liveKey; // полный синк покрывает и живые данные — LIVE не дублируем
  } else if (liveKey !== lastLiveKey) {
    mode = "live";
    lastLiveKey = liveKey;
  }
  if (!mode) return;

  console.log(`[scheduler] запускаю WB-синк (${mode})…`);
  const base = appUrl.replace(/\/$/, "");
  fetch(`${base}/api/cron/wb-sync?mode=${mode}`, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(590_000),
  })
    .then(async (r) => {
      console.log(`[scheduler] WB-синк (${mode}):`, r.status);
      if (!r.ok) return;
      // Прогрев кэша ОТДЕЛЬНЫМ запросом: revalidateTag синка сбрасывает тег в
      // конце своего запроса — греть можно только после его завершения.
      const warm = await fetch(`${base}/api/cron/warm`, {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(120_000),
      });
      console.log(`[scheduler] прогрев кэша:`, warm.status);
    })
    .catch((e) => console.error(`[scheduler] WB-синк (${mode}):`, e?.message ?? e));
}

// ── Раз в час: персист авто-статуса «Приехал» у поставок в пути >15 дн ──
// (интерфейс и так показывает derived-on-read; cron фиксирует статус в БД)
let lastArriveKey = "";
function autoSupplyArrive(now: Date): void {
  const appUrl = process.env.APP_URL;
  const secret = process.env.CRON_SECRET;
  if (!appUrl || !secret) return;
  const key = `${localIsoDate(now)}T${now.getHours()}`;
  if (key === lastArriveKey) return;
  const first = !lastArriveKey;
  lastArriveKey = key;
  if (first) return; // первый тик после старта — пропуск (как в autoSyncWb)
  fetch(`${appUrl.replace(/\/$/, "")}/api/cron/supply-auto-arrive`, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => console.error("[scheduler] supply-arrive:", e?.message ?? e));
}

// Один тик планировщика (безопасен к повторным вызовам)
export async function schedulerTick(): Promise<void> {
  const now = new Date();
  try {
    await ensureDutyAssignments(db());
  } catch (e) {
    console.error("[scheduler] ensure:", e);
  }
  await morningDigest(now).catch((e) => console.error("[scheduler] morning:", e));
  await deadlineReminders(now).catch((e) => console.error("[scheduler] remind:", e));
  await eveningSummary(now).catch((e) => console.error("[scheduler] evening:", e));
  autoSyncWb(now);
  autoSupplyArrive(now);
}
