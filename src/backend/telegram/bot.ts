// Ядро Telegram-бота WB CRM (grammY).
// Вход по короткому логину/паролю → проверка через Supabase Auth → привязка
// telegram_id к профилю → меню по роли (RBAC). Один и тот же модуль работает:
//   • под Next.js как webhook  (src/app/api/telegram/route.ts)
//   • автономно long-polling    (scripts/run-bot.ts → `npm run bot`)
//
// Модуль намеренно самодостаточен: импортирует только grammy,
// @supabase/supabase-js и ЧИСТЫЕ общие модули (rbac/constants) относительными
// путями — чтобы одинаково резолвиться и в Turbopack, и в tsx.

import { Bot, GrammyError, InlineKeyboard, InputFile } from "grammy";
import type { Context } from "grammy";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ROLE_LABELS, can, isMemberRole, type MemberRole } from "../../shared/rbac";
import { SUPPLY_AUTO_ARRIVE_DAYS, DEMO_ORG_ID, DEMO_STORE_ID } from "../../shared/constants";
import { askAssistant, aiConfigured, type ChatMessage } from "../ai/assistant";
import { buildSnapshot } from "../ai/snapshot";
import { transcribeTelegramVoice } from "../ai/transcribe";
import { ensureDutyAssignments, localIsoDate } from "../data/duties-core";
import { completeTask, startTask } from "../data/tasks-core";
import { buildDailyReportPdf } from "../reports/daily-pdf";

// ───────────────────────── Supabase-клиенты ─────────────────────────

let _admin: SupabaseClient | null = null;

// service_role — обходит RLS. Чтение/запись рабочих таблиц из бота.
function admin(): SupabaseClient {
  if (_admin) return _admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase не настроен: нужны NEXT_PUBLIC_SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY (.env.local)",
    );
  }
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _admin;
}

// Проверка пароля через Supabase Auth (anon-ключ, signInWithPassword).
// Отдельный короткоживущий клиент на попытку — чтобы не делить состояние сессий.
async function verifyPassword(email: string, password: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Supabase не настроен: нужен NEXT_PUBLIC_SUPABASE_ANON_KEY (.env.local)");
  }
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  await client.auth.signOut().catch(() => {});
  return !error && Boolean(data?.user);
}

// ───────────────────────── Состояние диалога входа ─────────────────────────

type Step = "idle" | "await_login" | "await_password" | "await_duty_report" | "await_task_report";
type SessionData = {
  step: Step;
  login?: string;
  fails?: number;
  lockUntil?: number;
  aiHistory?: ChatMessage[]; // короткая история диалога с ИИ
  dutyId?: string; // назначение регламента, по которому ждём текст отчёта
  taskId?: string; // задача, по которой ждём текст отчёта (отчёт обязателен)
  testProfileId?: string; // тестовый режим: под каким сотрудником смотрим бот
};

// Анти-брутфорс: после MAX_FAILS неудачных попыток — пауза LOCK_MS.
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60_000;

async function readSession(chatId: number): Promise<SessionData> {
  const { data } = await admin()
    .from("telegram_sessions")
    .select("data")
    .eq("chat_id", chatId)
    .maybeSingle();
  const d = (data?.data ?? {}) as SessionData;
  return {
    step: d.step ?? "idle",
    login: d.login,
    fails: d.fails,
    lockUntil: d.lockUntil,
    aiHistory: d.aiHistory,
    dutyId: d.dutyId,
    taskId: d.taskId,
    testProfileId: d.testProfileId,
  };
}

async function writeSession(chatId: number, data: SessionData): Promise<void> {
  await admin()
    .from("telegram_sessions")
    .upsert({ chat_id: chatId, data, updated_at: new Date().toISOString() }, { onConflict: "chat_id" });
}

// Сброс шага диалога. Выбор тестового сотрудника переживает сброс — его снимает
// только явный /logout или «Сменить сотрудника».
async function clearSession(chatId: number): Promise<void> {
  const prev = await readSession(chatId);
  await writeSession(chatId, { step: "idle", testProfileId: prev.testProfileId });
}

// ───────────────────────── Личность / роли ─────────────────────────

type AuthedUser = {
  id: string;
  name: string;
  email: string;
  login: string | null;
  role: MemberRole;
  roleLabel: string;
  orgId: string;
  orgName: string;
};

async function resolveMembership(
  profileId: string,
): Promise<{ role: MemberRole; orgId: string; orgName: string } | null> {
  const { data: m, error } = await admin()
    .from("org_members")
    .select("role, org_id")
    .eq("user_id", profileId)
    .order("created_at", { ascending: true }) // детерминированный выбор при нескольких org
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!m) return null;
  const role: MemberRole = isMemberRole(String(m.role)) ? (m.role as MemberRole) : "viewer";
  const { data: org, error: oe } = await admin()
    .from("orgs")
    .select("name")
    .eq("id", m.org_id)
    .maybeSingle();
  if (oe) throw oe;
  return { role, orgId: String(m.org_id), orgName: (org?.name as string) ?? "—" };
}

// ── Тестовый режим: владелец Telegram ID из TELEGRAM_TEST_IDS заходит под любым
// сотрудником БЕЗ пароля (кнопки с именами). Выбор живёт в telegram_sessions
// (testProfileId) — реальные привязки profiles.telegram_id НЕ трогаются, поэтому
// тест не разлогинивает сотрудников и не перехватывает их уведомления.
function isTestTg(telegramId: number): boolean {
  return (process.env.TELEGRAM_TEST_IDS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .includes(telegramId);
}

// Личка: chat_id == telegram_id (guard пускает только приватные чаты)
async function getTestUser(telegramId: number): Promise<AuthedUser | null> {
  const sess = await readSession(telegramId);
  if (!sess.testProfileId) return null;
  const { data: p, error } = await admin()
    .from("profiles")
    .select("id, full_name, email, login")
    .eq("id", sess.testProfileId)
    .maybeSingle();
  if (error) throw error;
  if (!p) return null;
  const m = await resolveMembership(String(p.id));
  if (!m) return null;
  return {
    id: String(p.id),
    name: (p.full_name as string) ?? "Сотрудник",
    email: (p.email as string) ?? "",
    login: (p.login as string) ?? null,
    role: m.role,
    roleLabel: ROLE_LABELS[m.role],
    orgId: m.orgId,
    orgName: m.orgName,
  };
}

const ROLE_RANK: Record<string, number> = {
  owner: 0, admin: 1, manager: 2, designer: 3, seo: 4, kiz: 5, adv: 6, shipping: 7, analyst: 8, viewer: 9,
};

// Список сотрудников для тестового входа (имя + роль, отсортировано по рангу роли)
async function renderTestPicker(): Promise<{ body: string; kb: InlineKeyboard }> {
  const { data, error } = await admin()
    .from("org_members")
    .select("role, profile:profiles(id, full_name)")
    .eq("org_id", DEMO_ORG_ID);
  if (error) throw error;
  const rows = ((data ?? []) as unknown as Array<{
    role: string;
    profile: { id: string; full_name: string | null } | { id: string; full_name: string | null }[] | null;
  }>)
    .map((m) => {
      const p = Array.isArray(m.profile) ? m.profile[0] : m.profile;
      return p ? { id: String(p.id), name: p.full_name ?? "—", role: m.role } : null;
    })
    .filter(Boolean) as Array<{ id: string; name: string; role: string }>;
  rows.sort((a, b) => (ROLE_RANK[a.role] ?? 99) - (ROLE_RANK[b.role] ?? 99) || a.name.localeCompare(b.name, "ru"));

  const kb = new InlineKeyboard();
  for (const r of rows) {
    kb.text(`${r.name} — ${ROLE_LABELS[r.role as MemberRole] ?? r.role}`, `test:pick:${r.id}`).row();
  }
  return {
    body: [
      "🧪 <b>Тестовый режим</b>",
      "",
      "Выберите сотрудника — бот покажет всё его глазами (меню, задачи, доступы):",
    ].join("\n"),
    kb,
  };
}

// Профиль, уже привязанный к этому Telegram-аккаунту (авто-вход).
async function getLinkedUser(telegramId: number): Promise<AuthedUser | null> {
  if (isTestTg(telegramId)) return getTestUser(telegramId); // тест — только через сессию
  const { data: p, error } = await admin()
    .from("profiles")
    .select("id, full_name, email, login, telegram_id")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  if (error) throw error; // ошибку запроса НЕ путаем с «профиль не привязан» (иначе ложный логаут)
  if (!p) return null;
  const m = await resolveMembership(String(p.id));
  if (!m) return null;
  return {
    id: String(p.id),
    name: (p.full_name as string) ?? "Сотрудник",
    email: (p.email as string) ?? "",
    login: (p.login as string) ?? null,
    role: m.role,
    roleLabel: ROLE_LABELS[m.role],
    orgId: m.orgId,
    orgName: m.orgName,
  };
}

// Поиск профиля для аутентификации: по короткому логину ИЛИ по email
// (регистронезависимо). Логины/emails уникальны → не более одной строки.
async function findProfileByLogin(input: string): Promise<{ id: string; email: string } | null> {
  const val = input.trim().toLowerCase();
  if (!val) return null;
  // Экранируем спецсимволы LIKE (% _ \) → ilike работает как регистронезависимое РАВНО,
  // а не как шаблон (иначе «dire%» матчил бы «director», а «a_iya» — «aliya»).
  const safe = val.replace(/[\\%_]/g, (m) => "\\" + m);
  const byLogin = await admin()
    .from("profiles")
    .select("id, email, login")
    .ilike("login", safe)
    .maybeSingle();
  if (byLogin.error) throw byLogin.error;
  if (byLogin.data?.email) return { id: String(byLogin.data.id), email: String(byLogin.data.email) };
  const byEmail = await admin()
    .from("profiles")
    .select("id, email")
    .ilike("email", safe)
    .maybeSingle();
  if (byEmail.error) throw byEmail.error;
  if (byEmail.data?.email) return { id: String(byEmail.data.id), email: String(byEmail.data.email) };
  return null;
}

// telegram_id уникален → перед привязкой снимаем его с других профилей.
async function linkTelegram(
  profileId: string,
  telegramId: number,
  username: string | null,
): Promise<void> {
  await admin()
    .from("profiles")
    .update({ telegram_id: null, telegram_username: null })
    .eq("telegram_id", telegramId)
    .neq("id", profileId);
  await admin()
    .from("profiles")
    .update({ telegram_id: telegramId, telegram_username: username })
    .eq("id", profileId);
}

async function unlinkTelegram(telegramId: number): Promise<void> {
  await admin()
    .from("profiles")
    .update({ telegram_id: null, telegram_username: null })
    .eq("telegram_id", telegramId);
}

// ───────────────────────── Форматирование ─────────────────────────

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function rub(n: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(n)) + " ₽";
}

const TASK_STATUS: Record<string, string> = {
  open: "🔵 Открыта",
  in_progress: "🟡 В работе",
  done: "🟢 Готово",
  cancelled: "⚪️ Отменена",
};
const TASK_PRIORITY: Record<string, string> = {
  low: "низкий",
  normal: "обычный",
  high: "высокий",
  urgent: "срочный",
};
const SUPPLY_STATUS_LABELS: Record<string, string> = {
  in_transit: "🚚 В пути",
  arrived: "📍 Приехал",
  received: "📦 Принят",
  sorting: "🔧 В разборе",
  in_stock: "🏬 На складе",
  distributed: "✅ Распределён по WB",
  cancelled: "⚪️ Отменён",
};

// Локальные даты (пояс UTC+5/6): считаем в местных сутках, без сдвига UTC.
function daysSince(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const from = new Date(y, (m ?? 1) - 1, d ?? 1);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((today.getTime() - from.getTime()) / 86_400_000));
}

// Авто-статус «Приехал»: «В пути» дольше N дней (derived-on-read, как в вебе).
function effStatus(status: string, shipDate: string): string {
  if (status === "in_transit" && daysSince(shipDate) >= SUPPLY_AUTO_ARRIVE_DAYS) return "arrived";
  return status;
}

// ───────────────────────── Меню ─────────────────────────

export const BOT_COMMANDS = [
  { command: "start", description: "Вход / главное меню" },
  { command: "menu", description: "Показать меню" },
  { command: "logout", description: "Выйти из аккаунта" },
  { command: "help", description: "Помощь" },
];

const HELP_TEXT = [
  "🤖 <b>WB CRM — бот-помощник</b>",
  "",
  "Вход по логину и паролю сотрудника. После входа можно <b>просто писать боту</b> " +
    "или отправлять <b>голосовые</b> — он поймёт и сделает.",
  "",
  "<b>Примеры:</b>",
  "• «какие у меня задачи?»",
  "• «поставь Феликсу задачу обновить фото кимоно до пятницы»",
  "• «закрой задачу про фото, отчёт: обновил 5 карточек, отправил на модерацию»",
  "• «что команда сделала сегодня?» (для руководителя)",
  "• «что скоро закончится на складах?»",
  "",
  "Команды:",
  "/start — вход или главное меню",
  "/menu — показать меню",
  "/logout — выйти",
].join("\n");

function greeting(user: AuthedUser, test = false): string {
  return [
    test
      ? `🧪 Тестовый режим: вы смотрите бот глазами <b>${esc(user.name)}</b>`
      : `✅ Вы вошли как <b>${esc(user.name)}</b>`,
    `Роль: <b>${esc(user.roleLabel)}</b>`,
    `Организация: ${esc(user.orgName)}`,
    "",
    aiConfigured()
      ? "💬 Просто напишите или наговорите голосовое — ассистент ответит и сделает: " +
        "поставит задачу, закроет её с отчётом, покажет цифры.\n\nИли выберите раздел:"
      : "Выберите раздел:",
  ].join("\n");
}

// ── ИИ-ассистент: свободный вопрос от вошедшего сотрудника ──
async function handleAiQuestion(ctx: Context, user: AuthedUser, chatId: number, text: string): Promise<void> {
  await ctx.replyWithChatAction("typing").catch(() => {});
  const sess = await readSession(chatId);
  const history: ChatMessage[] = [...(sess.aiHistory ?? []), { role: "user", content: text }];
  let reply: string;
  try {
    const snapshot = await buildSnapshot(admin(), {
      id: user.id,
      name: user.name,
      role: user.role,
      roleLabel: user.roleLabel,
      orgName: user.orgName,
    });
    reply = await askAssistant({
      user: { id: user.id, name: user.name, role: user.role, roleLabel: user.roleLabel, orgName: user.orgName },
      snapshot,
      history,
      db: admin(), // инструменты-действия доступны и из Telegram
    });
  } catch (e) {
    console.error("[telegram] AI ошибка:", e);
    await ctx.reply("⚠️ ИИ-ассистент временно недоступен, попробуйте ещё раз.");
    return;
  }
  const newHistory = [...history, { role: "assistant" as const, content: reply }].slice(-10);
  await writeSession(chatId, { step: "idle", aiHistory: newHistory, testProfileId: sess.testProfileId });
  // Ответ ИИ — простым текстом (без parse_mode, чтобы спецсимволы не ломали HTML)
  await ctx.reply(reply.slice(0, 4000), {
    reply_markup: new InlineKeyboard().text("📋 Меню", "menu:home"),
  });
}

// Главное меню — только разделы, доступные роли (RBAC).
function mainMenu(user: AuthedUser, test = false): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (aiConfigured()) kb.text("🤖 ИИ-ассистент", "menu:ai").row();
  if (can(user.role, "duty:view")) kb.text("📋 Регламент сегодня", "menu:duties").row();
  if (can(user.role, "tasks:view")) kb.text("🗒 Мои задачи", "menu:tasks").row();
  if (can(user.role, "dashboard:view")) kb.text("📊 Сводка магазина", "menu:dashboard").row();
  if (can(user.role, "supply:view")) kb.text("🚚 Поставки", "menu:supplies").row();
  if (can(user.role, "products:view")) kb.text("📦 Товары", "menu:products").row();
  if (can(user.role, "finance:view")) kb.text("💰 Финансы", "menu:finance").row();
  if (can(user.role, "team:manage")) kb.text("👥 Команда", "menu:team").row();
  if (can(user.role, "dashboard:view")) kb.text("📄 Отчёт PDF за день", "menu:pdf").row();
  if (test) kb.text("🔄 Сменить сотрудника", "test:switch").row();
  kb.text("🚪 Выйти", "action:logout");
  return kb;
}

function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("⬅️ В меню", "menu:home");
}

// ───────────────────────── Разделы (реальные данные из БД) ─────────────────────────

async function storeIdsFor(orgId: string): Promise<string[]> {
  const { data, error } = await admin().from("stores").select("id").eq("org_id", orgId);
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((s) => String(s.id));
}

type TaskRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  product: { title: string } | null;
};

async function renderTasks(user: AuthedUser): Promise<{ body: string; kb: InlineKeyboard }> {
  const { data, error } = await admin()
    .from("tasks")
    .select("id, title, status, priority, due_date, product:products(title)")
    .eq("org_id", user.orgId)
    .eq("assignee_id", user.id)
    .order("status", { ascending: true })
    .order("priority", { ascending: false })
    .limit(20);

  if (error) return { body: "⚠️ Не удалось загрузить задачи.", kb: backKeyboard() };
  const tasks = (data ?? []) as unknown as TaskRow[];
  if (!tasks.length) {
    return { body: "🗒 <b>Мои задачи</b>\n\nНазначенных задач нет — можно выдохнуть 🙂", kb: backKeyboard() };
  }

  const lines = ["🗒 <b>Мои задачи</b>", ""];
  tasks.forEach((t, i) => {
    const prod = t.product?.title ? ` · ${esc(t.product.title)}` : "";
    const due = t.due_date ? ` · до ${esc(t.due_date)}` : "";
    lines.push(`<b>#${i + 1}</b> ${TASK_STATUS[t.status] ?? esc(t.status)} — ${esc(t.title)}`);
    lines.push(`   приоритет: ${TASK_PRIORITY[t.priority] ?? esc(t.priority)}${prod}${due}`);
  });

  const kb = new InlineKeyboard();
  tasks.forEach((t, i) => {
    if (t.status === "open") kb.text(`#${i + 1} ▶️ В работу`, `task:${t.id}:start`).row();
    else if (t.status === "in_progress") kb.text(`#${i + 1} ✅ Завершить`, `task:${t.id}:done`).row();
  });
  kb.text("⬅️ В меню", "menu:home");
  return { body: lines.join("\n"), kb };
}

async function renderDashboard(_user: AuthedUser): Promise<string> {
  // Агрегаты в Postgres (rpc) — сырые строки PostgREST режет до 1000, суммы врали бы
  const since = (days: number) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - days);
    return d.toISOString();
  };
  type Daily = { day: string; qty: number; sum_rub: number };
  const [o30, s30, s7sum] = await Promise.all([
    admin().rpc("agg_orders_daily", { p_store: DEMO_STORE_ID, p_since: since(29) }),
    admin().rpc("agg_sales_summary", { p_store: DEMO_STORE_ID, p_since: since(29) }),
    admin().rpc("agg_sales_summary", { p_store: DEMO_STORE_ID, p_since: since(6) }),
  ]);
  const oRows = (o30.data ?? []) as Daily[];
  const t7 = since(6).slice(0, 10);
  const o30qty = oRows.reduce((t, r) => t + Number(r.qty), 0);
  const o30sum = oRows.reduce((t, r) => t + Number(r.sum_rub), 0);
  const o7rows = oRows.filter((r) => r.day >= t7);
  const o7qty = o7rows.reduce((t, r) => t + Number(r.qty), 0);
  const o7sum = o7rows.reduce((t, r) => t + Number(r.sum_rub), 0);
  const s30row = ((s30.data ?? []) as { qty: number; sum_rub: number }[])[0];
  const s7row = ((s7sum.data ?? []) as { qty: number; sum_rub: number }[])[0];
  const buyout = (o: number, s: number) => (o ? Math.round((s / o) * 100) : 0);

  return [
    "📊 <b>Сводка магазина</b>",
    "",
    "<b>За 7 дней</b>",
    `Заказы: ${o7qty} шт · ${rub(o7sum)}`,
    `Продажи: ${Number(s7row?.qty ?? 0)} шт · ${rub(Number(s7row?.sum_rub ?? 0))}`,
    `Выкуп: ${buyout(o7qty, Number(s7row?.qty ?? 0))}%`,
    "",
    "<b>За 30 дней</b>",
    `Заказы: ${o30qty} шт · ${rub(o30sum)}`,
    `Продажи: ${Number(s30row?.qty ?? 0)} шт · ${rub(Number(s30row?.sum_rub ?? 0))}`,
    `Выкуп: ${buyout(o30qty, Number(s30row?.qty ?? 0))}%`,
  ].join("\n");
}

// ── Регламент: задачи дня сотрудника (кнопки «Выполнено» → отчёт в чате) ──

type DutyRow = {
  id: string;
  status: string;
  due_at: string;
  template: { title: string } | { title: string }[] | null;
};

function dutyTitle(r: DutyRow): string {
  const t = Array.isArray(r.template) ? r.template[0] : r.template;
  return t?.title ?? "Задача";
}

async function renderDuties(user: AuthedUser): Promise<{ body: string; kb: InlineKeyboard }> {
  await ensureDutyAssignments(admin()).catch(() => {});
  const { data, error } = await admin()
    .from("duty_assignments")
    .select("id, status, due_at, template:duty_templates(title, sort_order)")
    .eq("assignee_id", user.id)
    .eq("task_date", localIsoDate())
    .order("due_at")
    .limit(30);
  if (error) return { body: "⚠️ Не удалось загрузить регламент.", kb: backKeyboard() };
  const rows = (data ?? []) as unknown as DutyRow[];
  if (!rows.length) {
    return { body: "📋 <b>Регламент сегодня</b>\n\nЗадач на сегодня нет.", kb: backKeyboard() };
  }
  const icon: Record<string, string> = { pending: "🔵", done: "✅", missed: "🔴" };
  const lines = ["📋 <b>Регламент сегодня</b>", ""];
  rows.forEach((r, i) => {
    const time = new Date(r.due_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    lines.push(`<b>#${i + 1}</b> ${icon[r.status] ?? "•"} ${esc(dutyTitle(r))} — до ${time}`);
  });
  lines.push("", "Нажмите «Выполнено» — попрошу короткий отчёт текстом.");
  const kb = new InlineKeyboard();
  rows.forEach((r, i) => {
    if (r.status !== "done") kb.text(`#${i + 1} ✅ Выполнено`, `duty:${r.id}`).row();
  });
  kb.text("⬅️ В меню", "menu:home");
  return { body: lines.join("\n"), kb };
}

// Завершение задачи регламента с текстом отчёта (из шага await_duty_report)
async function completeDuty(user: AuthedUser, dutyId: string, report: string): Promise<string> {
  const { data: a } = await admin()
    .from("duty_assignments")
    .select("id, assignee_id, due_at, status, org_id, template:duty_templates(title)")
    .eq("id", dutyId)
    .maybeSingle();
  if (!a || String(a.assignee_id) !== user.id) return "⚠️ Задача не найдена или не ваша.";
  if (a.status === "done") return "Эта задача уже закрыта ✅";
  const onTime = Date.now() <= new Date(a.due_at as string).getTime();
  await admin().from("duty_reports").upsert(
    {
      org_id: a.org_id,
      assignment_id: dutyId,
      user_id: user.id,
      content: report,
      on_time: onTime,
    },
    { onConflict: "assignment_id" },
  );
  await admin()
    .from("duty_assignments")
    .update({ status: "done", completed_at: new Date().toISOString() })
    .eq("id", dutyId);
  const t = a.template as { title?: string } | { title?: string }[] | null;
  const title = (Array.isArray(t) ? t[0] : t)?.title ?? "Задача";
  return onTime
    ? `✅ «${esc(title)}» закрыта вовремя, отчёт записан. Молодец!`
    : `✅ «${esc(title)}» закрыта (после дедлайна), отчёт записан.`;
}

type SupplyRow = {
  title: string;
  quantity: number;
  status: string;
  ship_date: string;
  received_qty: number | null;
};

async function renderSupplies(user: AuthedUser): Promise<string> {
  const { data, error } = await admin()
    .from("supplies")
    .select("title, quantity, status, ship_date, received_qty")
    .eq("org_id", user.orgId)
    .order("ship_date", { ascending: false })
    .limit(12);
  if (error) throw error;

  const rows = ((data ?? []) as SupplyRow[]).map((s) => ({ ...s, eff: effStatus(s.status, s.ship_date) }));
  if (!rows.length) return "🚚 <b>Поставки</b>\n\nКарточек отгрузки нет.";

  const counts: Record<string, number> = {};
  rows.forEach((r) => (counts[r.eff] = (counts[r.eff] ?? 0) + 1));

  const lines = ["🚚 <b>Поставки</b>", "", "<b>По статусам:</b>"];
  Object.entries(counts).forEach(([st, n]) => lines.push(`${SUPPLY_STATUS_LABELS[st] ?? st}: ${n}`));
  lines.push("", "<b>Последние отгрузки:</b>");
  rows.slice(0, 8).forEach((r) => {
    const extra =
      r.eff === "in_transit"
        ? ` · ${daysSince(r.ship_date)} дн в пути`
        : r.received_qty != null && r.received_qty < r.quantity
          ? ` · ⚠️ недостача ${r.quantity - r.received_qty}`
          : "";
    lines.push(`• ${esc(r.title)} — ${r.quantity} шт · ${SUPPLY_STATUS_LABELS[r.eff] ?? r.eff}${extra}`);
  });
  return lines.join("\n");
}

async function renderProducts(user: AuthedUser): Promise<string> {
  const storeIds = await storeIdsFor(user.orgId);
  if (!storeIds.length) return "📦 <b>Товары</b>\n\nМагазины не подключены.";
  const { data, error } = await admin()
    .from("products")
    .select("title, status, cost_price, category")
    .in("store_id", storeIds)
    .order("title")
    .limit(20);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ title: string; status: string | null; cost_price: number | null }>;
  if (!rows.length) return "📦 <b>Товары</b>\n\nКарточек товаров нет.";
  const lines = ["📦 <b>Товары</b>", ""];
  rows.forEach((p) =>
    lines.push(
      `• ${esc(p.title)}${p.status ? ` · ${esc(p.status)}` : ""}${
        p.cost_price != null ? ` · себест. ${rub(Number(p.cost_price))}` : ""
      }`,
    ),
  );
  return lines.join("\n");
}

async function renderFinance(_user: AuthedUser): Promise<string> {
  // План WB против факта продаж (как на странице «Финансы» в вебе)
  const today = localIsoDate();
  const { data: plans } = await admin()
    .from("sales_plans")
    .select("period_start, period_end, amount_rub")
    .eq("store_id", DEMO_STORE_ID)
    .order("period_start", { ascending: false })
    .limit(5);
  const plan =
    (plans ?? []).find(
      (p) => (p.period_start as string) <= today && today <= (p.period_end as string),
    ) ?? (plans ?? [])[0];
  if (!plan) return "💰 <b>Финансы</b>\n\nПлан продаж не задан (CRM → Финансы → «Задать план»).";

  const start = plan.period_start as string;
  const end = plan.period_end as string;
  const amount = Number(plan.amount_rub);
  const { data: daily } = await admin().rpc("agg_sales_daily", {
    p_store: DEMO_STORE_ID,
    p_since: `${start}T00:00:00`,
  });
  type Daily = { day: string; sum_rub: number };
  const rows = (daily ?? []) as Daily[];
  const fact = rows.reduce((t, r) => t + Number(r.sum_rub), 0);
  const todayFact = Number(rows.find((r) => r.day === today)?.sum_rub ?? 0);
  const totalDays = Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000) + 1);
  const passed = Math.max(1, Math.round((new Date(today).getTime() - new Date(start).getTime()) / 86_400_000) + 1);
  const dailyPlan = Math.round(amount / totalDays);
  const planToDate = dailyPlan * passed;
  const pct = planToDate ? Math.round((fact / planToDate) * 100) : 0;
  const needDaily = Math.max(0, Math.round((amount - fact) / Math.max(1, totalDays - passed)));

  return [
    "💰 <b>Финансы · план WB</b>",
    `Период: ${esc(start)} — ${esc(end)}`,
    "",
    `План на период: ${rub(amount)}`,
    `Факт с начала: ${rub(fact)}`,
    `Выполнение на сегодня: <b>${pct}%</b>`,
    `Сегодня продано: ${rub(todayFact)} (план ${rub(dailyPlan)}/дн)`,
    `Нужно в день до конца: ${rub(needDaily)}`,
  ].join("\n");
}

async function renderTeam(user: AuthedUser): Promise<string> {
  const { data, error } = await admin()
    .from("org_members")
    .select("role, profile:profiles(full_name, email, login)")
    .eq("org_id", user.orgId);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<{
    role: string;
    profile: { full_name: string | null; email: string | null; login: string | null } | null;
  }>;
  if (!rows.length) return "👥 <b>Команда</b>\n\nУчастников нет.";
  const rank: Record<string, number> = { owner: 0, admin: 1, manager: 2, analyst: 3, viewer: 4 };
  rows.sort((a, b) => (rank[a.role] ?? 9) - (rank[b.role] ?? 9));
  const lines = ["👥 <b>Команда</b>", ""];
  rows.forEach((m) => {
    const label = ROLE_LABELS[m.role as MemberRole] ?? m.role;
    const login = m.profile?.login ? ` · логин: <code>${esc(m.profile.login)}</code>` : "";
    lines.push(`• ${esc(m.profile?.full_name ?? "—")} — ${esc(label)}${login}`);
  });
  return lines.join("\n");
}

// ───────────────────────── Хелперы отправки ─────────────────────────

async function editText(ctx: Context, text: string, keyboard?: InlineKeyboard): Promise<void> {
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    if (e instanceof GrammyError && e.description.includes("message is not modified")) return;
    try {
      await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
    } catch {
      /* проглатываем — не роняем апдейт */
    }
  }
}

// ───────────────────────── Обработчики ─────────────────────────

async function handleStart(ctx: Context): Promise<void> {
  const tgId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!tgId || chatId == null) return;

  const linked = await getLinkedUser(tgId);
  if (linked) {
    await clearSession(chatId);
    const test = isTestTg(tgId);
    await ctx.reply(greeting(linked, test), { parse_mode: "HTML", reply_markup: mainMenu(linked, test) });
    return;
  }
  // Тестовый аккаунт: вместо логина/пароля — выбор сотрудника кнопками
  if (isTestTg(tgId)) {
    const { body, kb } = await renderTestPicker();
    await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
    return;
  }
  await writeSession(chatId, { step: "await_login" });
  await ctx.reply(
    "👋 <b>WB CRM</b> — вход для сотрудников.\n\nВведите ваш <b>логин</b> " +
      "(например <code>director</code>, <code>marat</code>, или ваш email):",
    { parse_mode: "HTML" },
  );
}

async function handleMenu(ctx: Context): Promise<void> {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  const linked = await getLinkedUser(tgId);
  if (!linked) {
    await handleStart(ctx);
    return;
  }
  const test = isTestTg(tgId);
  await ctx.reply(greeting(linked, test), { parse_mode: "HTML", reply_markup: mainMenu(linked, test) });
}

async function handleLogout(ctx: Context): Promise<void> {
  const tgId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (tgId) await unlinkTelegram(tgId);
  if (chatId != null) await writeSession(chatId, { step: "idle" }); // сброс вместе с тестовым выбором
  await ctx.reply("🚪 Вы вышли из аккаунта. Чтобы войти снова — /start");
}

// Единый вход для ЛЮБОГО сообщения сотрудника — печатного или голосового.
// Порядок: незавершённый шаг (отчёт по задаче/регламенту) → иначе ИИ-агент,
// который сам решает, ответить или выполнить действие в системе.
async function handleUserInput(ctx: Context, text: string): Promise<void> {
  const tgId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!tgId || chatId == null) return;

  // Уже вошёл: сначала — незавершённые шаги (отчёты), затем ИИ.
  const linked = await getLinkedUser(tgId);
  if (linked) {
    const sess0 = await readSession(chatId);

    // Отчёт по обычной задаче (обязателен — правило tasks-core)
    if (sess0.step === "await_task_report" && sess0.taskId) {
      if (!text) {
        await ctx.reply("Отчёт не может быть пустым — напишите пару предложений о том, что сделано.");
        return;
      }
      const result = await completeTask(
        admin(),
        sess0.taskId,
        { id: linked.id, name: linked.name, role: linked.role, roleLabel: linked.roleLabel },
        text,
      );
      await writeSession(chatId, { step: "idle", aiHistory: sess0.aiHistory, testProfileId: sess0.testProfileId });
      await ctx.reply(result.ok ? `✅ ${esc(result.message)}` : `⚠️ ${esc(result.message)}`, { parse_mode: "HTML" });
      const { body, kb } = await renderTasks(linked);
      await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
      return;
    }

    // Отчёт по задаче регламента
    if (sess0.step === "await_duty_report" && sess0.dutyId) {
      if (!text) {
        await ctx.reply("Отчёт не может быть пустым — напишите пару предложений.");
        return;
      }
      const result = await completeDuty(linked, sess0.dutyId, text.slice(0, 2000));
      await writeSession(chatId, { step: "idle", aiHistory: sess0.aiHistory, testProfileId: sess0.testProfileId });
      await ctx.reply(result, { parse_mode: "HTML" });
      const { body, kb } = await renderDuties(linked);
      await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
      return;
    }

    if (aiConfigured() && text) {
      await handleAiQuestion(ctx, linked, chatId, text);
      return;
    }
    await ctx.reply("Вы уже вошли. Откройте меню: /menu", { reply_markup: mainMenu(linked, isTestTg(tgId)) });
    return;
  }

  // Тестовый аккаунт без выбранного сотрудника: логин-флоу не для него
  if (isTestTg(tgId)) {
    const { body, kb } = await renderTestPicker();
    await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
    return;
  }

  const sess = await readSession(chatId);

  // Анти-брутфорс: после серии неудач — пауза.
  if (sess.lockUntil && Date.now() < sess.lockUntil) {
    const secs = Math.ceil((sess.lockUntil - Date.now()) / 1000);
    await ctx.reply(`⏳ Слишком много попыток. Подождите ${secs} сек, затем /start.`);
    return;
  }

  if (sess.step === "await_login") {
    if (!text) {
      await ctx.reply("Введите логин (например <code>director</code>):", { parse_mode: "HTML" });
      return;
    }
    await writeSession(chatId, { step: "await_password", login: text, fails: sess.fails });
    await ctx.reply("🔑 Теперь введите <b>пароль</b>:", { parse_mode: "HTML" });
    return;
  }

  if (sess.step === "await_password") {
    const login = sess.login ?? "";
    const password = text;
    // Пытаемся убрать сообщение с паролем (в личке Telegram обычно не даёт —
    // тогда просто останется в истории; поймано try/catch).
    try {
      await ctx.deleteMessage();
    } catch {
      /* приватный чат: удалять чужие сообщения нельзя */
    }

    // Единый ответ для «нет логина» и «неверный пароль» — не раскрываем существование логина.
    const profile = await findProfileByLogin(login);
    const ok = profile ? await verifyPassword(profile.email, password) : false;

    if (!ok) {
      const fails = (sess.fails ?? 0) + 1;
      if (fails >= MAX_FAILS) {
        await writeSession(chatId, { step: "await_login", fails: 0, lockUntil: Date.now() + LOCK_MS });
        await ctx.reply(
          `❌ Неверный логин или пароль. Слишком много попыток — подождите ${LOCK_MS / 60_000} мин, затем /start.`,
        );
      } else {
        await writeSession(chatId, { step: "await_login", fails });
        await ctx.reply("❌ Неверный логин или пароль. Попробуйте снова — введите логин:");
      }
      return;
    }

    await linkTelegram(profile!.id, tgId, ctx.from?.username ?? null);
    await clearSession(chatId);

    const user = await getLinkedUser(tgId);
    if (!user) {
      await ctx.reply(
        "Вход выполнен, но у вашего профиля нет роли в организации. Обратитесь к администратору.",
      );
      return;
    }
    await ctx.reply(greeting(user), { parse_mode: "HTML", reply_markup: mainMenu(user) });
    return;
  }

  // idle и не вошёл — предлагаем войти.
  await writeSession(chatId, { step: "await_login" });
  await ctx.reply("Чтобы войти, введите ваш <b>логин</b>:", { parse_mode: "HTML" });
}

// Обычное текстовое сообщение
async function handleText(ctx: Context): Promise<void> {
  await handleUserInput(ctx, (ctx.message?.text ?? "").trim());
}

// ── Голосовое / аудио / кружочек: распознаём речь и дальше — как текст ──────
// Claude аудио не принимает, поэтому речь → текст делает Whisper (transcribe.ts).
// Пароль голосом не принимаем: он ушёл бы во внешний сервис распознавания.
async function handleVoice(ctx: Context): Promise<void> {
  const tgId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!tgId || chatId == null) return;

  const msg = ctx.message;
  const media = msg?.voice ?? msg?.audio ?? msg?.video_note;
  if (!media) return;

  const linked = await getLinkedUser(tgId);
  if (!linked) {
    await ctx.reply("Сначала войдите: /start (логин и пароль — текстом).");
    return;
  }

  await ctx.replyWithChatAction("typing").catch(() => {});
  const result = await transcribeTelegramVoice(
    media.file_id,
    Number(media.duration ?? 0),
    ("mime_type" in media && media.mime_type) || "audio/ogg",
  );
  if (!result.ok) {
    await ctx.reply(`🎤 ${result.message}`);
    return;
  }

  // Показываем расшифровку — сотрудник видит, что именно услышал бот
  await ctx.reply(`🎤 <i>${esc(result.text)}</i>`, { parse_mode: "HTML" });
  await handleUserInput(ctx, result.text);
}

const SECTION_GUARD: Record<string, Parameters<typeof can>[1]> = {
  tasks: "tasks:view",
  duties: "duty:view",
  dashboard: "dashboard:view",
  supplies: "supply:view",
  products: "products:view",
  finance: "finance:view",
  team: "team:manage",
};

async function showSection(ctx: Context, user: AuthedUser, section: string): Promise<void> {
  const guard = SECTION_GUARD[section];
  if (!guard || !can(user.role, guard)) {
    await ctx.answerCallbackQuery({ text: "Нет доступа к этому разделу", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();

  try {
    if (section === "tasks") {
      const { body, kb } = await renderTasks(user);
      await editText(ctx, body, kb);
      return;
    }
    if (section === "duties") {
      const { body, kb } = await renderDuties(user);
      await editText(ctx, body, kb);
      return;
    }
    let body = "";
    if (section === "dashboard") body = await renderDashboard(user);
    else if (section === "supplies") body = await renderSupplies(user);
    else if (section === "products") body = await renderProducts(user);
    else if (section === "finance") body = await renderFinance(user);
    else if (section === "team") body = await renderTeam(user);
    await editText(ctx, body, backKeyboard());
  } catch (e) {
    console.error(`[telegram] раздел ${section}:`, e);
    await editText(ctx, "⚠️ Не удалось загрузить раздел. Попробуйте ещё раз.", backKeyboard());
  }
}

// «В работу» — сразу; «Завершить» — только через отчёт (шаг await_task_report).
// Правила и уведомление руководству живут в data/tasks-core (общие с вебом и ИИ).
async function changeTaskStatus(
  ctx: Context,
  user: AuthedUser,
  taskId: string,
  action: string,
): Promise<void> {
  const actor = { id: user.id, name: user.name, role: user.role, roleLabel: user.roleLabel };

  if (action === "done") {
    if (ctx.chat?.id != null) {
      const sess = await readSession(ctx.chat.id);
      await writeSession(ctx.chat.id, { ...sess, step: "await_task_report", taskId });
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "✍️ Напишите <b>отчёт</b>: что именно сделано (можно голосовым).\n\n" +
        "<i>Без отчёта задача не закрывается — его увидят директор и старшие менеджеры.</i>",
      { parse_mode: "HTML" },
    );
    return;
  }

  if (action !== "start") {
    await ctx.answerCallbackQuery();
    return;
  }

  const result = await startTask(admin(), taskId, actor);
  if (!result.ok) {
    await ctx.answerCallbackQuery({ text: result.message, show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({ text: "Взято в работу ▶️" });
  const { body, kb } = await renderTasks(user);
  await editText(ctx, body, kb);
}

async function handleCallback(ctx: Context): Promise<void> {
  const tgId = ctx.from?.id;
  const data = ctx.callbackQuery?.data ?? "";
  if (!tgId) {
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Тестовый режим: выбор/смена сотрудника (до проверки «вошёл ли») ──
  if (data.startsWith("test:")) {
    if (!isTestTg(tgId) || ctx.chat?.id == null) {
      await ctx.answerCallbackQuery({ text: "Недоступно", show_alert: true });
      return;
    }
    if (data === "test:switch") {
      await ctx.answerCallbackQuery();
      const sess = await readSession(ctx.chat.id);
      await writeSession(ctx.chat.id, { step: "idle", aiHistory: sess.aiHistory }); // выбор снят
      const { body, kb } = await renderTestPicker();
      await editText(ctx, body, kb);
      return;
    }
    if (data.startsWith("test:pick:")) {
      const profileId = data.slice("test:pick:".length);
      await writeSession(ctx.chat.id, { step: "idle", testProfileId: profileId });
      const picked = await getTestUser(tgId);
      if (!picked) {
        await ctx.answerCallbackQuery({ text: "Сотрудник не найден", show_alert: true });
        await writeSession(ctx.chat.id, { step: "idle" });
        return;
      }
      await ctx.answerCallbackQuery({ text: `Вы — ${picked.name}` });
      await editText(ctx, greeting(picked, true), mainMenu(picked, true));
      return;
    }
    await ctx.answerCallbackQuery();
    return;
  }

  const user = await getLinkedUser(tgId);
  if (!user) {
    await ctx.answerCallbackQuery({ text: "Сессия истекла. Нажмите /start", show_alert: true });
    return;
  }
  const test = isTestTg(tgId);

  if (data === "action:logout") {
    await unlinkTelegram(tgId);
    if (ctx.chat?.id != null) await writeSession(ctx.chat.id, { step: "idle" });
    await ctx.answerCallbackQuery({ text: "Вы вышли" });
    await editText(ctx, "🚪 Вы вышли из аккаунта. Чтобы войти снова — /start");
    return;
  }

  if (data === "menu:home") {
    await ctx.answerCallbackQuery();
    await editText(ctx, greeting(user, test), mainMenu(user, test));
    return;
  }

  if (data === "menu:ai") {
    await ctx.answerCallbackQuery();
    await editText(
      ctx,
      [
        "🤖 <b>ИИ-помощник</b>",
        "",
        "Отдельно открывать меня не нужно: пишите или наговаривайте <b>голосовое</b> " +
          "в любой момент — отвечу по актуальным данным и выполню действие.",
        "",
        "<b>Спросить:</b>",
        "• Какой товар продаётся лучше всего?",
        "• Что скоро закончится на складах?",
        can(user.role, "finance:view") ? "• Выполняем ли план продаж?" : "• Какие у меня задачи сегодня?",
        "",
        "<b>Сделать:</b>",
        can(user.role, "team:manage")
          ? "• Поставь Назире задачу проверить SEO до среды"
          : "• Закрой задачу про отзывы, отчёт: обработала 34 отзыва",
        can(user.role, "team:manage") ? "• Что команда сделала сегодня?" : "• Какие у меня задачи?",
      ].join("\n"),
      backKeyboard(),
    );
    return;
  }

  if (data === "menu:pdf") {
    await ctx.answerCallbackQuery({ text: "Готовлю PDF…" });
    try {
      const pdf = await buildDailyReportPdf(admin(), {
        id: user.id,
        name: user.name,
        role: user.role,
        roleLabel: user.roleLabel,
      });
      await ctx.replyWithDocument(
        new InputFile(pdf, `WB-CRM-отчёт-${localIsoDate()}.pdf`),
        { caption: "📄 Сводка дня" },
      );
    } catch (e) {
      console.error("[telegram] PDF:", e);
      await ctx.reply("⚠️ Не удалось сформировать PDF, попробуйте позже.");
    }
    return;
  }

  if (data.startsWith("menu:")) {
    await showSection(ctx, user, data.slice("menu:".length));
    return;
  }

  if (data.startsWith("task:")) {
    const [, id, action] = data.split(":");
    await changeTaskStatus(ctx, user, id, action);
    return;
  }

  // «Выполнено» по задаче регламента → просим текст отчёта
  if (data.startsWith("duty:")) {
    const dutyId = data.slice("duty:".length);
    if (ctx.chat?.id != null) {
      const sess = await readSession(ctx.chat.id);
      await writeSession(ctx.chat.id, { ...sess, step: "await_duty_report", dutyId });
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "✍️ Напишите короткий отчёт по задаче (что сделано, цифры, проблемы) — одним сообщением:",
    );
    return;
  }

  await ctx.answerCallbackQuery();
}

// ───────────────────────── Фабрика бота ─────────────────────────

// Обёртка обработчика: только личные чаты + перехват ошибок (транзиентный сбой БД
// показывает «попробуйте ещё раз», а не выкидывает пользователя из аккаунта и не
// сливает данные в групповые чаты).
function guard(handler: (ctx: Context) => Promise<unknown>): (ctx: Context) => Promise<void> {
  return async (ctx) => {
    if (ctx.chat && ctx.chat.type !== "private") return; // бот работает только в личке
    try {
      await handler(ctx);
    } catch (e) {
      console.error("[telegram] ошибка обработчика:", e);
      try {
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({
            text: "⚠️ Временная ошибка, попробуйте ещё раз",
            show_alert: true,
          });
        } else {
          await ctx.reply("⚠️ Временная ошибка, попробуйте ещё раз.");
        }
      } catch {
        /* ignore */
      }
    }
  };
}

export function createBot(): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("Нет TELEGRAM_BOT_TOKEN в окружении (.env.local)");
  }
  const bot = new Bot(token);

  bot.catch((err) => {
    console.error("[telegram] необработанная ошибка:", err.error ?? err);
  });

  bot.command("start", guard(handleStart));
  bot.command("menu", guard(handleMenu));
  bot.command("logout", guard(handleLogout));
  bot.command("help", guard((ctx) => ctx.reply(HELP_TEXT, { parse_mode: "HTML" })));

  bot.on("callback_query:data", guard(handleCallback));
  bot.on("message:text", guard(handleText));
  // Голосовые/аудио/кружочки — распознаём и обрабатываем как обычное сообщение
  bot.on(["message:voice", "message:audio", "message:video_note"], guard(handleVoice));

  return bot;
}
