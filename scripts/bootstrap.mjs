// Каркас рабочего тенанта WB CRM — БЕЗ демо-чисел.
// Создаёт только: организацию, магазин, команду (Auth-пользователи + роли).
// Все бизнес-данные (товары, заказы, поставки…) заводятся руками в приложении
// или придут из синхронизации WB. Для демо-датасета есть отдельный db:seed.
//
// Запуск:  npm run db:bootstrap   (грузит .env.local через node --env-file)
// Идемпотентно: повторный запуск не создаёт дублей.

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

// Команда. role — member_role; login/password — вход в CRM (/login) и Telegram-бот.
const USERS = [
  { email: "director@demo.wbcrm",  name: "Айгерим Директорова", role: "owner",    login: "director",  password: "Director-2026" },
  { email: "zhakypbek@demo.wbcrm", name: "Жакыпбек",            role: "manager",  login: "zhakypbek", password: "Zhakypbek-2026" },
  { email: "felix@demo.wbcrm",     name: "Феликс",              role: "designer", login: "felix",     password: "Felix-2026" },
  { email: "nazira@demo.wbcrm",    name: "Назира эже",          role: "seo",      login: "nazira",    password: "Nazira-2026" },
  { email: "zhazgul@demo.wbcrm",   name: "Жазгул эже",          role: "kiz",      login: "zhazgul",   password: "Zhazgul-2026" },
  { email: "perizat@demo.wbcrm",   name: "Перизат эже",         role: "adv",      login: "perizat",   password: "Perizat-2026" },
  { email: "adv2@demo.wbcrm",      name: "Менеджер по рекламе 2", role: "adv",    login: "adv2",      password: "Adv2-2026" },
  { email: "ismar@demo.wbcrm",     name: "Исмар",               role: "shipping", login: "ismar",     password: "Ismar-2026" },
  // Прежние сотрудники (отзывы/контент) и служебные роли
  { email: "manager@demo.wbcrm",   name: "Марат Менеджеров",    role: "manager",  login: "marat",     password: "Marat-2026" },
  { email: "aliya@demo.wbcrm",     name: "Алия Сатпаева",       role: "manager",  login: "aliya",     password: "Aliya-2026" },
  { email: "daniyar@demo.wbcrm",   name: "Данияр Аналитиков",   role: "analyst",  login: "daniyar",   password: "Daniyar-2026" },
  { email: "guest@demo.wbcrm",     name: "Гость Инвесторов",    role: "viewer",   login: "guest",     password: "Guest-2026" },
];

async function step(name, fn) {
  const { error, count } = (await fn()) ?? {};
  if (error) { console.log(`✗ ${name}: ${error.message}`); throw error; }
  console.log(`✓ ${name}${count != null ? ` (${count})` : ""}`);
}

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
      const { error: e } = await db.auth.admin.updateUserById(id, { password: u.password });
      if (e) throw e;
    }
    result[u.email] = { id, name: u.name, role: u.role };
  }
  const { error: profErr } = await db.from("profiles").upsert(
    USERS.map((u) => ({ id: result[u.email].id, full_name: u.name, email: u.email, login: u.login })),
  );
  if (profErr) throw new Error(`profiles upsert: ${profErr.message}`);
  const { error: memErr } = await db.from("org_members").upsert(
    Object.values(result).map((u) => ({ org_id: ORG_ID, user_id: u.id, role: u.role })),
    { onConflict: "org_id,user_id" },
  );
  if (memErr) throw new Error(`org_members upsert: ${memErr.message}`);
  return result;
}

// ── Регламент обязанностей (из документов «Вопросы и отзывы» + «Контент») ──
// email → конкретный исполнитель; роль — для назначения всем сотрудникам роли.
// weekday: 1=пн … 7=вс. due — дедлайн в течение дня, hours — время на выполнение.
const DUTIES = [
  // Менеджер по отзывам и вопросам (регламент «Вопросы и отзывы»)
  { code: "reviews-morning", assignee: "aliya@demo.wbcrm", role: "manager", freq: "daily", due: "11:00", hours: 3, sort: 10,
    title: "Ответы на отзывы — ночные",
    desc: "Закрыть ВСЕ отзывы, накопившиеся за ночь, до 11:00. Ответ в первые 3 часа улучшает ранжирование карточки. SEO-ключи в ответах; шаблоны не повторять; негатив не игнорировать. До 3 звёзд включительно — проверить причину (пересорт/некомплект → немедленно сообщить главному менеджеру и логистике)." },
  { code: "reviews-evening", assignee: "aliya@demo.wbcrm", role: "manager", freq: "daily", due: "18:00", hours: 3, sort: 11,
    title: "Ответы на отзывы — дневные",
    desc: "Закрыть отзывы, накопившиеся в течение дня, до 18:00. В течение дня держать не более 10 неотвеченных. Рекомендации товаров в ответах — по слабым позициям (уточнить у менеджера)." },
  { code: "questions-daily", assignee: "aliya@demo.wbcrm", role: "manager", freq: "daily", due: "18:00", hours: 3, sort: 12,
    title: "Ответы на вопросы покупателей",
    desc: "Ответить на все вопросы покупателей за день. Деловой стиль, без односложных ответов. Частые вопросы фиксировать — они кандидаты на вынос в инфографику карточки." },
  { code: "buyer-chat", assignee: "aliya@demo.wbcrm", role: "manager", freq: "daily", due: "18:00", hours: 2, sort: 13,
    title: "Чат с покупателями — претензии и обращения",
    desc: "Проверить «Чат с покупателем», ответить день в день (норматив WB — до 10 дней, наш стандарт — сегодня). Запрещено: уходить в сторонние мессенджеры, собирать персональные данные, негатив в адрес покупателей." },
  { code: "negative-analytics", assignee: "aliya@demo.wbcrm", role: "manager", freq: "weekly", weekday: 5, due: "17:00", hours: 5, sort: 14,
    title: "Аналитика негатива (свой магазин)",
    desc: "Разобрать негатив недели: % повторяющихся проблем, брак, упаковка. Если брак превышает 5% — НЕМЕДЛЕННО сигнал руководителю (риск блокировки отгрузок WB). Выводы — в отчёт." },
  { code: "competitor-reviews", assignee: "aliya@demo.wbcrm", role: "manager", freq: "weekly", weekday: 3, due: "17:00", hours: 4, sort: 15,
    title: "Аналитика отзывов конкурентов",
    desc: "Негатив и позитив конкурентов: перенять решения проблем, спрогнозировать риски у нас, взять сильное в нашу инфографику. Оценить оперативность их ответов — не отстаём ли." },
  { code: "pinned-review", assignee: "aliya@demo.wbcrm", role: "manager", freq: "weekly", weekday: 1, due: "15:00", hours: 2, sort: 16,
    title: "Закреплённый отзыв — проверка/смена (Джем)",
    desc: "Закреп — крутой отзыв 5★ с фото/видео, время от времени менять. Проверить по ключевым карточкам, обновить где закреп устарел." },
  // Контент-менеджер (регламент «Визуальный контент», шаблон Макса Попова)
  { code: "content-tests", assignee: "manager@demo.wbcrm", role: "manager", freq: "daily", due: "18:00", hours: 4, sort: 20,
    title: "Потоковое тестирование визуала",
    desc: "Зафиксировать CTR/конверсию/выкуп по тестируемым обложкам. Правило регламента: минимум 2 визуальных подхода на карточку, решения только на данных. Докрутка воронки по результатам." },
  { code: "competitor-visual", assignee: "manager@demo.wbcrm", role: "manager", freq: "weekly", weekday: 2, due: "17:00", hours: 4, sort: 21,
    title: "Анализ конкурентов в выдаче",
    desc: "Карточки конкурентов по целевым ключам: визуальные решения, форм-фактор топа, ракурсы. Выявленные паттерны — в ТЗ дизайнеру. Проверить восприятие ИИ (@pic)." },
  { code: "tz-designer", assignee: "manager@demo.wbcrm", role: "manager", freq: "weekly", weekday: 4, due: "17:00", hours: 5, sort: 22,
    title: "ТЗ дизайнеру — новые и слабые карточки",
    desc: "По слабым карточкам (низкий CTR/конверсия): собрать RTB, воронку, тексты. Обложка: товар 70–80% кадра, ключевой запрос виден, безопасные зоны под плашки WB. Видео 60–90 сек, сильные кадры в первые 3–5 сек." },
  { code: "season-covers", assignee: "manager@demo.wbcrm", role: "manager", freq: "weekly", weekday: 1, due: "16:00", hours: 3, sort: 23,
    title: "Сезонная адаптация обложек",
    desc: "Проверить актуальность обложек к сезону/праздникам. Успешные форматы масштабировать на линейку как базовый шаблон." },
  { code: "reviews-insights", assignee: "manager@demo.wbcrm", role: "manager", freq: "weekly", weekday: 3, due: "17:00", hours: 3, sort: 24,
    title: "Инсайты из отзывов/вопросов → контент",
    desc: "Собрать повторяющиеся вопросы и боли из отзывов (свои + конкуренты), вынести ответы в слайды/RICH. Ожидание = реальность → выше выкуп, меньше возвратов." },
  // Старший менеджер (Жакыпбек)
  { code: "senior-metrics", assignee: "zhakypbek@demo.wbcrm", role: "manager", freq: "daily", due: "12:00", hours: 2, sort: 5,
    title: "Контроль показателей дня",
    desc: "Дашборд и РНП: заказы/выкупы за вчера, аномалии по топ-товарам, остатки. Проблемные позиции — задачи ответственным менеджерам." },
  { code: "senior-reports", assignee: "zhakypbek@demo.wbcrm", role: "manager", freq: "daily", due: "19:00", hours: 1, sort: 6,
    title: "Контроль отчётов команды",
    desc: "Вкладка «Отчёты»: все ли задачи регламента закрыты, кто просрочил, качество отчётов. Эскалации — директору." },
  // Дизайнер (Феликс)
  { code: "design-queue", assignee: "felix@demo.wbcrm", role: "designer", freq: "daily", due: "11:00", hours: 1, sort: 40,
    title: "Разбор очереди дизайн-заявок",
    desc: "Вкладка «Дизайн»: взять новые заявки в работу, уточнить бриф/референсы у заказчика, оценить сроки. Приоритет — обложки слабых карточек." },
  { code: "design-work", assignee: "felix@demo.wbcrm", role: "designer", freq: "daily", due: "18:00", hours: 5, sort: 41,
    title: "Выполнение дизайн-заявок",
    desc: "Работа по заявкам «в работе»: обложка — товар 70–80% кадра, безопасные зоны под плашки WB, читаемость с мобильного. Сдача — ссылка на макет в заявке (статус «На проверке»)." },
  // SEO (Назира)
  { code: "seo-daily", assignee: "nazira@demo.wbcrm", role: "seo", freq: "daily", due: "17:00", hours: 4, sort: 45,
    title: "SEO карточек: ключи и позиции",
    desc: "Проверка позиций по целевым ключам, обновление названий/описаний. Ключи из отзывов и вопросов — в тексты карточек." },
  { code: "seo-weak", assignee: "nazira@demo.wbcrm", role: "seo", freq: "weekly", weekday: 2, due: "17:00", hours: 5, sort: 46,
    title: "SEO-прокачка слабых карточек",
    desc: "По слабым товарам (бейдж «слабый»): пересобрать семантику, обновить тексты, при необходимости — заявка на дизайн (новая обложка/слайды)." },
  // КИЗы (Жазгул)
  { code: "kiz-daily", assignee: "zhazgul@demo.wbcrm", role: "kiz", freq: "daily", due: "17:00", hours: 3, sort: 50,
    title: "КИЗы: коды маркировки по поставкам",
    desc: "По активным поставкам: коды заказаны, нанесены, введены в оборот («Честный знак»). Остаток неиспользованных кодов. Блокеры — старшему менеджеру немедленно." },
  { code: "kiz-weekly", assignee: "zhazgul@demo.wbcrm", role: "kiz", freq: "weekly", weekday: 4, due: "17:00", hours: 3, sort: 51,
    title: "Сверка маркировки за неделю",
    desc: "Сверка: выведенные из оборота коды vs продажи, расхождения. Готовность кодов под ближайшие отгрузки." },
  // Реклама (обе: Перизат + второй менеджер — по роли adv)
  { code: "adv-morning", role: "adv", freq: "daily", due: "11:00", hours: 2, sort: 55,
    title: "Реклама: утренний контроль кампаний",
    desc: "Ставки и бюджеты кампаний, показы/клики за ночь, CTR. Отключить неэффективное, поднять работающее." },
  { code: "adv-evening", role: "adv", freq: "daily", due: "18:00", hours: 2, sort: 56,
    title: "Реклама: контроль ДРР за день",
    desc: "ДРР по кампаниям за день, корректировка ставок. ДРР выше нормы по товару — причина и план действий в отчёт." },
  // Отгрузки (Исмар)
  { code: "ship-plan", assignee: "ismar@demo.wbcrm", role: "shipping", freq: "daily", due: "12:00", hours: 2, sort: 60,
    title: "План отгрузок и остатки на складах WB",
    desc: "Остатки по складам: где меньше чем на 2 недели продаж — в план отгрузки. Согласовать объёмы со старшим менеджером." },
  { code: "ship-execute", assignee: "ismar@demo.wbcrm", role: "shipping", freq: "daily", due: "18:00", hours: 4, sort: 61,
    title: "Оформление отгрузок и контроль приёмки",
    desc: "Оформить поставки на склады WB, контроль статусов приёмки вчерашних отгрузок, расхождения — в отчёт. Товар без утверждённого дизайна карточки не отгружать." },
  // Директор
  { code: "director-review", assignee: "director@demo.wbcrm", role: "owner", freq: "daily", due: "19:00", hours: 1, sort: 30,
    title: "Контроль отчётов команды",
    desc: "Просмотреть отчёты менеджеров за день во вкладке «Отчёты»: всё ли сдано вовремя, эскалации (брак >5%, аномалии продаж). Дать обратную связь." },
];

async function seedDuties(users) {
  const byEmail = new Map(Object.entries(users).map(([email, u]) => [email, u.id]));
  const rows = DUTIES.map((d) => ({
    org_id: ORG_ID,
    code: d.code,
    title: d.title,
    description: d.desc,
    role: d.role,
    assignee_user_id: byEmail.get(d.assignee) ?? null,
    frequency: d.freq,
    weekday: d.weekday ?? null,
    due_time: d.due,
    hours_to_complete: d.hours,
    requires_report: true,
    sort_order: d.sort,
    active: true,
  }));
  const { error } = await db.from("duty_templates").upsert(rows, { onConflict: "org_id,code" });
  if (error) throw new Error(`duty_templates upsert: ${error.message}`);
  return rows.length;
}

async function main() {
  console.log("Bootstrap каркаса WB CRM (без демо-данных) →", URL, "\n");

  await step("Организация", () => db.from("orgs").upsert({ id: ORG_ID, name: "Kimono Brand", plan_code: "trial" }));
  await step("Магазин", () => db.from("stores").upsert({ id: STORE_ID, org_id: ORG_ID, marketplace: "wildberries", name: "Kimono Brand — WB", is_active: true }));
  let users;
  await step("Команда (пользователи + роли)", async () => { users = await ensureUsers(); return {}; });
  await step(`Регламент обязанностей (${DUTIES.length})`, async () => ({ count: await seedDuties(users) }));

  console.log("\n✓ Готово. Данные по нулям — заводите товары/фабрики/поставки в приложении.");
  console.log("  Демо-датасет (если нужен): npm run db:seed");
}

main().catch((e) => { console.error(e); process.exit(1); });
