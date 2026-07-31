// Снимок бизнес-данных магазина для ИИ-ассистента — по ПРАВАМ роли.
// Чистый модуль: только supabase-js + rpc + относительные импорты чистых shared —
// поэтому одинаково работает и в Next (веб), и в tsx-боте (Telegram).
// Данные, которых роль не видит в интерфейсе, в снимок НЕ попадают.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "../../shared/constants";
import { can, type MemberRole } from "../../shared/rbac";
import { getCashOverview, getExpensesView, getPnlView } from "../data/cash-core";

export type SnapshotUser = {
  id: string;
  name: string;
  role: MemberRole;
  roleLabel: string;
  orgName: string;
};

function rub(n: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(n)) + " ₽";
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function localToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// Каждая секция изолирована: сбой одного запроса не рушит весь снимок.
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function buildSnapshot(
  db: SupabaseClient,
  user: SnapshotUser,
): Promise<string> {
  const since30 = isoDaysAgo(30);
  const sections: string[] = [];

  // ── Магазин: заказы/продажи/остаток за 30 дней ──
  if (can(user.role, "dashboard:view") || can(user.role, "products:view")) {
    const block = await safe(async () => {
      const [ordersRes, salesRes, whRes] = await Promise.all([
        db.rpc("agg_orders_daily", { p_store: DEMO_STORE_ID, p_since: since30 }),
        db.rpc("agg_sales_summary", { p_store: DEMO_STORE_ID, p_since: since30 }),
        db.rpc("agg_stock_by_warehouse", { p_store: DEMO_STORE_ID }),
      ]);
      const ordersQty = (ordersRes.data ?? []).reduce((t: number, r: { qty: number }) => t + Number(r.qty), 0);
      const ordersSum = (ordersRes.data ?? []).reduce((t: number, r: { sum_rub: number }) => t + Number(r.sum_rub), 0);
      const sales = ((salesRes.data ?? []) as { qty: number; sum_rub: number }[])[0];
      const salesQty = Number(sales?.qty ?? 0);
      const salesSum = Number(sales?.sum_rub ?? 0);
      const stockTotal = ((whRes.data ?? []) as { qty: number }[]).reduce((t, r) => t + Number(r.qty), 0);
      const buyout = ordersQty ? Math.round((salesQty / ordersQty) * 100) : 0;
      return [
        "МАГАЗИН (за 30 дней):",
        `- Заказы: ${ordersQty} шт на ${rub(ordersSum)}`,
        `- Продажи (выкупы): ${salesQty} шт на ${rub(salesSum)}`,
        `- Выкуп: ${buyout}%`,
        `- Остаток на складах WB: ${stockTotal} шт`,
      ].join("\n");
    }, "");
    if (block) sections.push(block);
  }

  // ── Товары: лидеры и слабые ──
  if (can(user.role, "products:view")) {
    const block = await safe(async () => {
      const [prodRes, salesNmRes, stockRes] = await Promise.all([
        db.from("products").select("id, nm_id, title, category").eq("store_id", DEMO_STORE_ID).limit(1000),
        db.rpc("agg_sales_by_nm", { p_store: DEMO_STORE_ID, p_since: since30 }),
        db.rpc("agg_stock_by_product", { p_store: DEMO_STORE_ID }),
      ]);
      const salesByNm = new Map(
        ((salesNmRes.data ?? []) as { nm_id: number; cnt: number }[]).map((r) => [Number(r.nm_id), Number(r.cnt)]),
      );
      const stockById = new Map(
        ((stockRes.data ?? []) as { product_id: string; on_stock: number }[]).map((r) => [r.product_id, Number(r.on_stock)]),
      );
      const items = ((prodRes.data ?? []) as { id: string; nm_id: number; title: string; category: string | null }[]).map((p) => {
        const sales30 = salesByNm.get(Number(p.nm_id)) ?? 0;
        const stock = stockById.get(p.id) ?? 0;
        const avg = sales30 / 30;
        const cover = avg > 0 ? Math.round(stock / avg) : null;
        return { title: p.title, category: p.category ?? "—", sales30, stock, cover };
      });
      const top = [...items].sort((a, b) => b.sales30 - a.sales30).slice(0, 8);
      const weak = items.filter((i) => i.sales30 < 60).sort((a, b) => a.sales30 - b.sales30).slice(0, 6);
      const lowCover = items
        .filter((i) => i.cover !== null && i.cover < 14 && i.sales30 > 0)
        .sort((a, b) => (a.cover ?? 0) - (b.cover ?? 0))
        .slice(0, 6);
      const lines = [`ТОВАРЫ (всего ${items.length}):`, "Лидеры продаж (30д):"];
      top.forEach((p) => lines.push(`- ${p.title} · ${p.sales30} продаж · остаток ${p.stock} шт${p.cover !== null ? ` · хватит на ${p.cover} дн` : ""}`));
      if (weak.length) {
        lines.push("Слабые товары (мало продаж):");
        weak.forEach((p) => lines.push(`- ${p.title} · ${p.sales30} продаж · остаток ${p.stock} шт`));
      }
      if (lowCover.length) {
        lines.push("Скоро закончатся (<14 дней):");
        lowCover.forEach((p) => lines.push(`- ${p.title} · остаток ${p.stock} шт · хватит на ${p.cover} дн`));
      }
      return lines.join("\n");
    }, "");
    if (block) sections.push(block);
  }

  // ── Финансы: план/факт (только finance:view) ──
  if (can(user.role, "finance:view")) {
    const block = await safe(async () => {
      const today = localToday();
      const { data: plans } = await db
        .from("sales_plans")
        .select("period_start, period_end, amount_rub")
        .eq("store_id", DEMO_STORE_ID)
        .order("period_start", { ascending: false })
        .limit(5);
      const active =
        (plans ?? []).find((p) => (p.period_start as string) <= today && today <= (p.period_end as string)) ??
        (plans ?? [])[0];
      if (!active) return "ФИНАНСЫ: план продаж не задан.";
      const start = active.period_start as string;
      const end = active.period_end as string;
      const amount = Number(active.amount_rub);
      const { data: daily } = await db.rpc("agg_sales_daily", { p_store: DEMO_STORE_ID, p_since: `${start}T00:00:00` });
      const fact = ((daily ?? []) as { sum_rub: number }[]).reduce((t, r) => t + Number(r.sum_rub), 0);
      const totalDays = Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000) + 1);
      const passed = Math.max(1, Math.round((new Date(today).getTime() - new Date(start).getTime()) / 86_400_000) + 1);
      const planToDate = Math.round((amount / totalDays) * passed);
      const pct = planToDate > 0 ? Math.round((fact / planToDate) * 100) : 0;
      const needDaily = Math.max(0, Math.round((amount - fact) / Math.max(1, totalDays - passed)));
      return [
        `ФИНАНСЫ (план WB ${start}–${end}):`,
        `- План на период: ${rub(amount)}`,
        `- Факт продаж с начала периода: ${rub(fact)}`,
        `- Выполнение плана на сегодня: ${pct}%`,
        `- Нужно продавать в день до конца: ${rub(needDaily)}`,
      ].join("\n");
    }, "");
    if (block) sections.push(block);
  }

  // ── Деньги компании: касса, расходы, прибыль (finance:cash) ──
  // Директор спрашивает «сколько денег» и «сколько заработали» чаще всего —
  // держим ответ прямо в снимке, без вызова инструментов.
  if (can(user.role, "finance:cash")) {
    const block = await safe(async () => {
      const [cash, expenses, pnl] = await Promise.all([
        getCashOverview(db),
        getExpensesView(db),
        getPnlView(db, 3),
      ]);
      const lines: string[] = [];

      if (cash.accounts.length) {
        lines.push(
          `КАССА: всего ${rub(cash.totalRub)} по ${cash.accounts.length} счетам ` +
            `(${cash.accounts.map((a) => `${a.name} — ${rub(a.balanceRub)}`).join("; ")}).`,
          `- За текущий месяц пришло ${rub(cash.monthInRub)}, ушло ${rub(cash.monthOutRub)}.`,
        );
      } else {
        lines.push("КАССА: счета не заведены (CRM → Финансы → Касса).");
      }

      if (expenses.items.length) {
        const top = expenses.categories
          .slice(0, 5)
          .map((c) => `${c.name} ${rub(c.amountRub)} (${c.sharePct}%)`)
          .join("; ");
        lines.push(`РАСХОДЫ с начала месяца: ${rub(expenses.totalRub)}. Крупнейшие статьи: ${top}.`);
      } else {
        lines.push("РАСХОДЫ: в этом месяце ещё ничего не внесено.");
      }

      const t = pnl.total;
      lines.push(
        `ПРИБЫЛЬ за 3 месяца: выручка ${rub(t.revenueRub)}, удержания WB ${rub(t.wbFeesRub)}, ` +
          `себестоимость ${rub(t.cogsRub)}, расходы ${rub(t.opexRub)} → чистая прибыль ${rub(t.netRub)} ` +
          `(рентабельность ${t.marginPct}%).`,
      );
      if (pnl.costCoveragePct < 95) {
        lines.push(
          `- ОГОВОРКА: себестоимость заполнена у ${pnl.costCoveragePct}% продаж, прибыль завышена.`,
        );
      }
      if (!pnl.hasExpenses) {
        lines.push("- ОГОВОРКА: расходы компании не внесены, прибыль без них.");
      }
      return lines.join("\n");
    }, "");
    if (block) sections.push(block);
  }

  // ── Поставки (supply:view) ──
  if (can(user.role, "supply:view")) {
    const block = await safe(async () => {
      const { data } = await db
        .from("supplies")
        .select("status, quantity, received_qty")
        .eq("org_id", DEMO_ORG_ID)
        .limit(500);
      const rows = (data ?? []) as { status: string; quantity: number; received_qty: number | null }[];
      if (!rows.length) return "ПОСТАВКИ: активных карточек отгрузки нет.";
      const byStatus: Record<string, number> = {};
      rows.forEach((r) => (byStatus[r.status] = (byStatus[r.status] ?? 0) + 1));
      const parts = Object.entries(byStatus).map(([s, n]) => `${s}: ${n}`);
      return `ПОСТАВКИ (${rows.length}): ${parts.join(", ")}`;
    }, "");
    if (block) sections.push(block);
  }

  // ── Мои задачи регламента на сегодня (duty:view) ──
  if (can(user.role, "duty:view")) {
    const block = await safe(async () => {
      const { data } = await db
        .from("duty_assignments")
        .select("status, due_at, template:duty_templates(title)")
        .eq("assignee_id", user.id)
        .eq("task_date", localToday())
        .limit(30);
      const rows = (data ?? []) as unknown as {
        status: string;
        due_at: string;
        template: { title: string } | { title: string }[] | null;
      }[];
      if (!rows.length) return "МОИ ЗАДАЧИ НА СЕГОДНЯ: нет.";
      const lines = ["МОИ ЗАДАЧИ РЕГЛАМЕНТА НА СЕГОДНЯ:"];
      const st: Record<string, string> = { pending: "в работе", done: "выполнено", missed: "просрочено" };
      rows.forEach((r) => {
        const time = new Date(r.due_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
        const tmpl = Array.isArray(r.template) ? r.template[0] : r.template;
        lines.push(`- ${tmpl?.title ?? "задача"} · до ${time} · ${st[r.status] ?? r.status}`);
      });
      return lines.join("\n");
    }, "");
    if (block) sections.push(block);
  }

  return sections.length
    ? sections.join("\n\n")
    : "Данных по вашей роли для сводки пока нет.";
}
