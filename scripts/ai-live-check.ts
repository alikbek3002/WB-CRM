// Живая проверка инструментов ИИ на реальной БД (только безопасные сценарии:
// чтение + валидационные отказы, ни одна ветка не доходит до записи).
//   set -a; source .env.local; set +a; npx tsx scripts/ai-live-check.ts
import { createClient } from "@supabase/supabase-js";
import { executeTool } from "../src/backend/ai/tools";
import type { SnapshotUser } from "../src/backend/ai/snapshot";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE;
if (!url || !key) {
  console.error("Нет ключей Supabase");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

type Scenario = {
  name: string;
  role?: SnapshotUser["role"];
  tool: string;
  input: Record<string, unknown>;
  // Ответ должен содержать хотя бы одну из подстрок (регистронезависимо).
  // Пустой массив = «любой ответ без generic-ошибки исполнения».
  expectAny: string[];
};

const GENERIC_FAIL = ["ошибка выполнения действия"];

const READS: Scenario[] = [
  { name: "задачи: мои", tool: "my_tasks", input: {}, expectAny: [] },
  { name: "регламент: мои на сегодня", tool: "my_duties", input: {}, expectAny: [] },
  { name: "регламент: статистика 7д", tool: "duty_stats", input: { days: 7 }, expectAny: ["ДИСЦИПЛИНА", "нет"] },
  { name: "команда: отчёт", tool: "team_report", input: {}, expectAny: [] },
  { name: "команда: состав", tool: "team_list", input: {}, expectAny: ["КОМАНДА"] },
  { name: "товары: карточка", tool: "product_info", input: { query: "пижам" }, expectAny: [] },
  { name: "товары: остатки", tool: "stock_report", input: {}, expectAny: [] },
  { name: "финансы: касса", tool: "cash_balance", input: {}, expectAny: ["ДЕНЬГИ КОМПАНИИ", "Счетов кассы"] },
  { name: "финансы: ОПиУ", tool: "pnl_report", input: { months: 2 }, expectAny: [] },
  { name: "финансы: расходы", tool: "company_expenses", input: {}, expectAny: ["РАСХОДЫ КОМПАНИИ"] },
  { name: "финансы: юнит-экономика", tool: "unit_economics", input: { days: 30 }, expectAny: ["ЮНИТ-ЭКОНОМИКА"] },
  { name: "финансы: юнит-экономика SKU", tool: "unit_economics", input: { days: 30, product: "пижам" }, expectAny: ["ЮНИТ-ЭКОНОМИКА", "не найдено", "Нашлось несколько"] },
  { name: "зарплаты: разрез", tool: "payroll_report", input: {}, expectAny: ["ВЫПЛАТЫ"] },
  { name: "зарплаты: мои", tool: "my_salary", input: {}, expectAny: ["МОИ ВЫПЛАТЫ"] },
  { name: "выплаты: заявки", tool: "payouts_list", input: {}, expectAny: ["ЗАЯВК"] },
  { name: "поставки: список", tool: "supplies_list", input: {}, expectAny: ["ПОСТАВКИ", "нет"] },
  { name: "поставки: долги", tool: "expenses_report", input: {}, expectAny: [] },
  { name: "дизайн: очередь", tool: "design_queue", input: {}, expectAny: [] },
];

const ASKS: Scenario[] = [
  { name: "задача без данных", tool: "create_task", input: {}, expectAny: ["нужны имя сотрудника"] },
  { name: "закрыть задачу БЕЗ отчёта", tool: "complete_task", input: { task: "тест" }, expectAny: ["Отчёт обязателен"] },
  { name: "взять несуществующую", tool: "start_task", input: { task: "zzz-такой-нет-999" }, expectAny: ["не найдено", "не найдена"] },
  { name: "отменить несуществующую", tool: "cancel_task", input: { task: "zzz-такой-нет-999" }, expectAny: ["не найдено", "не найдена"] },
  { name: "регламент без отчёта", tool: "complete_my_duty", input: { duty: "отзывы" }, expectAny: ["нужны название задачи и текст отчёта"] },
  { name: "закрыть за несуществующего", tool: "complete_duty_for", input: { employee: "НетТакого999", duty: "x" }, expectAny: ["не найден"] },
  { name: "товар: несуществующий", tool: "update_product", input: { product: "zzz-такого-нет-999" }, expectAny: ["не найдено", "не найден"] },
  { name: "товар: без артикула", tool: "create_product", input: {}, expectAny: ["Ошибка", "нужн"] },
  { name: "план: без дат", tool: "set_sales_plan", input: {}, expectAny: ["Ошибка", "нужн"] },
  { name: "расход: несуществующая статья", tool: "add_expense", input: { amount: 100, category: "статья-которой-нет-999" }, expectAny: ["не найдена. Доступные"] },
  { name: "расход: 150к — стоп-кран", tool: "add_expense", input: { amount: 150000, category: "реклама" }, expectAny: ["С какого счёта", "Крупная сумма", "Подходит несколько"] },
  { name: "перевод: несуществующий счёт", tool: "transfer_money", input: { from_account: "счёт-которого-нет-999", to_account: "x", amount: 10 }, expectAny: ["не найден"] },
  { name: "удаление: не найдено", tool: "delete_cash_tx", input: { amount: 987654321 }, expectAny: ["не найдена среди ручных"] },
  { name: "статья: дубль", tool: "create_expense_category", input: { name: "Реклама WB", direction: "out" }, expectAny: ["уже есть"] },
  { name: "зарплата: без типа", tool: "pay_salary", input: { employee: "Азиз", amount: 100 }, expectAny: ["Уточни тип выплаты"] },
  { name: "заявка: без типа", tool: "request_payout", input: { amount: 100, title: "тест" }, expectAny: ["Уточни тип выплаты"] },
  { name: "заявка: без валюты", tool: "request_payout", input: { amount: 100, title: "тест", kind: "contractor" }, expectAny: ["Уточни валюту"] },
  { name: "согласование: мусорное решение", tool: "decide_payout", input: { payout: "x", decision: "да" }, expectAny: ["Не понял решение"] },
  { name: "оплата: несуществующая заявка", tool: "pay_payout", input: { payout: "заявка-которой-нет-999" }, expectAny: ["не найдена"] },
  { name: "фабрика: без страны", tool: "create_factory", input: { name: "Тест999" }, expectAny: ["страна должна быть"] },
  { name: "поставка: без стоимости отшивки", tool: "create_supply", input: { factory: "x", title: "y", quantity: 5 }, expectAny: ["стоимость отшивки"] },
  { name: "оплата поставки: без валюты", tool: "add_supply_payment", input: { supply: "x", kind: "goods", amount: 100 }, expectAny: ["нужна валюта", "не найдено"] },
  { name: "приёмка: несуществующая", tool: "receive_supply", input: { supply: "zzz-нет-999", received_qty: 1 }, expectAny: ["не найдено", "не найдена"] },
  { name: "распределение: несуществующая", tool: "distribute_supply", input: { supply: "zzz-нет-999", warehouse: "Коледино", quantity: 1 }, expectAny: ["не найдено", "не найдена"] },
  { name: "дизайн: заявка без темы", tool: "create_design_request", input: {}, expectAny: ["Ошибка", "нужн"] },
  { name: "дизайн: несуществующая заявка", tool: "design_action", input: { request: "zzz-нет-999", action: "take" }, expectAny: ["не найдено", "не найдена"] },
  { name: "РНП: несуществующий товар", tool: "set_rnp_plan", input: { product: "zzz-нет-999" }, expectAny: ["не найдено", "не найден", "хотя бы один"] },
];

const DENIALS: Scenario[] = [
  { name: "viewer: начислить ЗП", role: "viewer", tool: "pay_salary", input: { employee: "x", amount: 1, kind: "salary" }, expectAny: ["только руководителю"] },
  { name: "viewer: заявка на выплату", role: "viewer", tool: "request_payout", input: { amount: 1, title: "x", kind: "other", currency: "rub" }, expectAny: ["нет прав"] },
  { name: "viewer: статистика регламента", role: "viewer", tool: "duty_stats", input: {}, expectAny: ["нет прав"] },
  { name: "viewer: закрыть регламент", role: "viewer", tool: "complete_my_duty", input: { duty: "x", report: "y" }, expectAny: ["нет прав"] },
  { name: "viewer: состав команды", role: "viewer", tool: "team_list", input: {}, expectAny: ["только руководителю"] },
  { name: "analyst: приход в кассу", role: "analyst", tool: "add_income", input: { amount: 1, category: "x" }, expectAny: ["нет прав"] },
  { name: "analyst: закрыть регламент", role: "analyst", tool: "complete_my_duty", input: { duty: "x", report: "y" }, expectAny: ["нет прав"] },
  { name: "designer: расход в кассу", role: "designer", tool: "add_expense", input: { amount: 1, category: "x" }, expectAny: ["нет прав"] },
  { name: "designer: удалить операцию", role: "designer", tool: "delete_cash_tx", input: { amount: 1 }, expectAny: ["нет прав"] },
  { name: "designer: отменить задачу", role: "designer", tool: "cancel_task", input: { task: "x" }, expectAny: ["только руководителю"] },
  { name: "designer: отчёт по команде", role: "designer", tool: "team_report", input: {}, expectAny: ["только руководителю"] },
  { name: "seo: оплатить заявку", role: "seo", tool: "pay_payout", input: { payout: "x" }, expectAny: ["нет прав"] },
  { name: "kiz: править товар", role: "kiz", tool: "update_product", input: { product: "x" }, expectAny: ["нет прав"] },
  { name: "adv: действие по дизайну", role: "adv", tool: "design_action", input: { request: "x", action: "take" }, expectAny: ["нет прав"] },
  { name: "adv: создать поставку", role: "adv", tool: "create_supply", input: { factory: "x", title: "y", quantity: 1, sewing_cost: 1 }, expectAny: ["нет прав"] },
  { name: "shipping: оплата поставки", role: "shipping", tool: "add_supply_payment", input: { supply: "x", kind: "goods", amount: 1, currency: "cny" }, expectAny: ["нет прав"] },
  { name: "shipping: создать задачу", role: "shipping", tool: "create_task", input: { assignee: "x", title: "y" }, expectAny: ["только руководителю"] },
  { name: "неизвестный инструмент", tool: "no_such_tool_999", input: {}, expectAny: ["Неизвестный инструмент"] },
];

async function main() {
  // Реальный владелец — для персональных инструментов (my_*)
  const { data: ownerRow } = await db
    .from("org_members")
    .select("user_id, profile:profiles(full_name)")
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();
  const ownerId = String(ownerRow?.user_id ?? "");
  const ownerName =
    (Array.isArray(ownerRow?.profile) ? ownerRow?.profile[0] : ownerRow?.profile)?.full_name ??
    "Директор";
  if (!ownerId) {
    console.error("owner не найден в org_members");
    process.exit(1);
  }
  const mkUser = (role: SnapshotUser["role"]): SnapshotUser => ({
    id: ownerId,
    name: ownerName,
    role,
    roleLabel: role,
    orgName: "Starkids",
  });

  let pass = 0;
  let fail = 0;
  const failures: string[] = [];
  for (const s of [...READS, ...ASKS, ...DENIALS]) {
    const user = mkUser(s.role ?? "owner");
    let out = "";
    try {
      out = await executeTool(db, user, s.tool, s.input);
    } catch (e) {
      out = `THROWN: ${(e as Error).message}`;
    }
    const low = out.toLowerCase();
    const generic = GENERIC_FAIL.some((g) => low.includes(g)) || out.startsWith("THROWN");
    const matched = s.expectAny.length === 0 ? !generic : s.expectAny.some((e) => low.includes(e.toLowerCase()));
    if (matched && !out.startsWith("THROWN")) {
      pass++;
      console.log(`PASS  ${s.name}`);
    } else {
      fail++;
      failures.push(`FAIL  ${s.name} [${s.tool}]\n      → ${out.slice(0, 300).replace(/\n/g, " | ")}`);
      console.log(`FAIL  ${s.name}`);
    }
  }
  console.log(`\nИтог: ${pass} PASS, ${fail} FAIL из ${READS.length + ASKS.length + DENIALS.length}`);
  if (failures.length) console.log("\n" + failures.join("\n"));
  process.exit(fail ? 1 : 0);
}

void main();
