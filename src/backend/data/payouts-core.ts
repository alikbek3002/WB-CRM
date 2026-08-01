// Заявки на выплату — ЕДИНОЕ место правил для всех входов: веб, Telegram-бот,
// ИИ-ассистент.
//
// Путь денег наружу: сотрудник или закупщик просит → руководитель согласовывает
// → оплата. Оплата не отдельная сущность: она создаёт ту же операцию кассы
// (cash_tx), а для счетов фабрик — ещё и оплату поставки, поэтому долг фабрике
// и остаток денег пересчитываются сами.
//
// Чистый модуль (npm + относительные импорты) — работает и в Turbopack, и в tsx.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_ORG_ID, EXCHANGE_RATES, toRub } from "../../shared/constants";
import { can, ROLE_LABELS, type MemberRole } from "../../shared/rbac";
import type {
  Currency,
  PayoutKind,
  PayoutRequest,
  PayoutStatus,
  PayoutsView,
} from "../../shared/types";
import { notifyProfile, notifyRoles, tgEsc } from "../telegram/notify";
import { createCashTx, isoDay, listMembers, type CashActor } from "./cash-core";

export type PayoutActor = CashActor;

export type PayoutResult =
  | { ok: true; id: string; message: string }
  | {
      ok: false;
      code: "forbidden" | "invalid" | "not_found" | "conflict" | "db_error";
      message: string;
    };

const KIND_LABEL: Record<PayoutKind, string> = {
  salary: "зарплата",
  contractor: "подрядчик",
  factory: "счёт фабрики",
  reimbursement: "возмещение",
  other: "прочее",
};

export const PAYOUT_KIND_LABELS = KIND_LABEL;

export const PAYOUT_STATUS_LABELS: Record<PayoutStatus, string> = {
  pending: "ждёт решения",
  approved: "согласовано",
  rejected: "отклонено",
  paid: "выплачено",
  cancelled: "отменено",
};

const rubFmt = (n: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(n)) + " ₽";

const money = (amount: number, currency: Currency) => {
  const n = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(amount));
  if (currency === "rub") return `${n} ₽`;
  if (currency === "cny") return `${n} ¥`;
  if (currency === "kgs") return `${n} сом`;
  return `${n} сум`;
};

function first<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

const isLead = (role: MemberRole) => can(role, "payout:approve");

// ─── Чтение ──────────────────────────────────────────────────────────────────

const PAYOUT_SELECT =
  "id, kind, status, title, description, amount, currency, due_date, payee, payee_user_id, requester_id, " +
  "category_id, factory_id, supply_id, decided_at, decision_note, paid_at, created_at, " +
  "requester:profiles!payout_requests_requester_id_fkey(full_name), " +
  "decider:profiles!payout_requests_decided_by_fkey(full_name), " +
  "payee_user:profiles!payout_requests_payee_user_id_fkey(full_name), " +
  "category:expense_categories(name), factory:factories(name), supply:supplies(title), " +
  "account:cash_accounts(name)";

type PayoutRow = {
  id: string;
  kind: PayoutKind;
  status: PayoutStatus;
  title: string;
  description: string | null;
  amount: number;
  currency: Currency;
  due_date: string | null;
  payee: string | null;
  payee_user_id: string | null;
  requester_id: string;
  category_id: string | null;
  factory_id: string | null;
  supply_id: string | null;
  decided_at: string | null;
  decision_note: string | null;
  paid_at: string | null;
  created_at: string;
  requester: { full_name: string | null } | { full_name: string | null }[] | null;
  decider: { full_name: string | null } | { full_name: string | null }[] | null;
  payee_user: { full_name: string | null } | { full_name: string | null }[] | null;
  category: { name: string } | { name: string }[] | null;
  factory: { name: string } | { name: string }[] | null;
  supply: { title: string } | { title: string }[] | null;
  account: { name: string } | { name: string }[] | null;
};

function mapPayout(r: PayoutRow, roleByUser: Map<string, string>): PayoutRequest {
  const amount = Number(r.amount);
  return {
    id: String(r.id),
    kind: r.kind,
    status: r.status,
    title: String(r.title),
    description: r.description,
    amount,
    currency: r.currency,
    amountRub: toRub(amount, r.currency),
    dueDate: r.due_date,
    payee: r.payee ?? first(r.payee_user)?.full_name ?? null,
    payeeUserId: r.payee_user_id ? String(r.payee_user_id) : null,
    payeeUserName: first(r.payee_user)?.full_name ?? null,
    requesterId: String(r.requester_id),
    requesterName: first(r.requester)?.full_name ?? "—",
    requesterRole: roleByUser.get(String(r.requester_id)) ?? null,
    categoryId: r.category_id ? String(r.category_id) : null,
    categoryName: first(r.category)?.name ?? null,
    factoryId: r.factory_id ? String(r.factory_id) : null,
    factoryName: first(r.factory)?.name ?? null,
    supplyId: r.supply_id ? String(r.supply_id) : null,
    supplyTitle: first(r.supply)?.title ?? null,
    decidedByName: first(r.decider)?.full_name ?? null,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    paidAt: r.paid_at,
    paidAccountName: first(r.account)?.name ?? null,
    createdAt: String(r.created_at),
  };
}

// Список заявок. Руководитель видит все, остальные — только свои: заявка на
// выплату содержит суммы гонораров, это не общая информация.
export async function getPayouts(
  db: SupabaseClient,
  viewer: { id: string; role: MemberRole },
  limit = 200,
): Promise<PayoutsView> {
  let q = db
    .from("payout_requests")
    .select(PAYOUT_SELECT)
    .eq("org_id", DEMO_ORG_ID)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (!isLead(viewer.role)) q = q.eq("requester_id", viewer.id);

  const [{ data, error }, membersRes] = await Promise.all([
    q,
    db.from("org_members").select("user_id, role").eq("org_id", DEMO_ORG_ID),
  ]);
  if (error) throw error;

  const roleByUser = new Map(
    ((membersRes.data ?? []) as { user_id: string; role: string }[]).map((m) => [
      String(m.user_id),
      ROLE_LABELS[m.role as MemberRole] ?? m.role,
    ]),
  );

  const items = ((data ?? []) as unknown as PayoutRow[]).map((r) => mapPayout(r, roleByUser));
  const monthStart = isoDay(new Date(new Date().getFullYear(), new Date().getMonth(), 1));

  return {
    items,
    pendingCount: items.filter((i) => i.status === "pending").length,
    pendingRub: items
      .filter((i) => i.status === "pending")
      .reduce((t, i) => t + i.amountRub, 0),
    approvedRub: items
      .filter((i) => i.status === "approved")
      .reduce((t, i) => t + i.amountRub, 0),
    paidMonthRub: items
      .filter((i) => i.status === "paid" && (i.paidAt ?? "") >= monthStart)
      .reduce((t, i) => t + i.amountRub, 0),
  };
}

// ─── Создание ────────────────────────────────────────────────────────────────

export type PayoutInput = {
  kind: PayoutKind;
  title: string;
  amount: number;
  currency?: Currency;
  description?: string | null;
  payee?: string | null;
  payeeUserId?: string | null; // сотрудник-адресат: тогда выплата попадёт в его карточку
  dueDate?: string | null;
  categoryId?: string | null;
  factoryId?: string | null;
  supplyId?: string | null;
};

const TITLE_MAX = 140;
const TEXT_MAX = 1000;

export async function createPayoutRequest(
  db: SupabaseClient,
  actor: PayoutActor,
  input: PayoutInput,
): Promise<PayoutResult> {
  if (!can(actor.role, "payout:request")) {
    return { ok: false, code: "forbidden", message: "Нет права запрашивать выплаты." };
  }
  const title = String(input.title ?? "").trim();
  const amount = Number(input.amount);
  if (!title) return { ok: false, code: "invalid", message: "Напишите, за что выплата." };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: "invalid", message: "Сумма должна быть больше нуля." };
  }
  if (amount > 1_000_000_000) {
    return { ok: false, code: "invalid", message: "Слишком большая сумма — проверьте ввод." };
  }

  const currency: Currency =
    input.currency && EXCHANGE_RATES[input.currency] !== undefined ? input.currency : "rub";
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate ?? ""))
    ? String(input.dueDate)
    : null;

  // Адресат-сотрудник: проверяем, что он из этой команды, и подписываем имя —
  // иначе в списке заявок «кому» осталось бы пустым.
  let payeeUserId: string | null = null;
  let payeeUserName: string | null = null;
  if (input.payeeUserId) {
    const member = (await listMembers(db)).find((m) => m.id === String(input.payeeUserId));
    if (!member) {
      return { ok: false, code: "not_found", message: "Сотрудник не найден в команде." };
    }
    payeeUserId = member.id;
    payeeUserName = member.name;
  }

  const { data, error } = await db
    .from("payout_requests")
    .insert({
      org_id: DEMO_ORG_ID,
      kind: input.kind,
      status: "pending",
      requester_id: actor.id,
      payee: (input.payee ? String(input.payee) : payeeUserName)?.slice(0, 120) ?? null,
      payee_user_id: payeeUserId,
      title: title.slice(0, TITLE_MAX),
      description: input.description ? String(input.description).slice(0, TEXT_MAX) : null,
      amount,
      currency,
      due_date: dueDate,
      category_id: input.categoryId ?? null,
      factory_id: input.factoryId ?? null,
      supply_id: input.supplyId ?? null,
    })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, code: "db_error", message: error?.message ?? "Ошибка записи" };
  }

  // Руководству — сразу, иначе заявка «зависает» до случайного захода в CRM
  void notifyRoles(
    ["owner", "admin", "manager"],
    `💰 <b>Заявка на выплату</b> — ${tgEsc(money(amount, currency))}\n` +
      `«${tgEsc(title)}»\n` +
      `Тип: ${tgEsc(KIND_LABEL[input.kind])}\n` +
      `От: <b>${tgEsc(actor.name)}</b> (${tgEsc(actor.roleLabel)})` +
      (dueDate ? `\nОплатить до: <b>${tgEsc(dueDate)}</b>` : "") +
      (input.description ? `\n${tgEsc(String(input.description).slice(0, 300))}` : "") +
      `\n\nСогласовать: /menu → 💰 Финансы → 💸 Выплаты`,
  );

  return {
    ok: true,
    id: String(data.id),
    message: `Заявка на ${money(amount, currency)} отправлена руководителю.`,
  };
}

// ─── Решение по заявке ───────────────────────────────────────────────────────

async function loadPayout(db: SupabaseClient, id: string): Promise<PayoutRow | null> {
  const { data, error } = await db
    .from("payout_requests")
    .select(PAYOUT_SELECT)
    .eq("id", id)
    .eq("org_id", DEMO_ORG_ID)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as PayoutRow) ?? null;
}

export async function decidePayout(
  db: SupabaseClient,
  actor: PayoutActor,
  id: string,
  decision: "approve" | "reject",
  note?: string | null,
): Promise<PayoutResult> {
  if (!can(actor.role, "payout:approve")) {
    return { ok: false, code: "forbidden", message: "Решать по заявкам может только руководитель." };
  }
  const row = await loadPayout(db, id);
  if (!row) return { ok: false, code: "not_found", message: "Заявка не найдена." };
  if (row.status === "paid") {
    return { ok: false, code: "conflict", message: "Заявка уже оплачена." };
  }
  if (row.status !== "pending") {
    return { ok: false, code: "conflict", message: `Заявка уже ${PAYOUT_STATUS_LABELS[row.status]}.` };
  }

  const status: PayoutStatus = decision === "approve" ? "approved" : "rejected";
  const { error } = await db
    .from("payout_requests")
    .update({
      status,
      decided_by: actor.id,
      decided_at: new Date().toISOString(),
      decision_note: note ? String(note).slice(0, TEXT_MAX) : null,
    })
    .eq("id", id);
  if (error) return { ok: false, code: "db_error", message: error.message };

  void notifyProfile(
    String(row.requester_id),
    decision === "approve"
      ? `✅ <b>Выплата согласована</b>\n«${tgEsc(row.title)}» — ${tgEsc(money(Number(row.amount), row.currency))}\n` +
          `Согласовал: ${tgEsc(actor.name)}`
      : `❌ <b>Выплата отклонена</b>\n«${tgEsc(row.title)}» — ${tgEsc(money(Number(row.amount), row.currency))}\n` +
          `Решение: ${tgEsc(actor.name)}${note ? `\nПричина: ${tgEsc(String(note).slice(0, 300))}` : ""}`,
  );

  return {
    ok: true,
    id,
    message:
      decision === "approve"
        ? `«${row.title}» согласована. Осталось оплатить.`
        : `«${row.title}» отклонена.`,
  };
}

// Оплата заявки: одна операция кассы + (для счёта фабрики) оплата поставки.
// Права те же, что на кассу: платит тот, кто ведёт деньги.
export async function payPayout(
  db: SupabaseClient,
  actor: PayoutActor,
  id: string,
  accountId: string,
  opts?: { paidOn?: string | null; rateToRub?: number | null },
): Promise<PayoutResult> {
  if (!can(actor.role, "payout:approve") || !can(actor.role, "finance:expense")) {
    return { ok: false, code: "forbidden", message: "Оплачивать заявки может только руководитель." };
  }
  const row = await loadPayout(db, id);
  if (!row) return { ok: false, code: "not_found", message: "Заявка не найдена." };
  if (row.status === "paid") return { ok: false, code: "conflict", message: "Заявка уже оплачена." };
  if (row.status === "rejected" || row.status === "cancelled") {
    return { ok: false, code: "conflict", message: "Заявка отклонена — оплачивать нечего." };
  }

  const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(String(opts?.paidOn ?? ""))
    ? String(opts?.paidOn)
    : isoDay(new Date());

  // Статья: из заявки, иначе подбираем по типу — иначе расход повиснет «без статьи»
  let categoryId = row.category_id ? String(row.category_id) : null;
  if (!categoryId) {
    const wanted =
      row.kind === "salary"
        ? "Зарплата"
        : row.kind === "factory"
          ? "Закуп товара"
          : row.kind === "reimbursement"
            ? "Возмещение сотруднику"
            : "Подрядчики и услуги";
    const { data: cat } = await db
      .from("expense_categories")
      .select("id")
      .eq("org_id", DEMO_ORG_ID)
      .eq("direction", "out")
      .eq("name", wanted)
      .maybeSingle();
    categoryId = cat ? String(cat.id) : null;
  }

  // Кому эти деньги: явный адресат из заявки, иначе — сам заявитель, если
  // заявка про людей (зарплата, возмещение). Так выплата попадает в карточку
  // сотрудника без второго ввода данных.
  const personId =
    row.payee_user_id
      ? String(row.payee_user_id)
      : row.kind === "salary" || row.kind === "reimbursement"
        ? String(row.requester_id)
        : null;

  const tx = await createCashTx(db, actor, {
    kind: "out",
    accountId,
    categoryId,
    amount: Number(row.amount),
    occurredOn: paidOn,
    rateToRub: opts?.rateToRub ?? null,
    note: `Выплата по заявке: ${row.title}${row.payee ? ` · ${row.payee}` : ""}`,
    personId,
    source: "payout",
  });
  if (!tx.ok) return { ok: false, code: "db_error", message: tx.message };

  // Счёт фабрики закрывает долг по поставке — фиксируем это в её оплатах.
  // Зеркалить в кассу второй раз нельзя: деньги уже списаны операцией выше.
  if (row.kind === "factory" && row.supply_id) {
    const { error: payErr } = await db.from("supply_payments").insert({
      supply_id: row.supply_id,
      kind: "goods",
      amount: Number(row.amount),
      currency: row.currency,
      paid_at: paidOn,
      note: `Заявка на выплату: ${row.title}`,
      created_by: actor.id,
    });
    if (payErr) console.error("[payouts] оплата поставки:", payErr.message);
  }

  const { error } = await db
    .from("payout_requests")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      paid_tx_id: tx.id,
      paid_account_id: accountId,
      // Оплата без отдельного согласования = согласие того, кто платит
      decided_by: row.decided_at ? undefined : actor.id,
      decided_at: row.decided_at ?? new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { ok: false, code: "db_error", message: error.message };

  // Адресату о деньгах уже написала касса (createCashTx) — второй раз не дублируем
  if (personId !== String(row.requester_id)) {
    void notifyProfile(
      String(row.requester_id),
      `💸 <b>Выплата произведена</b>\n«${tgEsc(row.title)}» — ${tgEsc(money(Number(row.amount), row.currency))}\n` +
        `Выплатил: ${tgEsc(actor.name)} · ${tgEsc(paidOn)}`,
    );
  }

  return {
    ok: true,
    id,
    message: `«${row.title}» оплачена: ${money(Number(row.amount), row.currency)} (${rubFmt(tx.amountRub)}).`,
  };
}

// Отменить свою заявку (пока по ней нет решения)
export async function cancelPayout(
  db: SupabaseClient,
  actor: PayoutActor,
  id: string,
): Promise<PayoutResult> {
  const row = await loadPayout(db, id);
  if (!row) return { ok: false, code: "not_found", message: "Заявка не найдена." };
  if (String(row.requester_id) !== actor.id && !can(actor.role, "payout:approve")) {
    return { ok: false, code: "forbidden", message: "Отменить можно только свою заявку." };
  }
  if (row.status === "paid") {
    return { ok: false, code: "conflict", message: "Оплаченную заявку отменить нельзя." };
  }
  const { error } = await db
    .from("payout_requests")
    .update({ status: "cancelled" })
    .eq("id", id);
  if (error) return { ok: false, code: "db_error", message: error.message };
  return { ok: true, id, message: `Заявка «${row.title}» отменена.` };
}
