// PDF-отчёт «Сводка дня» — для Telegram-бота и вечерней рассылки директору.
// Чистый модуль (pdfkit + supabase-js + относительные импорты). Кириллица —
// вложенный шрифт DejaVuSans (стандартные PDF-шрифты кириллицу не умеют).

import path from "node:path";
import PDFDocument from "pdfkit";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "../../shared/constants";
import { can, type MemberRole } from "../../shared/rbac";
import { localIsoDate } from "../data/duties-core";

const FONT = path.join(process.cwd(), "src/assets/fonts/DejaVuSans.ttf");

function rub(n: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(n)) + " ₽";
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export type PdfUser = { id: string; name: string; role: MemberRole; roleLabel: string };

// Собирает данные и рендерит PDF. Возвращает Buffer.
export async function buildDailyReportPdf(
  db: SupabaseClient,
  user: PdfUser,
): Promise<Buffer> {
  const today = localIsoDate();
  const since30 = isoDaysAgo(30);

  // ── данные (по правам роли) ──
  const [ordersRes, salesRes, salesNmRes, prodRes] = await Promise.all([
    db.rpc("agg_orders_daily", { p_store: DEMO_STORE_ID, p_since: isoDaysAgo(7) }),
    db.rpc("agg_sales_daily", { p_store: DEMO_STORE_ID, p_since: isoDaysAgo(7) }),
    db.rpc("agg_sales_by_nm", { p_store: DEMO_STORE_ID, p_since: since30 }),
    db.from("products").select("nm_id, title").eq("store_id", DEMO_STORE_ID).limit(1000),
  ]);
  type Daily = { day: string; qty: number; sum_rub: number };
  const orders7 = (ordersRes.data ?? []) as Daily[];
  const sales7 = (salesRes.data ?? []) as Daily[];
  const titleByNm = new Map(
    ((prodRes.data ?? []) as { nm_id: number; title: string }[]).map((p) => [Number(p.nm_id), p.title]),
  );
  const topProducts = ((salesNmRes.data ?? []) as { nm_id: number; cnt: number }[])
    .sort((a, b) => Number(b.cnt) - Number(a.cnt))
    .slice(0, 10)
    .map((r) => ({ title: titleByNm.get(Number(r.nm_id)) ?? `Артикул ${r.nm_id}`, cnt: Number(r.cnt) }));

  // План/факт (только если роль видит финансы)
  let planBlock: string[] = [];
  if (can(user.role, "finance:view")) {
    const { data: plans } = await db
      .from("sales_plans")
      .select("period_start, period_end, amount_rub")
      .eq("store_id", DEMO_STORE_ID)
      .order("period_start", { ascending: false })
      .limit(1);
    const plan = (plans ?? [])[0];
    if (plan) {
      const start = plan.period_start as string;
      const end = plan.period_end as string;
      const amount = Number(plan.amount_rub);
      const { data: pd } = await db.rpc("agg_sales_daily", {
        p_store: DEMO_STORE_ID,
        p_since: `${start}T00:00:00`,
      });
      const fact = ((pd ?? []) as Daily[]).reduce((t, r) => t + Number(r.sum_rub), 0);
      const totalDays = Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000) + 1);
      const passed = Math.max(1, Math.round((new Date(today).getTime() - new Date(start).getTime()) / 86_400_000) + 1);
      const planToDate = Math.round((amount / totalDays) * passed);
      const pct = planToDate ? Math.round((fact / planToDate) * 100) : 0;
      planBlock = [
        `План WB на период (${start} — ${end}): ${rub(amount)}`,
        `Факт с начала периода: ${rub(fact)}   Выполнение на сегодня: ${pct}%`,
      ];
    }
  }

  // Дисциплина команды (только руководству)
  let discipline: string[] = [];
  if (can(user.role, "reports:view")) {
    const { data } = await db
      .from("duty_assignments")
      .select("status, assignee:profiles(full_name), template:duty_templates(title), report:duty_reports(on_time)")
      .eq("org_id", DEMO_ORG_ID)
      .eq("task_date", today)
      .limit(100);
    const rows = (data ?? []) as unknown as {
      status: string;
      assignee: { full_name: string | null } | null;
      template: { title: string } | null;
      report: { on_time: boolean }[] | { on_time: boolean } | null;
    }[];
    const done = rows.filter((r) => r.status === "done").length;
    const missed = rows.filter((r) => r.status === "missed");
    discipline = [
      `Задач по регламенту сегодня: ${rows.length}, выполнено: ${done}, просрочено: ${missed.length}`,
    ];
    missed.slice(0, 10).forEach((r) => {
      discipline.push(`  • Просрочено: ${r.assignee?.full_name ?? "—"} — ${r.template?.title ?? "задача"}`);
    });
  }

  // ── рендер PDF ──
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  doc.registerFont("main", FONT);
  doc.font("main");

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve) =>
    doc.on("end", () => resolve(Buffer.concat(chunks))),
  );

  const dateLabel = new Date().toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    weekday: "long",
  });

  doc.fontSize(18).text("WB CRM — сводка дня", { continued: false });
  doc.fontSize(10).fillColor("#666").text(`${dateLabel} · ${user.name} (${user.roleLabel})`);
  doc.moveDown(1.2).fillColor("#000");

  const section = (title: string) => {
    doc.moveDown(0.6).fontSize(13).text(title);
    doc.moveTo(doc.x, doc.y + 2).lineTo(547, doc.y + 2).strokeColor("#999").stroke();
    doc.moveDown(0.4).fontSize(10.5).fillColor("#111");
  };

  section("Продажи и заказы (последние 7 дней)");
  const line = (d: Daily[], label: string) => {
    const qty = d.reduce((t, r) => t + Number(r.qty), 0);
    const sum = d.reduce((t, r) => t + Number(r.sum_rub), 0);
    doc.text(`${label}: ${qty} шт на ${rub(sum)}`);
  };
  line(orders7, "Заказы за 7 дней");
  line(sales7, "Продажи (выкупы) за 7 дней");
  const todayOrders = orders7.find((r) => r.day === today);
  const todaySales = sales7.find((r) => r.day === today);
  doc.text(
    `Сегодня: заказы ${Number(todayOrders?.qty ?? 0)} шт (${rub(Number(todayOrders?.sum_rub ?? 0))}), ` +
      `продажи ${Number(todaySales?.qty ?? 0)} шт (${rub(Number(todaySales?.sum_rub ?? 0))})`,
  );

  if (planBlock.length) {
    section("План / факт");
    planBlock.forEach((l) => doc.text(l));
  }

  section("Топ-10 товаров по продажам (30 дней)");
  topProducts.forEach((p, i) => doc.text(`${i + 1}. ${p.title} — ${p.cnt} продаж`));

  if (discipline.length) {
    section("Дисциплина команды (регламент)");
    discipline.forEach((l) => doc.text(l));
  }

  doc.moveDown(1).fontSize(8.5).fillColor("#888")
    .text("Сформировано автоматически WB CRM. Данные из синхронизации Wildberries.");

  doc.end();
  return finished;
}
