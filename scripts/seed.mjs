// ⚠️  ДЕМО-СИД: наполняет БД СИНТЕТИЧЕСКИМИ числами (заказы, продажи, поставки…)
// для показа интерфейса. НЕ запускать на проде — там данные заводятся в приложении
// и приходят из синхронизации WB. Для чистого каркаса без чисел: npm run db:bootstrap.
//
// Запуск:  npm run db:seed   (грузит .env.local через node --env-file)
// Идемпотентно: повторный запуск не создаёт дублей (upsert по фикс. id / unique,
// пользователи — по email).

import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !KEY) {
  console.error("✗ Нет ключей. Заполни NEXT_PUBLIC_SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в .env.local");
  process.exit(1);
}

const db = createClient(URL, KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Должно совпадать с src/shared/constants.ts
const ORG_ID = "d0000000-0000-4000-8000-000000000001";
const STORE_ID = "d0000000-0000-4000-8000-000000000002";
const PRODUCT_IDS = {
  p1: "d0000000-0000-4000-8000-000000000101",
  p2: "d0000000-0000-4000-8000-000000000102",
  p3: "d0000000-0000-4000-8000-000000000103",
  p4: "d0000000-0000-4000-8000-000000000104",
};
const FACTORY_IDS = {
  china: "d0000000-0000-4000-8000-000000000301",
  uzbekistan: "d0000000-0000-4000-8000-000000000302",
};
const SUPPLY_IDS = {
  s1: "d0000000-0000-4000-8000-000000000401",
  s2: "d0000000-0000-4000-8000-000000000402",
  s3: "d0000000-0000-4000-8000-000000000403",
  s4: "d0000000-0000-4000-8000-000000000404",
  s5: "d0000000-0000-4000-8000-000000000405",
  s6: "d0000000-0000-4000-8000-000000000406",
  s7: "d0000000-0000-4000-8000-000000000407",
};
// Фикс. id для оплат/распределений (нет natural-ключа) → идемпотентный upsert по id
const demoId = (n) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Демо-команда. role — member_role. login — короткий логин для входа в Telegram-бота,
// password — индивидуальный пароль (Supabase Auth). Логин/пароль вводятся в боте
// (@wb_crmnur_bot): вход → роль → меню. Веб-версия пока по cookie-роли, пароль не нужен.
const USERS = [
  { email: "director@demo.wbcrm", name: "Айгерим Директорова", role: "owner",   login: "director", password: "Director-2026" },
  { email: "manager@demo.wbcrm",  name: "Марат Менеджеров",    role: "manager", login: "marat",    password: "Marat-2026" },
  { email: "aliya@demo.wbcrm",    name: "Алия Сатпаева",       role: "manager", login: "aliya",    password: "Aliya-2026" },
  { email: "daniyar@demo.wbcrm",  name: "Данияр Аналитиков",   role: "analyst", login: "daniyar",  password: "Daniyar-2026" },
  { email: "guest@demo.wbcrm",    name: "Гость Инвесторов",    role: "viewer",  login: "guest",    password: "Guest-2026" },
];
const ROLE_LABELS = { owner: "Директор", admin: "Администратор", manager: "Старший менеджер", analyst: "Аналитик", viewer: "Наблюдатель" };

const PRODUCTS = [
  { id: PRODUCT_IDS.p1, nm: 173562489, title: "Кимоно шёлковое, айвори", cat: "Костюмы", status: "Локомотив", price: 3190, cost: 1140, resp: "manager@demo.wbcrm" },
  { id: PRODUCT_IDS.p2, nm: 168227314, title: "Рубашка оверсайз, белая", cat: "Рубашки", status: "Растущий", price: 2290, cost: 820, resp: "aliya@demo.wbcrm" },
  { id: PRODUCT_IDS.p3, nm: 159948120, title: "Костюм гипюровый, айвори", cat: "Костюмы", status: "Новинка", price: 4590, cost: 1830, resp: "manager@demo.wbcrm" },
  { id: PRODUCT_IDS.p4, nm: 149301877, title: "Платье вечернее макси, чёрное", cat: "Платья", status: "Стабильный", price: 3890, cost: 1460, resp: "aliya@demo.wbcrm" },
];

const WAREHOUSES = ["Коледино", "Электросталь", "Казань", "Краснодар", "Тула"];
const SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL"];

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function isoDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

async function step(name, fn) {
  const { error, count } = (await fn()) ?? {};
  if (error) { console.log(`✗ ${name}: ${error.message}`); throw error; }
  console.log(`✓ ${name}${count != null ? ` (${count})` : ""}`);
}

// ── Пользователи: создать/найти по email, вернуть map email→{id,name,role} ──
async function ensureUsers() {
  const { data: list, error } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const byEmail = new Map(list.users.map((u) => [u.email, u.id]));
  const result = {};
  for (const u of USERS) {
    let id = byEmail.get(u.email);
    if (!id) {
      const { data, error: e } = await db.auth.admin.createUser({
        email: u.email,
        password: u.password,
        email_confirm: true,
        user_metadata: { full_name: u.name },
      });
      if (e) throw e;
      id = data.user.id;
    } else {
      // Идемпотентно приводим пароль к актуальному (личные пароли для входа в бота).
      const { error: e } = await db.auth.admin.updateUserById(id, { password: u.password });
      if (e) throw e;
    }
    result[u.email] = { id, name: u.name, role: u.role, login: u.login, password: u.password };
  }
  // профиль (email/имя/логин) — на случай, если триггер не сработал
  await db.from("profiles").upsert(
    USERS.map((u) => ({ id: result[u.email].id, full_name: u.name, email: u.email, login: u.login })),
  );
  // членство в организации + роли
  await db.from("org_members").upsert(
    Object.values(result).map((u) => ({ org_id: ORG_ID, user_id: u.id, role: u.role })),
    { onConflict: "org_id,user_id" },
  );
  return result;
}

async function main() {
  console.log("Сид демо-данных WB CRM →", URL, "\n");

  await step("Организация", () => db.from("orgs").upsert({ id: ORG_ID, name: "Kimono Brand", plan_code: "trial" }));
  await step("Магазин", () => db.from("stores").upsert({ id: STORE_ID, org_id: ORG_ID, marketplace: "wildberries", name: "Kimono Brand — WB", is_active: true }));

  let users;
  await step("Пользователи + роли (Команда)", async () => { users = await ensureUsers(); return {}; });

  await step("Товары", () => db.from("products").upsert(
    PRODUCTS.map((p, i) => ({
      id: p.id, store_id: STORE_ID, nm_id: p.nm,
      vendor_code: `ART-${String(p.nm).slice(0, 5)}`, title: p.title,
      brand: "Kimono Brand", category: p.cat, status: p.status,
      cost_price: p.cost, logistics_cost: 70 + i * 15,
      responsible_user_id: users[p.resp].id,
    })),
  ));

  // Остатки по складам И размерам (снимок на сегодня)
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const stockRows = [];
  for (const p of PRODUCTS) {
    const rnd = mulberry32(p.nm % 99999 + 1);
    for (const w of WAREHOUSES.slice(0, 3)) {
      for (const size of SIZES) {
        stockRows.push({
          product_id: p.id, warehouse: w, size,
          on_stock: Math.round(rnd() * 45),
          in_transit: Math.round(rnd() * 20),
          in_production: Math.round(rnd() * 25),
          snapshot_date: isoDate(today),
        });
      }
    }
  }
  await step(`Остатки по размерам (${stockRows.length})`, () =>
    db.from("stock_snapshots").upsert(stockRows, { onConflict: "product_id,warehouse,size,snapshot_date" }));

  // Заказы, продажи, воронка, реклама за 30 дней
  const orders = [], sales = [], funnel = [], advert = [];
  for (let pi = 0; pi < PRODUCTS.length; pi++) {
    const p = PRODUCTS[pi];
    const rnd = mulberry32(p.nm % 100000);
    for (let back = 29; back >= 0; back--) {
      const d = new Date(today); d.setDate(d.getDate() - back);
      const weekend = d.getDay() === 0 || d.getDay() === 6 ? 1.3 : 1;
      const count = Math.round((1 + rnd() * 3) * weekend);
      let dayOrders = 0, dayBuyouts = 0;
      for (let k = 0; k < count; k++) {
        const at = new Date(d); at.setHours(9 + Math.floor(rnd() * 12), Math.floor(rnd() * 60));
        const srid = `${p.nm}-${isoDate(d)}-${k}`;
        const spp = Math.round((16 + rnd() * 10) * 10) / 10;
        const cancelled = rnd() < 0.05;
        orders.push({
          store_id: STORE_ID, srid, nm_id: p.nm, order_date: at.toISOString(),
          price: p.price, finished_price: Math.round(p.price * (1 - spp / 100)),
          spp_percent: spp, warehouse: WAREHOUSES[Math.floor(rnd() * WAREHOUSES.length)],
          region: "Москва", is_cancel: cancelled,
        });
        if (!cancelled) dayOrders++;
        if (!cancelled && rnd() < 0.7) {
          dayBuyouts++;
          sales.push({
            store_id: STORE_ID, srid, sale_id: `S${srid}`, nm_id: p.nm, sale_date: at.toISOString(),
            price_with_disc: Math.round(p.price * (1 - spp / 100)), for_pay: Math.round(p.price * 0.74),
            spp_percent: spp, is_return: false,
          });
        }
      }
      // Воронка дня (переходы → корзина → заказы → выкупы)
      const opens = Math.round(120 + rnd() * 380 + dayOrders * 25);
      const carts = Math.round(opens * (0.18 + rnd() * 0.14));
      funnel.push({
        store_id: STORE_ID, nm_id: p.nm, stat_date: isoDate(d),
        open_card_count: opens, add_to_cart_count: carts,
        orders_count: dayOrders, orders_sum_rub: dayOrders * p.price,
        buyouts_count: dayBuyouts, buyouts_sum_rub: Math.round(dayBuyouts * p.price * 0.74),
        cancel_count: Math.max(0, count - dayOrders),
        add_to_cart_conversion: opens ? Math.round((carts / opens) * 10000) / 100 : 0,
        cart_to_order_conversion: carts ? Math.round((dayOrders / carts) * 10000) / 100 : 0,
        buyout_percent: dayOrders ? Math.round((dayBuyouts / dayOrders) * 10000) / 100 : 0,
      });
      // Реклама дня
      const views = Math.round(2500 + rnd() * 4500);
      const clicks = Math.round(views * (0.02 + rnd() * 0.02));
      const spend = Math.round(clicks * (9 + rnd() * 6));
      advert.push({
        store_id: STORE_ID, advert_id: 900000 + pi, nm_id: p.nm, stat_date: isoDate(d),
        views, clicks, ctr: views ? Math.round((clicks / views) * 100000) / 1000 : 0,
        cpc: clicks ? Math.round((spend / clicks) * 10000) / 10000 : 0, sum: spend,
        atbs: Math.round(clicks * (0.2 + rnd() * 0.2)), orders_count: dayOrders,
        cr: clicks ? Math.round((dayOrders / clicks) * 100000) / 1000 : 0,
      });
    }
  }
  await step(`Заказы (${orders.length})`, () => db.from("raw_orders").upsert(orders, { onConflict: "store_id,srid" }));
  await step(`Продажи (${sales.length})`, () => db.from("raw_sales").upsert(sales, { onConflict: "store_id,srid,sale_id" }));
  await step(`Воронка (${funnel.length})`, () => db.from("raw_funnel_daily").upsert(funnel, { onConflict: "store_id,nm_id,stat_date" }));
  await step(`Реклама (${advert.length})`, () => db.from("raw_advert_daily").upsert(advert, { onConflict: "store_id,advert_id,nm_id,stat_date" }));

  // Финансы — помесячные сводки за 5 месяцев
  const finance = [];
  const rndFin = mulberry32(11);
  for (let i = 4; i >= 0; i--) {
    const m = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const s = Math.round((1_650_000 + (4 - i) * 190_000) * (0.92 + rndFin() * 0.16));
    finance.push({
      store_id: STORE_ID, rrd_id: Number(`${m.getFullYear()}${String(m.getMonth() + 1).padStart(2, "0")}`),
      doc_type: "Итог месяца", amount: s, commission: Math.round(s * 0.243),
      logistics: Math.round(s * 0.078), storage_fee: Math.round(s * 0.011), penalty: Math.round(rndFin() * 14000),
      period_start: isoDate(new Date(m.getFullYear(), m.getMonth(), 1)),
      period_end: isoDate(new Date(m.getFullYear(), m.getMonth() + 1, 0)),
    });
  }
  await step("Финансы", () => db.from("raw_finance_report").upsert(finance, { onConflict: "store_id,rrd_id" }));

  // Планы РНП на последние 5 недель
  const plans = [];
  for (let pi = 0; pi < PRODUCTS.length; pi++) {
    const p = PRODUCTS[pi];
    for (let wback = 0; wback < 5; wback++) {
      const d = new Date(today); d.setDate(d.getDate() - wback * 7);
      const { year, week } = isoWeek(d);
      plans.push({
        product_id: p.id, iso_year: year, iso_week: week,
        plan_orders: 90 + pi * 20, plan_sales: 65 + pi * 15, plan_views: 40000 + pi * 12000,
        plan_spp: 20, giveaways: pi, responsible_user_id: users[p.resp].id,
      });
    }
  }
  await step(`Планы РНП (${plans.length})`, () => db.from("rnp_plans").upsert(plans, { onConflict: "product_id,iso_year,iso_week" }));

  // Задачи с реальными исполнителями
  const dir = users["director@demo.wbcrm"].id;
  const tasks = [
    { id: "d0000000-0000-4000-8000-000000000201", title: "Заполнить план РНП на следующую неделю", status: "open", priority: "urgent", product_id: null, assignee: "manager@demo.wbcrm" },
    { id: "d0000000-0000-4000-8000-000000000202", title: "Обновить фото карточки — Кимоно", status: "in_progress", priority: "high", product_id: PRODUCT_IDS.p1, assignee: "aliya@demo.wbcrm" },
    { id: "d0000000-0000-4000-8000-000000000203", title: "Проверить ставки рекламы (ДРР выше 12%)", status: "open", priority: "high", product_id: PRODUCT_IDS.p3, assignee: "manager@demo.wbcrm" },
    { id: "d0000000-0000-4000-8000-000000000204", title: "Отгрузка на Коледино — 120 шт", status: "in_progress", priority: "normal", product_id: PRODUCT_IDS.p2, assignee: "aliya@demo.wbcrm" },
    { id: "d0000000-0000-4000-8000-000000000205", title: "Ответить на отзывы за неделю", status: "done", priority: "low", product_id: null, assignee: "aliya@demo.wbcrm" },
    { id: "d0000000-0000-4000-8000-000000000206", title: "Пересчитать себестоимость после закупки ткани", status: "open", priority: "normal", product_id: null, assignee: "manager@demo.wbcrm" },
  ].map((t) => ({
    id: t.id, org_id: ORG_ID, title: t.title, status: t.status, priority: t.priority,
    product_id: t.product_id, assignee_id: users[t.assignee].id, created_by: dir,
  }));
  await step(`Задачи (${tasks.length})`, () => db.from("tasks").upsert(tasks, { onConflict: "id" }));

  // ── Цепочка поставок: фабрики, поставки, оплаты, распределения ──
  const daysAgoIso = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return isoDate(d); };
  const daysAgoTs = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d.toISOString(); };

  await step("Фабрики", () => db.from("factories").upsert([
    { id: FACTORY_IDS.china, org_id: ORG_ID, name: "Guangzhou Textile Co.", country: "china", note: "Основной трикотаж/шёлк" },
    { id: FACTORY_IDS.uzbekistan, org_id: ORG_ID, name: "Toshkent Tekstil", country: "uzbekistan", note: "Хлопок, костюмы, гипюр" },
  ], { onConflict: "id" }));

  // shipDaysAgo: часть > 15 дней — для проверки авто-статуса «Приехал»
  const SUPPLIES = [
    { id: SUPPLY_IDS.s1, factory: FACTORY_IDS.china, product: PRODUCT_IDS.p1, title: "Кимоно шёлковое, айвори", qty: 300, shipDaysAgo: 6,
      sewing: 18000, sewingCur: "cny", cargo: 4200, cargoCur: "cny", status: "in_transit", resp: "manager@demo.wbcrm",
      payments: [{ kind: "goods", amount: 10000, cur: "cny", paidDaysAgo: 4 }], dists: [] },
    { id: SUPPLY_IDS.s2, factory: FACTORY_IDS.china, product: PRODUCT_IDS.p3, title: "Костюм гипюровый, айвори", qty: 200, shipDaysAgo: 20,
      sewing: 24000, sewingCur: "cny", cargo: 5000, cargoCur: "cny", status: "in_transit", resp: "manager@demo.wbcrm",
      payments: [{ kind: "goods", amount: 24000, cur: "cny", paidDaysAgo: 19 }, { kind: "cargo", amount: 5000, cur: "cny", paidDaysAgo: 18 }], dists: [] },
    { id: SUPPLY_IDS.s3, factory: FACTORY_IDS.uzbekistan, product: PRODUCT_IDS.p2, title: "Рубашка оверсайз, белая", qty: 500, shipDaysAgo: 12,
      sewing: 9000000, sewingCur: "uzs", cargo: 1500000, cargoCur: "uzs", status: "arrived", resp: "aliya@demo.wbcrm",
      payments: [{ kind: "goods", amount: 5000000, cur: "uzs", paidDaysAgo: 9 }], dists: [] },
    { id: SUPPLY_IDS.s4, factory: FACTORY_IDS.china, product: PRODUCT_IDS.p4, title: "Платье вечернее макси, чёрное", qty: 250, shipDaysAgo: 30,
      sewing: 21000, sewingCur: "cny", cargo: 4800, cargoCur: "cny", status: "received", resp: "aliya@demo.wbcrm",
      recvDaysAgo: 16, recvQty: 240, comment: "Недостача 10 шт — брак, зафиксировано при вскрытии",
      payments: [{ kind: "goods", amount: 21000, cur: "cny", paidDaysAgo: 28 }, { kind: "cargo", amount: 4800, cur: "cny", paidDaysAgo: 27 }], dists: [] },
    { id: SUPPLY_IDS.s5, factory: FACTORY_IDS.uzbekistan, product: PRODUCT_IDS.p1, title: "Кимоно шёлковое, айвори", qty: 400, shipDaysAgo: 34,
      sewing: 7600000, sewingCur: "uzs", cargo: 1200000, cargoCur: "uzs", status: "sorting", resp: "manager@demo.wbcrm",
      recvDaysAgo: 20, recvQty: 400, comment: "Пришёл весь товар",
      payments: [{ kind: "goods", amount: 7600000, cur: "uzs", paidDaysAgo: 33 }], dists: [] },
    { id: SUPPLY_IDS.s6, factory: FACTORY_IDS.china, product: PRODUCT_IDS.p2, title: "Рубашка оверсайз, белая", qty: 350, shipDaysAgo: 45,
      sewing: 15000, sewingCur: "cny", cargo: 3600, cargoCur: "cny", status: "in_stock", resp: "aliya@demo.wbcrm",
      recvDaysAgo: 30, recvQty: 350, comment: "Пришёл весь товар",
      payments: [{ kind: "goods", amount: 15000, cur: "cny", paidDaysAgo: 44 }, { kind: "cargo", amount: 3600, cur: "cny", paidDaysAgo: 43 }], dists: [] },
    { id: SUPPLY_IDS.s7, factory: FACTORY_IDS.uzbekistan, product: PRODUCT_IDS.p3, title: "Костюм гипюровый, айвори", qty: 220, shipDaysAgo: 55,
      sewing: 8800000, sewingCur: "uzs", cargo: 1400000, cargoCur: "uzs", status: "distributed", resp: "manager@demo.wbcrm",
      recvDaysAgo: 40, recvQty: 220, comment: "Пришёл весь товар",
      payments: [{ kind: "goods", amount: 8800000, cur: "uzs", paidDaysAgo: 54 }, { kind: "cargo", amount: 1400000, cur: "uzs", paidDaysAgo: 53 }],
      dists: [{ warehouse: "Коледино", qty: 120 }, { warehouse: "Казань", qty: 100 }] },
  ];

  const supplyRows = SUPPLIES.map((s) => ({
    id: s.id, org_id: ORG_ID, store_id: STORE_ID, factory_id: s.factory, product_id: s.product,
    title: s.title, quantity: s.qty, ship_date: daysAgoIso(s.shipDaysAgo),
    sewing_cost: s.sewing, sewing_currency: s.sewingCur, cargo_cost: s.cargo, cargo_currency: s.cargoCur,
    status: s.status,
    received_at: s.recvDaysAgo != null ? daysAgoTs(s.recvDaysAgo) : null,
    received_qty: s.recvQty ?? null,
    receipt_comment: s.comment ?? null,
    transit_days: s.recvDaysAgo != null ? Math.max(0, s.shipDaysAgo - s.recvDaysAgo) : null,
    responsible_user_id: users[s.resp].id, created_by: dir,
  }));
  await step(`Поставки (${supplyRows.length})`, () => db.from("supplies").upsert(supplyRows, { onConflict: "id" }));

  let payCounter = 500, distCounter = 600;
  const paymentRows = SUPPLIES.flatMap((s) => s.payments.map((p) => ({
    id: demoId(payCounter++), supply_id: s.id, kind: p.kind, amount: p.amount, currency: p.cur,
    paid_at: daysAgoIso(p.paidDaysAgo), created_by: dir,
  })));
  await step(`Оплаты поставок (${paymentRows.length})`, () => db.from("supply_payments").upsert(paymentRows, { onConflict: "id" }));

  const distRows = SUPPLIES.flatMap((s) => s.dists.map((d) => ({
    id: demoId(distCounter++), supply_id: s.id, warehouse: d.warehouse, quantity: d.qty, created_by: dir,
  })));
  if (distRows.length) {
    await step(`Распределение по WB (${distRows.length})`, () => db.from("wb_distributions").upsert(distRows, { onConflict: "id" }));
  }

  console.log("\n✓ Готово. Все модули на реальных данных из Supabase. Открой http://localhost:3000");

  console.log("\n── Доступы в Telegram-бота (@wb_crmnur_bot) ──");
  console.log("  логин      | пароль         | роль              | сотрудник");
  console.log("  " + "-".repeat(72));
  for (const u of USERS) {
    console.log(
      `  ${u.login.padEnd(10)} | ${u.password.padEnd(14)} | ${(ROLE_LABELS[u.role] ?? u.role).padEnd(17)} | ${u.name}`,
    );
  }
  console.log("\n  Запусти бота:  npm run bot   → открой Telegram → @wb_crmnur_bot → /start");
}

main().catch((e) => { console.error("\n✗ Сид упал:", e.message ?? e); process.exit(1); });
