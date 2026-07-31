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
import {
  createCashTx,
  getCashOverview,
  getExpensesView,
  getFinanceRefs,
  getPnlView,
} from "../data/cash-core";
import { ensureDutyAssignments, localIsoDate } from "../data/duties-core";
import { completeTask, startTask } from "../data/tasks-core";
import { invalidateRemote } from "../data/revalidate-remote";
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

type Step =
  | "idle"
  | "await_login"
  | "await_password"
  | "await_duty_report"
  | "await_task_report"
  | "await_expense_amount" // мастер расхода: ждём сумму
  | "await_expense_note"; // мастер расхода: ждём комментарий
type SessionData = {
  step: Step;
  login?: string;
  fails?: number;
  lockUntil?: number;
  aiHistory?: ChatMessage[]; // короткая история диалога с ИИ
  dutyId?: string; // назначение регламента, по которому ждём текст отчёта
  taskId?: string; // задача, по которой ждём текст отчёта (отчёт обязателен)
  testProfileId?: string; // тестовый режим: под каким сотрудником смотрим бот
  expense?: ExpenseDraft; // черновик расхода (мастер «сумма → статья → счёт → коммент»)
};

// Черновик расхода живёт в сессии чата: мастер идёт в несколько сообщений,
// а бот может перезапуститься между ними (webhook/Railway).
type ExpenseDraft = {
  amount?: number;
  categoryId?: string;
  categoryName?: string;
  accountId?: string;
  accountName?: string;
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
    expense: d.expense,
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

// Текст от ИИ безопасно превращаем в Telegram-HTML: экранируем ВСЁ, затем
// возвращаем только разрешённые теги. Так случайная «<» в ответе модели не
// ломает сообщение (Telegram отвергает битый HTML целиком).
const TG_TAGS = ["b", "strong", "i", "em", "u", "s", "code"];
function sanitizeTgHtml(raw: string): string {
  let out = esc(raw);
  for (const tag of TG_TAGS) {
    out = out
      .replace(new RegExp(`&lt;${tag}&gt;`, "gi"), `<${tag}>`)
      .replace(new RegExp(`&lt;/${tag}&gt;`, "gi"), `</${tag}>`);
  }
  return out;
}

// Ответ ИИ с разметкой; при любой проблеме с HTML — отправляем чистым текстом,
// чтобы сообщение дошло в любом случае.
async function replyRich(
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  const body = text.slice(0, 3900);
  try {
    await ctx.reply(sanitizeTgHtml(body), {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    console.error("[telegram] HTML-ответ отклонён, шлю текстом:", e);
    await ctx.reply(body.replace(/<[^>]{1,20}>/g, ""), { reply_markup: keyboard });
  }
}

// ── Человеческие даты и приоритеты (читаемость списков) ────────────────────

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

// Разница в днях от сегодня (локальные сутки, пояс UTC+5/6)
function daysUntil(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const target = new Date(y, (m ?? 1) - 1, d ?? 1);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

// «⏰ сегодня» / «🔴 просрочено на 3 дн» / «⏰ до 27 июл»
function dueLabel(iso: string | null): string {
  if (!iso) return "";
  const diff = daysUntil(iso);
  if (diff < 0) return `🔴 просрочено на ${-diff} дн`;
  if (diff === 0) return "⏰ сегодня";
  if (diff === 1) return "⏰ завтра";
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `⏰ до ${d} ${MONTHS_SHORT[(m ?? 1) - 1]}`;
}

const PRIORITY_EMOJI: Record<string, string> = {
  urgent: "🔥",
  high: "❗️",
  normal: "▪️",
  low: "▫️",
};

// Обрезка длинного названия для кнопки (лимит Telegram — 64 символа)
function short(s: string, max = 28): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// Разделитель между смысловыми блоками сообщения
const RULE = "──────────";

function rub(n: number): string {
  return num(n) + " ₽";
}

// Количества тоже с разделителями разрядов: «131 809 шт», а не «131809 шт»
function num(n: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(n));
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

// Помощь под роль: показываем только те примеры, которые сотрудник реально
// может выполнить. Универсальный список раздражает («попробовал — нет прав»).
function helpText(user?: AuthedUser): string {
  const lines = [
    "🤖 <b>WB CRM — бот-помощник</b>",
    "",
    "Я понимаю обычную речь. <b>Пишите или наговаривайте голосовое</b> — " +
      "отвечу по свежим данным и сделаю дело в системе. Кнопки — просто быстрый путь.",
  ];

  if (user) {
    const ask: string[] = [];
    const act: string[] = [];

    if (can(user.role, "tasks:view")) {
      ask.push("«какие у меня задачи?»");
      act.push("«закрой задачу про фото — отчёт: обновил 5 карточек»");
    }
    if (can(user.role, "duty:complete")) {
      act.push("«отметь регламент по отзывам — обработала 34 отзыва»");
    }
    if (can(user.role, "products:view")) {
      ask.push("«что скоро закончится на складах?»");
      ask.push("«как продаётся пижама с длинным рукавом?»");
    }
    if (can(user.role, "finance:view")) ask.push("«выполняем ли план продаж?»");
    if (can(user.role, "finance:cash")) {
      ask.push("«сколько денег в кассе?»");
      ask.push("«какая прибыль за месяц?»");
    }
    if (can(user.role, "finance:expense")) {
      act.push("«потратил 15 тысяч на рекламу»");
      act.push("«пришло 800 тысяч от WB на расчётный счёт»");
    }
    if (can(user.role, "supply:view")) ask.push("«сколько потратили на закупку за месяц?»");
    if (can(user.role, "supply:pay")) {
      act.push("«запиши расход: 5 000 юаней за товар по поставке кимоно»");
    }
    if (can(user.role, "supply:receive")) {
      act.push("«прими поставку кимоно — пришло 480 из 500»");
    }
    if (can(user.role, "products:edit")) act.push("«поставь себестоимость 450 на пижаму»");
    if (can(user.role, "design:request")) act.push("«закажи дизайн слайдов для кимоно»");
    if (["owner", "admin", "manager"].includes(user.role)) {
      ask.push("«что команда сделала сегодня?»");
      act.push("«поставь Феликсу задачу обновить фото кимоно до пятницы»");
    }

    if (ask.length) lines.push("", "<b>Спросить:</b>", ...ask.slice(0, 4).map((s) => `• ${s}`));
    if (act.length) lines.push("", "<b>Сделать:</b>", ...act.slice(0, 4).map((s) => `• ${s}`));
  }

  lines.push(
    "",
    RULE,
    "",
    "<b>Команды:</b>",
    "/menu — главное меню",
    "/help — эта справка",
    "/logout — выйти из аккаунта",
  );
  return lines.join("\n");
}

// Приветствие + подсказка. Главная мысль, которую надо донести с первого экрана:
// кнопки — не единственный (и не основной) способ работы, бот сам по себе ИИ —
// можно просто написать или наговорить, что нужно.
function greeting(user: AuthedUser, test = false): string {
  const lines = [
    test
      ? `🧪 <b>Тестовый режим</b> — смотрите глазами <b>${esc(user.name)}</b>`
      : `👋 <b>${esc(user.name)}</b>`,
    `${esc(user.roleLabel)} · ${esc(user.orgName)}`,
  ];
  if (aiConfigured()) {
    lines.push(
      "",
      "💬 <b>Просто напишите или наговорите голосовое</b> — я пойму и сделаю:",
      "<i>«поставь Феликсу задачу обновить фото до пятницы»</i>",
      "<i>«оплатили фабрике 5000 юаней за пижамы»</i>",
      "<i>«что скоро закончится на складах?»</i>",
      "",
      RULE,
      "",
      "Или откройте раздел 👇",
    );
  } else {
    lines.push("", "Выберите раздел:");
  }
  return lines.join("\n");
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
      channel: "telegram", // короткие блоки, эмодзи, <b> вместо Markdown
      // Бот — отдельный процесс: сбросить кэш веба можно только по HTTP
      onMutation: () => void invalidateRemote(),
    });
  } catch (e) {
    console.error("[telegram] AI ошибка:", e);
    await ctx.reply("⚠️ ИИ-ассистент временно недоступен, попробуйте ещё раз.");
    return;
  }
  const newHistory = [...history, { role: "assistant" as const, content: reply }].slice(-10);
  await writeSession(chatId, { step: "idle", aiHistory: newHistory, testProfileId: sess.testProfileId });
  // Разметка модели пропускается через белый список тегов (см. replyRich)
  await replyRich(ctx, reply, new InlineKeyboard().text("📋 Меню", "menu:home"));
}

// Главное меню — только разделы, доступные роли (RBAC).
// Отдельной кнопки «ИИ-ассистент» нет намеренно: бот и ЕСТЬ ассистент — любое
// сообщение или голосовое уходит агенту. Кнопка была лишним шагом и создавала
// ложное впечатление, что ИИ живёт в отдельном режиме.
function mainMenu(user: AuthedUser, test = false): InlineKeyboard {
  const kb = new InlineKeyboard();

  // Личная работа — в одну колонку: сюда сотрудник заходит каждый день
  if (can(user.role, "duty:view")) kb.text("📋 Регламент на сегодня", "menu:duties").row();
  if (can(user.role, "tasks:view")) kb.text("🗒 Мои задачи", "menu:tasks").row();

  // Справочные разделы — по два в ряд, чтобы меню помещалось на экран телефона
  const info: Array<[string, string]> = [];
  if (can(user.role, "dashboard:view")) info.push(["📊 Сводка", "menu:dashboard"]);
  if (can(user.role, "finance:view")) info.push(["💰 Финансы", "menu:finance"]);
  if (can(user.role, "products:view")) info.push(["📦 Товары", "menu:products"]);
  if (can(user.role, "supply:view")) info.push(["🚚 Поставки", "menu:supplies"]);
  if (can(user.role, "team:manage")) info.push(["👥 Команда", "menu:team"]);
  if (can(user.role, "dashboard:view")) info.push(["📄 Отчёт PDF", "menu:pdf"]);
  info.forEach(([label, data], i) => {
    kb.text(label, data);
    if (i % 2 === 1) kb.row();
  });
  if (info.length % 2 === 1) kb.row();

  // Служебное — мелким рядом внизу, чтобы не конкурировало с рабочими кнопками
  kb.text("❓ Помощь", "menu:help");
  if (test) kb.text("🔄 Сменить", "test:switch");
  kb.text("🚪 Выйти", "action:logout");
  return kb;
}

function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("⬅️ В меню", "menu:home");
}

// Клавиатура раздела с данными: «Обновить» перечитывает раздел, не гоняя
// сотрудника через главное меню.
function sectionKeyboard(section: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Обновить", `menu:${section}`)
    .text("⬅️ В меню", "menu:home");
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
  const active = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  if (!active.length) {
    return {
      body: "🗒 <b>Мои задачи</b>\n\n✅ Открытых задач нет — можно выдохнуть 🙂",
      kb: backKeyboard(),
    };
  }

  // Группируем: сначала горит, потом в работе, потом остальное — так видно,
  // за что хвататься, без чтения всего списка.
  const overdue = active.filter((t) => t.due_date && daysUntil(t.due_date) < 0);
  const rest = active.filter((t) => !overdue.includes(t));
  const inProgress = rest.filter((t) => t.status === "in_progress");
  const open = rest.filter((t) => t.status === "open");

  const lines = [`🗒 <b>Мои задачи</b> · ${active.length}`];

  const block = (title: string, items: TaskRow[]) => {
    if (!items.length) return;
    lines.push("", title);
    for (const t of items) {
      const meta = [dueLabel(t.due_date), t.product?.title ? `📦 ${esc(t.product.title)}` : ""]
        .filter(Boolean)
        .join(" · ");
      lines.push("", `${PRIORITY_EMOJI[t.priority] ?? "▪️"} <b>${esc(t.title)}</b>`);
      if (meta) lines.push(`     ${meta}`);
    }
  };

  block(`🔴 <b>ПРОСРОЧЕНО</b> — ${overdue.length}`, overdue);
  block(`🟡 <b>В РАБОТЕ</b> — ${inProgress.length}`, inProgress);
  block(`🔵 <b>ОТКРЫТЫЕ</b> — ${open.length}`, open);

  lines.push("", RULE, "<i>Кнопки ниже. При закрытии попрошу отчёт — можно голосовым.</i>");

  // Кнопки подписаны названием задачи, а не «#1» — не надо сверяться со списком
  const kb = new InlineKeyboard();
  for (const t of [...overdue, ...inProgress, ...open]) {
    const label = short(t.title);
    if (t.status === "open") kb.text(`▶️ ${label}`, `task:${t.id}:start`).row();
    else kb.text(`✅ ${label}`, `task:${t.id}:done`).row();
  }
  kb.text("🔄 Обновить", "menu:tasks").text("⬅️ В меню", "menu:home");
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
    `🛒 Заказы — <b>${num(o7qty)}</b> шт · ${rub(o7sum)}`,
    `💰 Продажи — <b>${num(Number(s7row?.qty ?? 0))}</b> шт · ${rub(Number(s7row?.sum_rub ?? 0))}`,
    `📈 Выкуп — <b>${buyout(o7qty, Number(s7row?.qty ?? 0))}%</b>`,
    "",
    RULE,
    "",
    "<b>За 30 дней</b>",
    `🛒 Заказы — <b>${num(o30qty)}</b> шт · ${rub(o30sum)}`,
    `💰 Продажи — <b>${num(Number(s30row?.qty ?? 0))}</b> шт · ${rub(Number(s30row?.sum_rub ?? 0))}`,
    `📈 Выкуп — <b>${buyout(o30qty, Number(s30row?.qty ?? 0))}%</b>`,
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
  const done = rows.filter((r) => r.status === "done");
  const left = rows.filter((r) => r.status !== "done");
  const lines = [`📋 <b>Регламент сегодня</b> · сделано ${done.length} из ${rows.length}`];

  if (left.length) {
    lines.push("", "<b>ОСТАЛОСЬ</b>");
    for (const r of left) {
      const dueMs = new Date(r.due_at).getTime();
      const time = new Date(r.due_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      const late = dueMs < Date.now();
      const mins = Math.round((dueMs - Date.now()) / 60_000);
      const when = late
        ? "🔴 срок вышел"
        : mins <= 60
          ? `⏰ осталось ${mins} мин`
          : `⏰ до ${time}`;
      lines.push("", `${late ? "🔴" : "🔵"} <b>${esc(dutyTitle(r))}</b>`, `     ${when}`);
    }
  }
  if (done.length) {
    lines.push("", "<b>ГОТОВО</b>");
    for (const r of done) lines.push(`✅ <s>${esc(dutyTitle(r))}</s>`);
  }
  lines.push("", RULE, "<i>Нажмите «Выполнено» — попрошу короткий отчёт (можно голосовым).</i>");

  const kb = new InlineKeyboard();
  for (const r of left) {
    kb.text(`✅ ${short(dutyTitle(r))}`, `duty:${r.id}`).row();
  }
  kb.text("🔄 Обновить", "menu:duties").text("⬅️ В меню", "menu:home");
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

  const lines = ["🚚 <b>Поставки</b>", "", "<b>ПО СТАТУСАМ</b>"];
  Object.entries(counts).forEach(([st, n]) =>
    lines.push(`${SUPPLY_STATUS_LABELS[st] ?? st} — <b>${n}</b>`),
  );
  lines.push("", RULE, "", "<b>ПОСЛЕДНИЕ ОТГРУЗКИ</b>");
  rows.slice(0, 8).forEach((r) => {
    const extra =
      r.eff === "in_transit"
        ? `🕐 ${daysSince(r.ship_date)} дн в пути`
        : r.received_qty != null && r.received_qty < r.quantity
          ? `⚠️ недостача ${r.quantity - r.received_qty} шт`
          : "";
    lines.push("", `📦 <b>${esc(r.title)}</b> — ${num(r.quantity)} шт`);
    lines.push(`     ${SUPPLY_STATUS_LABELS[r.eff] ?? r.eff}${extra ? ` · ${extra}` : ""}`);
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
  const lines = [`📦 <b>Товары</b> · показано ${rows.length}`, ""];
  rows.forEach((p) => {
    const meta = [
      p.status ? esc(p.status) : "",
      p.cost_price != null ? `себест. ${rub(Number(p.cost_price))}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`📦 <b>${esc(p.title)}</b>`);
    if (meta) lines.push(`     ${meta}`);
    lines.push("");
  });
  lines.push(RULE, "<i>Подробные цифры по товару — спросите текстом или голосом.</i>");
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

  // Светофор по выполнению плана — видно с одного взгляда
  const mark = pct >= 100 ? "🟢" : pct >= 90 ? "🟡" : "🔴";
  return [
    "💰 <b>Финансы · план WB</b>",
    `<i>${esc(start)} — ${esc(end)}</i>`,
    "",
    `${mark} Выполнение на сегодня — <b>${pct}%</b>`,
    "",
    `🎯 План на период — ${rub(amount)}`,
    `✅ Факт с начала — <b>${rub(fact)}</b>`,
    "",
    RULE,
    "",
    `📅 Сегодня продано — <b>${rub(todayFact)}</b>`,
    `     план ${rub(dailyPlan)}/день`,
    "",
    `🚀 Нужно в день до конца — <b>${rub(needDaily)}</b>`,
  ].join("\n");
}

// ── Финансы: подменю (план WB · прибыль · касса · расходы · записать расход) ──

function financeMenu(user: AuthedUser): InlineKeyboard {
  const kb = new InlineKeyboard().text("🎯 План WB", "fin:plan").row();
  if (can(user.role, "finance:cash")) {
    kb.text("📊 Прибыль (ОПиУ)", "fin:pnl").row();
    kb.text("👛 Касса — сколько денег", "fin:cash").row();
    kb.text("🧾 Расходы за месяц", "fin:expenses").row();
  }
  if (can(user.role, "finance:expense")) {
    kb.text("➕ Записать расход", "fin:add").row();
  }
  kb.text("⬅️ В меню", "menu:home");
  return kb;
}

// Короткая сводка: выполнение плана + деньги и расходы месяца (по правам)
async function renderFinanceHome(user: AuthedUser): Promise<string> {
  const lines = ["💰 <b>Финансы</b>"];

  const plan = await financePlanShort();
  if (plan) {
    lines.push("", `${plan.mark} План WB — <b>${plan.pct}%</b> на сегодня`, `     факт ${rub(plan.fact)} из ${rub(plan.amount)}`);
  }

  if (can(user.role, "finance:cash")) {
    const [cash, expenses] = await Promise.all([
      getCashOverview(admin()).catch(() => null),
      getExpensesView(admin()).catch(() => null),
    ]);
    if (cash) {
      lines.push("", RULE, "", `👛 Денег в кассе — <b>${rub(cash.totalRub)}</b>`);
      if (cash.accounts.length === 0) {
        lines.push("     <i>счета не заведены — CRM → Финансы → Касса</i>");
      }
    }
    if (expenses) {
      lines.push(`🧾 Расходы за месяц — <b>${rub(expenses.totalRub)}</b>`);
    }
  }

  lines.push("", RULE, "<i>Выберите раздел кнопкой ниже. Расход можно просто продиктовать: «отдал 15 тысяч за рекламу».</i>");
  return lines.join("\n");
}

// Выполнение плана WB одной строкой (нужно и в сводке, и в разделе)
async function financePlanShort(): Promise<
  { pct: number; mark: string; fact: number; amount: number } | null
> {
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
  if (!plan) return null;

  const start = plan.period_start as string;
  const end = plan.period_end as string;
  const amount = Number(plan.amount_rub);
  const { data: daily } = await admin().rpc("agg_sales_daily", {
    p_store: DEMO_STORE_ID,
    p_since: `${start}T00:00:00`,
  });
  const fact = ((daily ?? []) as { sum_rub: number }[]).reduce((t, r) => t + Number(r.sum_rub), 0);
  const totalDays = Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000) + 1);
  const passed = Math.max(1, Math.round((new Date(today).getTime() - new Date(start).getTime()) / 86_400_000) + 1);
  const planToDate = Math.round((amount / totalDays) * passed);
  const pct = planToDate ? Math.round((fact / planToDate) * 100) : 0;
  return { pct, mark: pct >= 100 ? "🟢" : pct >= 90 ? "🟡" : "🔴", fact, amount };
}

// ОПиУ за 3 месяца: сколько реально заработали
async function renderPnl(): Promise<string> {
  const view = await getPnlView(admin(), 3);
  const t = view.total;
  const mark = t.netRub >= 0 ? "🟢" : "🔴";

  const lines = [
    "📊 <b>Прибыль за 3 месяца</b>",
    "",
    `${mark} Чистая прибыль — <b>${rub(t.netRub)}</b>`,
    `     рентабельность ${t.marginPct}%`,
    "",
    RULE,
    "",
    `💵 Выручка — ${rub(t.revenueRub)}`,
    `➖ Удержания WB — ${rub(t.wbFeesRub)}`,
    `➖ Себестоимость — ${rub(t.cogsRub)}`,
    `➖ Расходы компании — ${rub(t.opexRub)}`,
  ];
  if (t.otherIncomeRub > 0) lines.push(`➕ Прочие доходы — ${rub(t.otherIncomeRub)}`);

  lines.push("", RULE, "", "<b>ПО МЕСЯЦАМ</b>");
  for (const m of view.months) {
    const sign = m.netRub >= 0 ? "🟢" : "🔴";
    lines.push("", `${sign} <b>${esc(m.label)}</b> — ${rub(m.netRub)}`, `     выручка ${rub(m.revenueRub)} · ${m.marginPct}%`);
  }

  // Без этих оговорок цифра прибыли обманывает — предупреждаем прямо в чате
  const notes: string[] = [];
  if (view.costCoveragePct < 95) {
    notes.push(`⚠️ Себестоимость заполнена у ${view.costCoveragePct}% продаж — прибыль завышена.`);
  }
  if (!view.hasExpenses) {
    notes.push("⚠️ Расходы не внесены — прибыль без рекламы, зарплат и налогов.");
  }
  if (notes.length) lines.push("", RULE, "", ...notes);
  return lines.join("\n");
}

const ACCOUNT_EMOJI: Record<string, string> = {
  cash: "💵",
  bank: "🏦",
  card: "💳",
  wb: "🟣",
  other: "👛",
};

async function renderCash(): Promise<string> {
  const view = await getCashOverview(admin());
  if (!view.accounts.length) {
    return (
      "👛 <b>Касса</b>\n\nСчета не заведены.\n" +
      "Добавьте их в CRM → Финансы → Касса → «Новый счёт» и укажите, сколько денег есть сейчас."
    );
  }

  const net = view.monthInRub - view.monthOutRub;
  const lines = [
    "👛 <b>Касса</b>",
    "",
    `💰 Всего денег — <b>${rub(view.totalRub)}</b>`,
    "",
    RULE,
    "",
    "<b>ПО СЧЕТАМ</b>",
  ];
  for (const a of view.accounts) {
    const emoji = ACCOUNT_EMOJI[a.kind] ?? "👛";
    const amount = a.currency === "rub" ? rub(a.balance) : `${num(a.balance)} ${a.currency === "cny" ? "¥" : "сум"}`;
    lines.push("", `${emoji} <b>${esc(a.name)}</b> — ${amount}`);
    if (a.currency !== "rub") lines.push(`     ≈ ${rub(a.balanceRub)}`);
  }

  lines.push(
    "",
    RULE,
    "",
    "<b>ЭТОТ МЕСЯЦ</b>",
    `📥 Пришло — ${rub(view.monthInRub)}`,
    `📤 Ушло — ${rub(view.monthOutRub)}`,
    `${net >= 0 ? "🟢" : "🔴"} Итог — <b>${net >= 0 ? "+" : ""}${rub(net)}</b>`,
  );

  if (view.recent.length) {
    lines.push("", RULE, "", "<b>ПОСЛЕДНИЕ ОПЕРАЦИИ</b>");
    for (const t of view.recent.slice(0, 5)) {
      const icon = t.kind === "in" ? "📥" : t.kind === "out" ? "📤" : "🔁";
      const what =
        t.kind === "transfer"
          ? `перевод → ${esc(t.toAccountName ?? "—")}`
          : esc(t.categoryName ?? (t.kind === "in" ? "поступление" : "расход"));
      lines.push("", `${icon} ${what} — <b>${rub(t.amountRub)}</b>`, `     ${esc(humanDate(t.occurredOn))} · ${esc(t.accountName)}`);
    }
  }
  return lines.join("\n");
}

// «31 июля» вместо «2026-07-31» — так читается с телефона
function humanDate(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS_SHORT[(m ?? 1) - 1]}`;
}

async function renderExpenses(): Promise<string> {
  const view = await getExpensesView(admin());
  if (!view.items.length) {
    return (
      "🧾 <b>Расходы за месяц</b>\n\nЗаписей пока нет.\n" +
      "Нажмите «➕ Записать расход» или просто напишите: <i>«потратил 15 тысяч на рекламу»</i>."
    );
  }

  const lines = [
    "🧾 <b>Расходы за месяц</b>",
    "",
    `💸 Всего — <b>${rub(view.totalRub)}</b> · ${view.items.length} операций`,
    "",
    RULE,
    "",
    "<b>ПО СТАТЬЯМ</b>",
  ];
  for (const c of view.categories.slice(0, 8)) {
    lines.push("", `${c.emoji ?? "▪️"} <b>${esc(c.name)}</b> — ${rub(c.amountRub)}`, `     ${c.sharePct}% расходов · ${c.txCount} оп.`);
  }

  lines.push("", RULE, "", "<b>ПОСЛЕДНИЕ</b>");
  for (const t of view.items.slice(0, 6)) {
    lines.push(
      "",
      `📤 <b>${esc(t.categoryName ?? "Без статьи")}</b> — ${rub(t.amountRub)}`,
      `     ${esc(humanDate(t.occurredOn))}${t.note ? ` · ${esc(short(t.note, 40))}` : ""}${t.authorName ? ` · ${esc(t.authorName)}` : ""}`,
    );
  }
  return lines.join("\n");
}

// ── Мастер расхода: сумма → статья → счёт → комментарий ──────────────────────

// «25 000», «25к», «25 тыс», «1.5 млн» — как пишут в чате
function parseAmount(raw: string): number | null {
  const text = raw.toLowerCase().replace(/\s/g, "").replace(",", "."); // \s покрывает и неразрывный пробел
  const m = text.match(/(\d+(?:\.\d+)?)(к|k|тыс|тысяч|млн|млнов)?/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const suffix = m[2] ?? "";
  const mult = suffix.startsWith("млн") ? 1_000_000 : suffix ? 1_000 : 1;
  return value * mult;
}

async function expenseCategoryKeyboard(): Promise<InlineKeyboard> {
  const { categories } = await getFinanceRefs(admin());
  const kb = new InlineKeyboard();
  for (const c of categories.filter((x) => x.direction === "out")) {
    kb.text(`${c.emoji ?? "▪️"} ${short(c.name, 24)}`, `fin:cat:${c.id}`).row();
  }
  kb.text("✖️ Отмена", "fin:cancel");
  return kb;
}

async function expenseAccountKeyboard(): Promise<InlineKeyboard> {
  const { accounts } = await getFinanceRefs(admin());
  const kb = new InlineKeyboard();
  for (const a of accounts) {
    const cur = a.currency === "rub" ? "" : a.currency === "cny" ? " ¥" : " сум";
    kb.text(`${ACCOUNT_EMOJI[a.kind] ?? "👛"} ${short(a.name, 22)}${cur}`, `fin:acc:${a.id}`).row();
  }
  kb.text("✖️ Отмена", "fin:cancel");
  return kb;
}

// Финальная запись расхода из черновика сессии
async function saveExpenseDraft(
  user: AuthedUser,
  draft: ExpenseDraft,
  note: string | null,
): Promise<string> {
  if (!draft.amount || !draft.categoryId || !draft.accountId) {
    return "⚠️ Черновик расхода потерялся. Начните заново: /menu → 💰 Финансы → ➕ Записать расход.";
  }
  const result = await createCashTx(
    admin(),
    { id: user.id, name: user.name, role: user.role, roleLabel: user.roleLabel },
    {
      kind: "out",
      accountId: draft.accountId,
      categoryId: draft.categoryId,
      amount: draft.amount,
      note,
      source: "bot",
    },
  );
  if (!result.ok) return `⚠️ ${esc(result.message)}`;
  void invalidateRemote();
  return [
    "✅ <b>Расход записан</b>",
    "",
    `💸 ${rub(result.amountRub)} · ${esc(draft.categoryName ?? "статья")}`,
    `👛 Счёт: ${esc(draft.accountName ?? "—")}`,
    note ? `📝 ${esc(note)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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
  const lines = [`👥 <b>Команда</b> · ${rows.length} чел.`, ""];
  rows.forEach((m) => {
    const label = ROLE_LABELS[m.role as MemberRole] ?? m.role;
    lines.push(`👤 <b>${esc(m.profile?.full_name ?? "—")}</b>`);
    lines.push(
      `     ${esc(label)}${m.profile?.login ? ` · вход: <code>${esc(m.profile.login)}</code>` : ""}`,
    );
    lines.push("");
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

// Справка знает, кто спрашивает: примеры подбираются под права роли.
async function handleHelp(ctx: Context): Promise<void> {
  const tgId = ctx.from?.id;
  const user = tgId ? await getLinkedUser(tgId) : null;
  await ctx.reply(helpText(user ?? undefined), {
    parse_mode: "HTML",
    reply_markup: user ? backKeyboard() : undefined,
    link_preview_options: { is_disabled: true },
  });
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
      if (result.ok) void invalidateRemote();
      await writeSession(chatId, { step: "idle", aiHistory: sess0.aiHistory, testProfileId: sess0.testProfileId });
      await ctx.reply(result.ok ? `✅ ${esc(result.message)}` : `⚠️ ${esc(result.message)}`, { parse_mode: "HTML" });
      const { body, kb } = await renderTasks(linked);
      await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
      return;
    }

    // Мастер расхода: сумма (текстом или голосом) → выбор статьи кнопками
    if (sess0.step === "await_expense_amount") {
      const amount = parseAmount(text);
      if (!amount) {
        await ctx.reply(
          "Не понял сумму. Напишите числом — например <code>25000</code> или <code>25 тыс</code>.",
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✖️ Отмена", "fin:cancel") },
        );
        return;
      }
      await writeSession(chatId, { ...sess0, expense: { ...sess0.expense, amount } });
      await ctx.reply(`💸 <b>${rub(amount)}</b>\n\nНа что потратили?`, {
        parse_mode: "HTML",
        reply_markup: await expenseCategoryKeyboard(),
      });
      return;
    }

    // Мастер расхода: комментарий — последний шаг, сразу пишем в кассу
    if (sess0.step === "await_expense_note") {
      const draft = sess0.expense ?? {};
      await writeSession(chatId, {
        step: "idle",
        aiHistory: sess0.aiHistory,
        testProfileId: sess0.testProfileId,
      });
      const body = await saveExpenseDraft(linked, draft, text.trim() || null);
      await ctx.reply(body, { parse_mode: "HTML", reply_markup: financeMenu(linked) });
      return;
    }

    // Отчёт по задаче регламента
    if (sess0.step === "await_duty_report" && sess0.dutyId) {
      if (!text) {
        await ctx.reply("Отчёт не может быть пустым — напишите пару предложений.");
        return;
      }
      const result = await completeDuty(linked, sess0.dutyId, text.slice(0, 2000));
      void invalidateRemote();
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
    // Финансы — не один экран, а подменю: план WB, прибыль, касса, расходы
    if (section === "finance") {
      await editText(ctx, await renderFinanceHome(user), financeMenu(user));
      return;
    }
    let body = "";
    if (section === "dashboard") body = await renderDashboard(user);
    else if (section === "supplies") body = await renderSupplies(user);
    else if (section === "products") body = await renderProducts(user);
    else if (section === "team") body = await renderTeam(user);
    await editText(ctx, body, sectionKeyboard(section));
  } catch (e) {
    console.error(`[telegram] раздел ${section}:`, e);
    await editText(ctx, "⚠️ Не удалось загрузить раздел. Попробуйте ещё раз.", backKeyboard());
  }
}

// Разделы финансов и мастер расхода «сумма → статья → счёт → комментарий».
// Каждый шаг проверяет право заново: кнопка могла остаться в старом сообщении.
async function handleFinanceCallback(
  ctx: Context,
  user: AuthedUser,
  action: string,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const needCash = () => can(user.role, "finance:cash");
  const needEdit = () => can(user.role, "finance:expense");

  try {
    if (action === "plan") {
      await ctx.answerCallbackQuery();
      await editText(ctx, await renderFinance(user), financeMenu(user));
      return;
    }
    if (action === "pnl" || action === "cash" || action === "expenses") {
      if (!needCash()) {
        await ctx.answerCallbackQuery({ text: "Нет доступа к этому разделу", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery();
      const body =
        action === "pnl" ? await renderPnl() : action === "cash" ? await renderCash() : await renderExpenses();
      await editText(ctx, body, financeMenu(user));
      return;
    }

    if (action === "cancel") {
      if (chatId != null) {
        const sess = await readSession(chatId);
        await writeSession(chatId, {
          step: "idle",
          aiHistory: sess.aiHistory,
          testProfileId: sess.testProfileId,
        });
      }
      await ctx.answerCallbackQuery({ text: "Отменено" });
      await editText(ctx, await renderFinanceHome(user), financeMenu(user));
      return;
    }

    if (!needEdit()) {
      await ctx.answerCallbackQuery({ text: "Нет права вносить расходы", show_alert: true });
      return;
    }

    // Старт мастера: спрашиваем сумму
    if (action === "add") {
      if (chatId != null) {
        const sess = await readSession(chatId);
        await writeSession(chatId, { ...sess, step: "await_expense_amount", expense: {} });
      }
      await ctx.answerCallbackQuery();
      await ctx.reply(
        "💸 <b>Новый расход</b>\n\nСколько потратили? Напишите сумму — например <code>25000</code>, " +
          "<code>25 тыс</code> или <code>1.5 млн</code>.",
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✖️ Отмена", "fin:cancel") },
      );
      return;
    }

    // Выбрана статья → спрашиваем счёт
    if (action.startsWith("cat:")) {
      const categoryId = action.slice("cat:".length);
      if (chatId == null) return;
      const sess = await readSession(chatId);
      const { categories } = await getFinanceRefs(admin());
      const category = categories.find((c) => c.id === categoryId);
      if (!category || !sess.expense?.amount) {
        await ctx.answerCallbackQuery({ text: "Начните заново: ➕ Записать расход", show_alert: true });
        return;
      }
      await writeSession(chatId, {
        ...sess,
        expense: { ...sess.expense, categoryId, categoryName: category.name },
      });
      await ctx.answerCallbackQuery({ text: category.name });
      await editText(
        ctx,
        `💸 <b>${rub(sess.expense.amount)}</b> · ${esc(category.name)}\n\nС какого счёта платили?`,
        await expenseAccountKeyboard(),
      );
      return;
    }

    // Выбран счёт → просим комментарий (или пропускаем)
    if (action.startsWith("acc:")) {
      const accountId = action.slice("acc:".length);
      if (chatId == null) return;
      const sess = await readSession(chatId);
      const { accounts } = await getFinanceRefs(admin());
      const account = accounts.find((a) => a.id === accountId);
      if (!account || !sess.expense?.amount || !sess.expense.categoryId) {
        await ctx.answerCallbackQuery({ text: "Начните заново: ➕ Записать расход", show_alert: true });
        return;
      }
      await writeSession(chatId, {
        ...sess,
        step: "await_expense_note",
        expense: { ...sess.expense, accountId, accountName: account.name },
      });
      await ctx.answerCallbackQuery({ text: account.name });
      await editText(
        ctx,
        `💸 <b>${rub(sess.expense.amount)}</b> · ${esc(sess.expense.categoryName ?? "")}\n` +
          `👛 ${esc(account.name)}\n\nДобавьте комментарий (за что именно) — или пропустите.`,
        new InlineKeyboard()
          .text("⏭ Без комментария", "fin:save")
          .row()
          .text("✖️ Отмена", "fin:cancel"),
      );
      return;
    }

    // Записать без комментария
    if (action === "save") {
      if (chatId == null) return;
      const sess = await readSession(chatId);
      const draft = sess.expense ?? {};
      await writeSession(chatId, {
        step: "idle",
        aiHistory: sess.aiHistory,
        testProfileId: sess.testProfileId,
      });
      await ctx.answerCallbackQuery({ text: "Записываю…" });
      await editText(ctx, await saveExpenseDraft(user, draft, null), financeMenu(user));
      return;
    }

    await ctx.answerCallbackQuery();
  } catch (e) {
    console.error("[telegram] финансы:", e);
    await ctx.answerCallbackQuery({ text: "⚠️ Ошибка, попробуйте ещё раз", show_alert: true }).catch(() => {});
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
  void invalidateRemote();
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

  if (data === "menu:help") {
    await ctx.answerCallbackQuery();
    await editText(ctx, helpText(user), backKeyboard());
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

  // ── Финансы: разделы и мастер расхода ──
  if (data.startsWith("fin:")) {
    await handleFinanceCallback(ctx, user, data.slice("fin:".length));
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
  bot.command("help", guard(handleHelp));

  bot.on("callback_query:data", guard(handleCallback));
  bot.on("message:text", guard(handleText));
  // Голосовые/аудио/кружочки — распознаём и обрабатываем как обычное сообщение
  bot.on(["message:voice", "message:audio", "message:video_note"], guard(handleVoice));

  return bot;
}
