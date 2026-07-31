// Инструменты ИИ-ассистента: реальные ДЕЙСТВИЯ в системе по команде из чата.
// Права проверяются здесь же (не доверяем модели). Чистый модуль.
//
// ПОКРЫТИЕ: набор инструментов зеркалит мутации веб-интерфейса (API-роуты
// src/app/api/**) — задачи, регламент, товары, финансовый план, цепочка поставок
// с расходами, дизайн, РНП. Что сотрудник может сделать мышкой на сайте, то же
// самое он может сказать словами боту. Добавляя новый API-роут с записью в БД,
// добавляй сюда парный инструмент — иначе ассистент «отстанет» от интерфейса.
//
// КОНТРАКТ КЭША: любая запись в БД обязана дёрнуть ctx.touch() — иначе веб до
// 30 минут показывает старые данные (см. cachedRead в backend/data/index.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_ORG_ID, DEMO_STORE_ID, toRub } from "../../shared/constants";
import { can, type MemberRole, type Permission } from "../../shared/rbac";
import type { Currency, PayoutKind } from "../../shared/types";
import {
  createCashTx,
  findAccounts,
  findCategories,
  getCashOverview,
  getExpensesView,
  getPnlView,
  mirrorSupplyPaymentToCash,
  pickDefaultAccount,
  type CashActor,
} from "../data/cash-core";
import {
  createPayoutRequest,
  decidePayout,
  getPayouts,
  payPayout,
  PAYOUT_KIND_LABELS,
  PAYOUT_STATUS_LABELS,
} from "../data/payouts-core";
import { localIsoDate } from "../data/duties-core";
import { cancelTask, completeTask, startTask, type TaskActor } from "../data/tasks-core";
import { notifyProfile, notifyRoles, tgEsc } from "../telegram/notify";
import type { SnapshotUser } from "./snapshot";

// ── Описания инструментов для Claude (какие доступны — зависит от роли) ──

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

// Контекст исполнения: БД, кто действует, и сигнал «данные изменились».
export type ToolCtx = {
  db: SupabaseClient;
  user: SnapshotUser;
  touch: () => void; // сброс кэша чтения после успешной записи
};

const LEAD_ROLES = ["owner", "admin", "manager"];
const isLead = (role: string) => LEAD_ROLES.includes(role);

const CURRENCIES = ["cny", "uzs", "rub"] as const;
const CURRENCY_LABEL: Record<string, string> = { cny: "¥", uzs: "сум", rub: "₽" };

// Схемы-заготовки, чтобы описания инструментов не расползались
const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "number", description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});

type ToolSpec = ToolDef & { permission?: Permission; leadOnly?: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Каталог инструментов. Один список — один источник правды по правам:
// permission (матрица RBAC) и/или leadOnly (owner/admin/manager).
// ─────────────────────────────────────────────────────────────────────────────

const CATALOG: ToolSpec[] = [
  // ───────────────────────────── Задачи ─────────────────────────────
  {
    name: "my_tasks",
    permission: "tasks:view",
    description:
      "Показать текущие задачи сотрудника (открытые и в работе). Используй на «какие у меня задачи», «что мне сегодня делать».",
    input_schema: obj({}),
  },
  {
    name: "create_task",
    leadOnly: true,
    description:
      "Создать задачу сотруднику. Используй, когда пользователь просит поставить/назначить задачу кому-то из команды. Сотруднику придёт уведомление в Telegram.",
    input_schema: obj(
      {
        assignee: str("Имя или логин сотрудника (например «Алия» или aliya)"),
        title: str("Формулировка задачи"),
        description: str("Подробности задачи (необязательно)"),
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "urgent"],
          description: "Приоритет (по умолчанию normal)",
        },
        due_date: str("Срок yyyy-mm-dd (необязательно)"),
        product: str("Часть названия товара, если задача про конкретный товар (необязательно)"),
      },
      ["assignee", "title"],
    ),
  },
  {
    name: "start_task",
    permission: "tasks:view",
    description:
      "Взять задачу в работу (открыта → в работе). Используй на «беру задачу …», «начал делать …».",
    input_schema: obj({ task: str("Часть названия задачи") }, ["task"]),
  },
  {
    name: "complete_task",
    permission: "tasks:view",
    description:
      "Закрыть задачу с отчётом о выполнении. ОТЧЁТ ОБЯЗАТЕЛЕН — это текст о том, что реально сделано. Если сотрудник просит закрыть задачу, но не рассказал, ЧТО сделано, — сначала спроси у него отчёт и только потом вызывай инструмент. Задачу ищем по части названия.",
    input_schema: obj(
      {
        task: str("Часть названия задачи (например «фото карточки»)"),
        report: str("Отчёт: что именно сделано, цифры, что осталось"),
      },
      ["task", "report"],
    ),
  },
  {
    name: "cancel_task",
    leadOnly: true,
    description:
      "Отменить (убрать) задачу. Используй, когда просят снять/удалить/отменить задачу. Задачу ищем по части названия.",
    input_schema: obj(
      { task: str("Часть названия задачи"), reason: str("Причина отмены (необязательно)") },
      ["task"],
    ),
  },
  {
    name: "team_report",
    leadOnly: true,
    description:
      "Отчёт руководителю по команде: кто что сделал (отчёты по закрытым задачам), у кого что в работе и просрочено, дисциплина по регламенту за сегодня. Используй на вопросы «что сделала команда», «кто чем занят», «покажи отчёты».",
    input_schema: obj({
      days: int("За сколько последних дней брать закрытые задачи (по умолчанию 1 — сегодня)"),
      person: str("Имя сотрудника, если интересует кто-то один (необязательно)"),
    }),
  },

  // ─────────────────────────── Регламент дня ───────────────────────────
  {
    name: "my_duties",
    permission: "duty:view",
    description:
      "Показать МОИ задачи регламента на сегодня: что осталось, до какого времени, что уже закрыто. Используй на «что по регламенту», «что мне ещё нужно успеть».",
    input_schema: obj({}),
  },
  {
    name: "complete_my_duty",
    permission: "duty:complete",
    description:
      "Закрыть СВОЮ задачу регламента на сегодня с текстом отчёта. Используй, когда пользователь говорит «отметь выполненной мою задачу … отчёт: …».",
    input_schema: obj(
      {
        duty: str("Часть названия задачи (например «отзывы» или «КИЗы»)"),
        report: str("Текст отчёта о выполнении"),
      },
      ["duty", "report"],
    ),
  },

  // ───────────────────────────── Товары ─────────────────────────────
  {
    name: "product_info",
    permission: "products:view",
    description:
      "Найти товар по названию или артикулу и получить его цифры: продажи за 30 дней, остаток, топ-склады, цена, себестоимость. Используй для вопросов про конкретный товар, которого нет в сводке.",
    input_schema: obj(
      { query: str("Часть названия товара или артикул WB (nm_id)") },
      ["query"],
    ),
  },
  {
    name: "stock_report",
    permission: "products:view",
    description:
      "Остатки на складах WB: что скоро закончится (запас в днях), топ-склады по объёму. Используй на «что заканчивается», «где какие остатки», «что везти».",
    input_schema: obj({
      days: int("Порог «скоро закончится» в днях запаса (по умолчанию 14)"),
      by_warehouse: {
        type: "boolean",
        description: "true — показать разрез по складам вместо списка товаров",
      },
    }),
  },
  {
    name: "update_product",
    permission: "products:edit",
    description:
      "Изменить карточку товара: себестоимость, стоимость логистики, статус, категорию, бренд. Используй на «поставь себестоимость 450 на пижаму», «переведи X в статус Архив».",
    input_schema: obj(
      {
        product: str("Часть названия товара или артикул WB"),
        cost_price: int("Себестоимость, ₽"),
        logistics_cost: int("Логистика на единицу, ₽"),
        status: str("Статус карточки (например «Активный», «Новинка», «Архив»)"),
        category: str("Категория"),
        brand: str("Бренд"),
      },
      ["product"],
    ),
  },
  {
    name: "create_product",
    permission: "products:edit",
    description:
      "Завести новую карточку товара по артикулу WB. Используй на «добавь товар с артикулом 123456 — название …».",
    input_schema: obj(
      {
        nm_id: int("Артикул WB (nm_id), целое число"),
        title: str("Название товара"),
        vendor_code: str("Артикул продавца (необязательно)"),
        brand: str("Бренд (необязательно)"),
        category: str("Категория (необязательно)"),
        cost_price: int("Себестоимость, ₽ (необязательно)"),
      },
      ["nm_id", "title"],
    ),
  },

  // ───────────────────────────── Финансы ─────────────────────────────
  {
    name: "set_sales_plan",
    permission: "finance:plan",
    description:
      "Задать план продаж WB на период (сумма в рублях). Используй на «поставь план 30 млн на второе полугодие», «план на июль — 5 000 000».",
    input_schema: obj(
      {
        period_start: str("Начало периода yyyy-mm-dd"),
        period_end: str("Конец периода yyyy-mm-dd"),
        amount_rub: int("Сумма плана в рублях"),
      },
      ["period_start", "period_end", "amount_rub"],
    ),
  },
  {
    name: "add_expense",
    permission: "finance:expense",
    description:
      "Записать РАСХОД компании в кассу (реклама, зарплата, налоги, аренда, логистика WB, карго и т.д.). " +
      "Используй на «потратил 15 тысяч на рекламу», «отдал зарплату 200 000», «заплатили 30к за хранение». " +
      "Статью пиши словами — система найдёт подходящую. Если счёт не указан, спишется с основного рублёвого счёта.",
    input_schema: obj(
      {
        amount: int("Сумма расхода (в валюте счёта; для рублёвого счёта — рубли)"),
        category: str("Статья расхода словами: «реклама», «зарплата», «налоги», «карго», «закуп товара»…"),
        account: str("Название счёта, если известно: «наличные», «карта», «юани» (необязательно)"),
        note: str("За что именно (необязательно, но полезно)"),
        date: str("Дата расхода yyyy-mm-dd (по умолчанию сегодня)"),
      },
      ["amount", "category"],
    ),
  },
  {
    name: "add_income",
    permission: "finance:expense",
    description:
      "Записать ПОСТУПЛЕНИЕ денег на счёт (выплата от WB, возврат, пополнение владельцем). " +
      "Используй на «пришло 800 тысяч от WB», «положил в кассу 50 000».",
    input_schema: obj(
      {
        amount: int("Сумма поступления"),
        category: str("Статья прихода словами: «поступление от WB», «пополнение владельцем», «прочий доход»"),
        account: str("На какой счёт (необязательно)"),
        note: str("Комментарий (необязательно)"),
        date: str("Дата yyyy-mm-dd (по умолчанию сегодня)"),
      },
      ["amount", "category"],
    ),
  },
  {
    name: "cash_balance",
    permission: "finance:cash",
    description:
      "Сколько у компании денег и где они лежат: остатки по счетам, приход и расход за текущий месяц. " +
      "Используй на «сколько денег в кассе», «сколько на счетах», «что с деньгами».",
    input_schema: obj({}),
  },
  {
    name: "pnl_report",
    permission: "finance:cash",
    description:
      "ОПиУ: сколько компания реально заработала — выручка, удержания WB, себестоимость, расходы, чистая прибыль и рентабельность по месяцам. " +
      "Используй на «какая прибыль», «сколько заработали в этом месяце», «какая рентабельность».",
    input_schema: obj({
      months: int("За сколько последних месяцев (по умолчанию 3, максимум 12)"),
    }),
  },
  {
    name: "company_expenses",
    permission: "finance:cash",
    description:
      "Расходы КОМПАНИИ по статьям за период (реклама, зарплаты, налоги…) с последними операциями. " +
      "Используй на «на что уходят деньги», «сколько потратили на рекламу», «покажи расходы за месяц». " +
      "Для расходов на закупку товара у фабрик есть отдельный инструмент expenses_report.",
    input_schema: obj({
      days: int("За сколько последних дней (по умолчанию — с начала месяца)"),
    }),
  },

  {
    name: "request_payout",
    permission: "payout:request",
    description:
      "Создать ЗАЯВКУ НА ВЫПЛАТУ: зарплата и аванс, оплата подрядчику или фотографу, счёт фабрики, возмещение расходов сотруднику. " +
      "Используй на «нужно оплатить фотографу 15 тысяч», «попроси аванс 30 000», «фабрика просит 5000 юаней за партию». " +
      "Заявка уходит руководителю на согласование — деньги сами не списываются.",
    input_schema: obj(
      {
        amount: int("Сумма выплаты"),
        title: str("За что выплата (коротко): «съёмка карточек», «аванс за июль», «остаток за партию пижам»"),
        kind: {
          type: "string",
          enum: ["salary", "contractor", "factory", "reimbursement", "other"],
          description: "Тип: salary — зарплата/аванс, contractor — подрядчик/услуги, factory — счёт фабрики, reimbursement — возместить сотруднику, other — прочее",
        },
        currency: { type: "string", enum: ["rub", "kgs", "cny", "uzs"], description: "Валюта (по умолчанию рубли)" },
        payee: str("Кому платим, если не самому заявителю"),
        due_date: str("Оплатить до, yyyy-mm-dd (необязательно)"),
        supply: str("Часть названия поставки, если это счёт фабрики (необязательно)"),
      },
      ["amount", "title"],
    ),
  },
  {
    name: "payouts_list",
    permission: "payout:request",
    description:
      "Показать заявки на выплату: что ждёт согласования, что согласовано и ещё не оплачено, что уже выплачено. " +
      "Сотруднику показываются только его заявки, руководителю — все. Используй на «что по выплатам», «кому мы должны», «согласуй мои заявки».",
    input_schema: obj({}),
  },
  {
    name: "decide_payout",
    permission: "payout:approve",
    description:
      "Согласовать или отклонить заявку на выплату. Заявку ищем по части названия. " +
      "Используй на «согласуй выплату фотографу», «откажи по заявке на аванс».",
    input_schema: obj(
      {
        payout: str("Часть названия заявки"),
        decision: { type: "string", enum: ["approve", "reject"], description: "approve — согласовать, reject — отклонить" },
        note: str("Комментарий или причина отказа (необязательно)"),
      },
      ["payout", "decision"],
    ),
  },
  {
    name: "pay_payout",
    permission: "payout:approve",
    description:
      "Оплатить согласованную заявку: деньги списываются со счёта кассы и попадают в расходы. " +
      "Используй на «оплати заявку фотографу с карты», «выплати аванс наличными».",
    input_schema: obj(
      {
        payout: str("Часть названия заявки"),
        account: str("Название счёта, с которого платим (необязательно — возьмём основной)"),
        paid_on: str("Дата оплаты yyyy-mm-dd (по умолчанию сегодня)"),
      },
      ["payout"],
    ),
  },

  // ────────────────── Цепочка поставок и РАСХОДЫ ──────────────────
  {
    name: "supplies_list",
    permission: "supply:view",
    description:
      "Список карточек отгрузки (поставок): что в пути, что приехало, что принято, сколько оплачено. Используй на «где мои поставки», «что в пути», «покажи отгрузки».",
    input_schema: obj({
      status: {
        type: "string",
        enum: ["in_transit", "arrived", "received", "sorting", "in_stock", "distributed", "cancelled"],
        description: "Фильтр по статусу (необязательно)",
      },
      query: str("Часть названия поставки (необязательно)"),
    }),
  },
  {
    name: "create_factory",
    permission: "factory:edit",
    description:
      "Завести фабрику-производителя (Китай или Узбекистан). Нужна перед созданием первой поставки от этой фабрики.",
    input_schema: obj(
      {
        name: str("Название фабрики"),
        country: { type: "string", enum: ["china", "uzbekistan"], description: "Страна фабрики" },
        note: str("Заметка (необязательно)"),
      },
      ["name", "country"],
    ),
  },
  {
    name: "create_supply",
    permission: "supply:edit",
    description:
      "Создать карточку отгрузки: фабрика, товар, количество, дата отгрузки, стоимость отшивки и карго (мультивалюта ¥/сум/₽). Используй на «заведи поставку с фабрики X — 500 пижам, отшивка 12000 юаней, карго 3000 юаней».",
    input_schema: obj(
      {
        factory: str("Название фабрики (найдём по части названия)"),
        title: str("Наименование поставки / товара"),
        quantity: int("Количество, шт"),
        ship_date: str("Дата отгрузки yyyy-mm-dd (по умолчанию сегодня)"),
        sewing_cost: int("Стоимость отшивки (долг фабрике)"),
        sewing_currency: { type: "string", enum: CURRENCIES, description: "Валюта отшивки (по умолчанию cny)" },
        cargo_cost: int("Стоимость карго (перевозка)"),
        cargo_currency: { type: "string", enum: CURRENCIES, description: "Валюта карго (по умолчанию cny)" },
        product: str("Часть названия товара WB, если поставку надо связать с карточкой (необязательно)"),
      },
      ["factory", "title", "quantity"],
    ),
  },
  {
    name: "add_supply_payment",
    permission: "supply:pay",
    description:
      "ДОБАВИТЬ РАСХОД — оплату по поставке: за товар (goods) или за карго (cargo), мультивалюта ¥/сум/₽. Используй на «оплатили фабрике 5000 юаней за пижамы», «запиши расход на карго 30000 рублей», «добавь оплату по поставке X».",
    input_schema: obj(
      {
        supply: str("Часть названия поставки, по которой платим"),
        kind: { type: "string", enum: ["goods", "cargo"], description: "За товар (goods) или за карго (cargo)" },
        amount: int("Сумма платежа"),
        currency: { type: "string", enum: CURRENCIES, description: "Валюта: cny (юань), uzs (сум), rub (рубль)" },
        paid_at: str("Дата оплаты yyyy-mm-dd (по умолчанию сегодня)"),
        note: str("Комментарий (необязательно)"),
      },
      ["supply", "kind", "amount", "currency"],
    ),
  },
  {
    name: "expenses_report",
    permission: "supply:view",
    description:
      "Оплаты и ДОЛГИ ПО ПОСТАВКАМ: сколько оплачено фабрикам за товар и за карго за период и сколько ещё должны. Это ТОЛЬКО закупка товара. Общие расходы компании (реклама, зарплаты, налоги) — в инструменте company_expenses.",
    input_schema: obj({
      days: int("За сколько последних дней (по умолчанию 30)"),
    }),
  },
  {
    name: "receive_supply",
    permission: "supply:receive",
    description:
      "Приёмка поставки в Москве: сколько коробок/штук реально пришло и комментарий (недостача или «пришёл весь»). Используй на «прими поставку X, пришло 480 из 500, 20 не хватает».",
    input_schema: obj(
      {
        supply: str("Часть названия поставки"),
        received_qty: int("Фактически принято, шт"),
        comment: str("Комментарий приёмки (недостача, брак, «пришёл весь»)"),
      },
      ["supply", "received_qty"],
    ),
  },
  {
    name: "distribute_supply",
    permission: "supply:receive",
    description:
      "Распределить принятую поставку по складам Wildberries. Используй на «отправь 200 на Коледино и 150 на Электросталь по поставке X».",
    input_schema: obj(
      {
        supply: str("Часть названия поставки"),
        warehouse: str("Название склада WB (например «Коледино»)"),
        quantity: int("Сколько штук на этот склад"),
      },
      ["supply", "warehouse", "quantity"],
    ),
  },

  // ───────────────────────────── Дизайн ─────────────────────────────
  {
    name: "design_queue",
    permission: "design:view",
    description:
      "Очередь заявок на дизайн карточек: новые, в работе, на проверке. Используй на «что по дизайну», «какие макеты в работе».",
    input_schema: obj({
      status: {
        type: "string",
        enum: ["new", "in_progress", "review", "done", "rejected"],
        description: "Фильтр по статусу (необязательно)",
      },
    }),
  },
  {
    name: "create_design_request",
    permission: "design:request",
    description:
      "Создать заявку на дизайн карточки (что нужно, какой товар, референсы). Дизайнерам придёт уведомление. Используй на «закажи дизайн слайдов для пижамы, референсы — …».",
    input_schema: obj(
      {
        title: str("Какой товар / что нужно сделать"),
        brief: str("Задача: слайды, обложка, RICH-контент, инфографика"),
        references: str("Референсы: ссылки, примеры, пожелания"),
        product: str("Часть названия товара WB для привязки (необязательно)"),
      },
      ["title"],
    ),
  },
  {
    name: "design_action",
    permission: "design:view",
    description:
      "Действие по заявке на дизайн: take (взять в работу), submit (сдать макет — нужна ссылка), approve (утвердить), return (вернуть на доработку — нужен комментарий), cancel (отменить). Права проверяются: сдают дизайнеры, утверждают руководители.",
    input_schema: obj(
      {
        request: str("Часть названия заявки"),
        action: {
          type: "string",
          enum: ["take", "submit", "approve", "return", "cancel"],
          description: "Что сделать с заявкой",
        },
        result_url: str("Ссылка на макет (обязательна для submit)"),
        comment: str("Комментарий (обязателен для return)"),
      },
      ["request", "action"],
    ),
  },

  // ─────────────────────────────── РНП ───────────────────────────────
  {
    name: "set_rnp_plan",
    permission: "rnp:edit",
    description:
      "Задать недельный план РНП по товару: план заказов, план продаж, план показов, раздачи. Используй на «поставь план на эту неделю по пижаме — 300 заказов, 250 продаж».",
    input_schema: obj(
      {
        product: str("Часть названия товара или артикул WB"),
        plan_orders: int("План заказов, шт"),
        plan_sales: int("План продаж, шт"),
        plan_views: int("План показов"),
        giveaways: int("Раздачи (самовыкупы), шт"),
        week_offset: int("0 — текущая неделя (по умолчанию), 1 — следующая, -1 — прошлая"),
      },
      ["product"],
    ),
  },

  // ─────────────────────────────── Команда ───────────────────────────────
  {
    name: "team_list",
    leadOnly: true,
    description:
      "Состав команды: кто в организации, роли, логины, у кого привязан Telegram. Используй на «кто у нас в команде», «какая роль у Назиры».",
    input_schema: obj({}),
  },
];

export function toolsForRole(role: MemberRole): ToolDef[] {
  return CATALOG.filter((t) => {
    if (t.leadOnly && !isLead(role)) return false;
    if (t.permission && !can(role, t.permission)) return false;
    return true;
  }).map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

// ── Общие помощники ────────────────────────────────────────────────────────

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// Экранирование спецсимволов LIKE — ilike должен работать как «содержит», а не
// как шаблон, иначе «a_iya» матчит «aliya», а «50%» ломает поиск.
function likeSafe(s: string): string {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

function num(n: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(n));
}

function money(amount: number, currency: string): string {
  return `${num(amount)} ${CURRENCY_LABEL[currency] ?? currency}`;
}

const actorOf = (user: SnapshotUser): TaskActor => ({
  id: user.id,
  name: user.name,
  role: user.role,
  roleLabel: user.roleLabel,
});

// Тот же актор, но с типизированной ролью — для правил кассы (cash-core)
const cashActorOf = (user: SnapshotUser): CashActor => ({
  id: user.id,
  name: user.name,
  role: user.role,
  roleLabel: user.roleLabel,
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// id автора для FK-колонок. В вебе сессия может быть демо-заглушкой
// («demo-owner», «anonymous») — такой id не UUID и уронил бы insert по внешнему
// ключу на profiles. Тогда пишем null: авторство неизвестно, запись проходит.
function authorId(user: SnapshotUser): string | null {
  return UUID.test(user.id) ? user.id : null;
}

// Дата из свободного ввода модели: валидная yyyy-mm-dd либо fallback.
function isoOr(input: unknown, fallback: string | null): string | null {
  const s = String(input ?? "").trim();
  return ISO_DATE.test(s) ? s : fallback;
}

function posInt(input: unknown): number | null {
  const n = Number(input);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function currencyOr(input: unknown, fallback: string): string {
  const s = String(input ?? "").trim().toLowerCase();
  return (CURRENCIES as readonly string[]).includes(s) ? s : fallback;
}

// Результат нечёткого поиска: либо одна строка, либо текст-уточнение для модели.
type Pick<T> = { row: T } | { ask: string };

function pickOne<T>(rows: T[], label: (r: T) => string, query: string, what: string): Pick<T> {
  if (!rows.length) return { ask: `${what} «${query}» не найдено. Уточни название.` };
  if (rows.length === 1) return { row: rows[0] };
  // Точное совпадение выигрывает у списка кандидатов
  const norm = query.trim().toLowerCase();
  const exact = rows.filter((r) => label(r).trim().toLowerCase() === norm);
  if (exact.length === 1) return { row: exact[0] };
  return {
    ask: `Нашлось несколько: ${rows.slice(0, 6).map((r) => `«${label(r)}»`).join(", ")}. Уточни, что именно.`,
  };
}

// ── Резолверы сущностей по человеческому вводу ──────────────────────────────

type ProductRow = {
  id: string;
  nm_id: number;
  title: string;
  cost_price: number | null;
  price_discounted_wb: number | null;
};

async function findProducts(db: SupabaseClient, query: string): Promise<ProductRow[]> {
  const q = query.trim();
  if (!q) return [];
  const asNm = Number(q.replace(/\D/g, ""));
  // Артикул вводят цифрами — ищем точно по nm_id, иначе по названию
  if (/^\d{5,}$/.test(q) && Number.isFinite(asNm)) {
    const { data } = await db
      .from("products")
      .select("id, nm_id, title, cost_price, price_discounted_wb")
      .eq("store_id", DEMO_STORE_ID)
      .eq("nm_id", asNm)
      .limit(5);
    if (data?.length) return data as ProductRow[];
  }
  const { data } = await db
    .from("products")
    .select("id, nm_id, title, cost_price, price_discounted_wb")
    .eq("store_id", DEMO_STORE_ID)
    .ilike("title", `%${likeSafe(q)}%`)
    .limit(8);
  return (data ?? []) as ProductRow[];
}

type SupplyRow = {
  id: string;
  title: string;
  quantity: number;
  status: string;
  ship_date: string;
  received_qty: number | null;
  sewing_cost: number;
  sewing_currency: string;
  cargo_cost: number;
  cargo_currency: string;
};

const SUPPLY_FIELDS =
  "id, title, quantity, status, ship_date, received_qty, sewing_cost, sewing_currency, cargo_cost, cargo_currency";

async function findSupplies(db: SupabaseClient, query: string): Promise<SupplyRow[]> {
  const q = query.trim();
  const base = db
    .from("supplies")
    .select(SUPPLY_FIELDS)
    .eq("org_id", DEMO_ORG_ID)
    .order("ship_date", { ascending: false })
    .limit(q ? 8 : 20);
  const { data } = q ? await base.ilike("title", `%${likeSafe(q)}%`) : await base;
  return (data ?? []) as SupplyRow[];
}

// Активные задачи: свои — всем, чужие — только руководителям
type TaskRow = {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  assignee_id: string | null;
  assignee: { full_name: string | null } | { full_name: string | null }[] | null;
};

async function findActiveTasks(
  db: SupabaseClient,
  user: SnapshotUser,
  query: string,
): Promise<TaskRow[]> {
  let q = db
    .from("tasks")
    .select("id, title, status, due_date, assignee_id, assignee:profiles!tasks_assignee_id_fkey(full_name)")
    .eq("org_id", DEMO_ORG_ID)
    .in("status", ["open", "in_progress"])
    .limit(50);
  if (!isLead(user.role)) q = q.eq("assignee_id", user.id);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as TaskRow[];
  const norm = query.trim().toLowerCase();
  return norm ? rows.filter((r) => r.title.toLowerCase().includes(norm)) : rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Задачи
// ─────────────────────────────────────────────────────────────────────────────

async function execCreateTask(
  ctx: ToolCtx,
  input: {
    assignee?: string;
    title?: string;
    description?: string;
    priority?: string;
    due_date?: string;
    product?: string;
  },
): Promise<string> {
  const { db, user } = ctx;
  const q = String(input.assignee ?? "").trim();
  const title = String(input.title ?? "").trim();
  if (!q || !title) return "Ошибка: нужны имя сотрудника и текст задачи.";

  const safe = likeSafe(q.toLowerCase());
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
  const due = isoOr(input.due_date, null);

  // Необязательная привязка к товару — задачи по SKU видны на карточке товара
  let productId: string | null = null;
  if (String(input.product ?? "").trim()) {
    const matches = await findProducts(db, String(input.product));
    if (matches.length === 1) productId = matches[0].id;
  }

  const { data, error } = await db
    .from("tasks")
    .insert({
      org_id: DEMO_ORG_ID,
      title,
      description: String(input.description ?? "").trim() || null,
      priority,
      due_date: due,
      status: "open",
      assignee_id: assignee.id,
      product_id: productId,
      created_by: authorId(user),
    })
    .select("id")
    .single();
  if (error || !data) return `Не удалось создать задачу: ${error?.message ?? "ошибка БД"}`;
  ctx.touch();

  void notifyProfile(
    String(assignee.id),
    `📬 <b>Вам новая задача</b> от ${tgEsc(user.name)} (${tgEsc(user.roleLabel)}):\n«${tgEsc(title)}»\nПриоритет: <b>${priority}</b>${due ? `\nСрок: <b>${due}</b>` : ""}\n\nОткрыть: /menu → 🗒 Мои задачи`,
  );
  return `Задача создана и назначена: ${assignee.full_name}. Уведомление в Telegram отправлено (если привязан).`;
}

async function execMyTasks(ctx: ToolCtx): Promise<string> {
  const { data, error } = await ctx.db
    .from("tasks")
    .select("title, status, priority, due_date")
    .eq("org_id", DEMO_ORG_ID)
    .eq("assignee_id", ctx.user.id)
    .in("status", ["open", "in_progress"])
    .order("due_date", { nullsFirst: false })
    .limit(30);
  if (error) return `Не удалось получить задачи: ${error.message}`;
  const rows = data ?? [];
  if (!rows.length) return "Открытых задач нет.";
  return rows
    .map(
      (t) =>
        `• ${t.title} — ${t.status === "in_progress" ? "в работе" : "открыта"}` +
        `, приоритет ${t.priority}` +
        (t.due_date ? `, срок ${t.due_date}` : ""),
    )
    .join("\n");
}

async function execStartTask(ctx: ToolCtx, input: { task?: string }): Promise<string> {
  const q = String(input.task ?? "").trim();
  if (!q) return "Ошибка: укажите, какую задачу взять в работу.";
  const matches = await findActiveTasks(ctx.db, ctx.user, q);
  const picked = pickOne(matches, (m) => m.title, q, "Активной задачи");
  if ("ask" in picked) return picked.ask;
  const result = await startTask(ctx.db, picked.row.id, actorOf(ctx.user));
  if (result.ok) ctx.touch();
  return result.message;
}

async function execCompleteTask(
  ctx: ToolCtx,
  input: { task?: string; report?: string },
): Promise<string> {
  const q = String(input.task ?? "").trim();
  const report = String(input.report ?? "").trim();
  if (!q) return "Ошибка: укажите, какую задачу закрыть.";
  // Правило системы: без отчёта задача не закрывается ни через одну точку входа
  if (!report) {
    return "Отчёт обязателен. Спроси у сотрудника, ЧТО именно сделано, и повтори вызов с текстом отчёта.";
  }
  const matches = await findActiveTasks(ctx.db, ctx.user, q);
  const picked = pickOne(matches, (m) => m.title, q, "Активной задачи");
  if ("ask" in picked) return picked.ask;
  const result = await completeTask(ctx.db, picked.row.id, actorOf(ctx.user), report);
  if (result.ok) ctx.touch();
  return result.message;
}

async function execCancelTask(
  ctx: ToolCtx,
  input: { task?: string; reason?: string },
): Promise<string> {
  const q = String(input.task ?? "").trim();
  if (!q) return "Ошибка: укажите, какую задачу отменить.";
  const matches = await findActiveTasks(ctx.db, ctx.user, q);
  const picked = pickOne(matches, (m) => m.title, q, "Активной задачи");
  if ("ask" in picked) return picked.ask;
  const result = await cancelTask(ctx.db, picked.row.id, actorOf(ctx.user), input.reason?.trim());
  if (result.ok) ctx.touch();
  return result.message;
}

// ── Отчёт руководителю: что команда сделала / что висит / дисциплина ────────
async function execTeamReport(
  ctx: ToolCtx,
  input: { days?: number; person?: string },
): Promise<string> {
  const { db } = ctx;
  const days = Math.min(30, Math.max(1, Math.round(Number(input.days) || 1)));
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  const person = String(input.person ?? "").trim().toLowerCase();
  const matchPerson = (name: string | null | undefined) =>
    !person || (name ?? "").toLowerCase().includes(person);

  const [doneRes, activeRes, dutyRes] = await Promise.all([
    db
      .from("tasks")
      .select("title, completion_report, completed_at, completed_on_time, assignee:profiles!tasks_assignee_id_fkey(full_name)")
      .eq("org_id", DEMO_ORG_ID)
      .eq("status", "done")
      .gte("completed_at", since.toISOString())
      .order("completed_at", { ascending: false })
      .limit(50),
    db
      .from("tasks")
      .select("title, status, due_date, assignee:profiles!tasks_assignee_id_fkey(full_name)")
      .eq("org_id", DEMO_ORG_ID)
      .in("status", ["open", "in_progress"])
      .limit(50),
    db
      .from("duty_assignments")
      .select("status, assignee:profiles(full_name), template:duty_templates(title)")
      .eq("org_id", DEMO_ORG_ID)
      .eq("task_date", localIsoDate())
      .limit(100),
  ]);

  const lines: string[] = [];

  type DoneRow = { title: string; completion_report: string | null; completed_on_time: boolean | null; assignee: { full_name: string | null } | { full_name: string | null }[] | null };
  const done = ((doneRes.data ?? []) as unknown as DoneRow[]).filter((r) =>
    matchPerson(one(r.assignee)?.full_name),
  );
  lines.push(`ВЫПОЛНЕНО ЗАДАЧ за ${days === 1 ? "сегодня" : `${days} дн.`}: ${done.length}`);
  for (const r of done.slice(0, 15)) {
    lines.push(
      `• ${one(r.assignee)?.full_name ?? "—"}: «${r.title}»${r.completed_on_time === false ? " (после срока)" : ""}` +
        `\n  отчёт: ${(r.completion_report ?? "—").slice(0, 300)}`,
    );
  }

  type ActiveRow = { title: string; status: string; due_date: string | null; assignee: { full_name: string | null } | { full_name: string | null }[] | null };
  const active = ((activeRes.data ?? []) as unknown as ActiveRow[]).filter((r) =>
    matchPerson(one(r.assignee)?.full_name),
  );
  const today = localIsoDate();
  const overdue = active.filter((r) => r.due_date && r.due_date < today);
  lines.push("", `В РАБОТЕ/ОТКРЫТО: ${active.length}, из них просрочено: ${overdue.length}`);
  for (const r of overdue.slice(0, 10)) {
    lines.push(`• ПРОСРОЧЕНО — ${one(r.assignee)?.full_name ?? "—"}: «${r.title}» (срок ${r.due_date})`);
  }

  type DutyRow = { status: string; assignee: { full_name: string | null } | { full_name: string | null }[] | null; template: { title: string } | { title: string }[] | null };
  const duties = ((dutyRes.data ?? []) as unknown as DutyRow[]).filter((r) =>
    matchPerson(one(r.assignee)?.full_name),
  );
  const dutyDone = duties.filter((d) => d.status === "done").length;
  const dutyOpen = duties.filter((d) => d.status !== "done");
  lines.push("", `РЕГЛАМЕНТ СЕГОДНЯ: всего ${duties.length}, выполнено ${dutyDone}, не закрыто ${dutyOpen.length}`);
  for (const d of dutyOpen.slice(0, 10)) {
    lines.push(`• не закрыто — ${one(d.assignee)?.full_name ?? "—"}: ${one(d.template)?.title ?? "задача"}`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Регламент
// ─────────────────────────────────────────────────────────────────────────────

type DutyAssignment = {
  id: string;
  status: string;
  due_at: string;
  org_id: string;
  template: { title: string } | { title: string }[] | null;
};

async function myDutiesToday(db: SupabaseClient, userId: string): Promise<DutyAssignment[]> {
  const { data } = await db
    .from("duty_assignments")
    .select("id, status, due_at, org_id, template:duty_templates(title)")
    .eq("assignee_id", userId)
    .eq("task_date", localIsoDate())
    .order("due_at")
    .limit(30);
  return (data ?? []) as unknown as DutyAssignment[];
}

async function execMyDuties(ctx: ToolCtx): Promise<string> {
  const rows = await myDutiesToday(ctx.db, ctx.user.id);
  if (!rows.length) return "Задач регламента на сегодня нет.";
  const st: Record<string, string> = { pending: "не закрыта", done: "выполнена", missed: "просрочена" };
  return rows
    .map((r) => {
      const time = new Date(r.due_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      const late = r.status !== "done" && new Date(r.due_at).getTime() < Date.now();
      return `• ${one(r.template)?.title ?? "задача"} — до ${time}, ${st[r.status] ?? r.status}${late ? " (срок вышел)" : ""}`;
    })
    .join("\n");
}

async function execCompleteMyDuty(
  ctx: ToolCtx,
  input: { duty?: string; report?: string },
): Promise<string> {
  const q = String(input.duty ?? "").trim();
  const report = String(input.report ?? "").trim();
  if (!q || !report) return "Ошибка: нужны название задачи и текст отчёта.";

  const rows = await myDutiesToday(ctx.db, ctx.user.id);
  const norm = (s: string) => s.toLowerCase();
  const match = rows.find((r) => norm(one(r.template)?.title ?? "").includes(norm(q)));
  if (!match) {
    const titles = rows.map((r) => one(r.template)?.title).filter(Boolean);
    return `Задача «${q}» на сегодня не найдена. Ваши задачи: ${titles.join("; ") || "нет"}.`;
  }
  if (match.status === "done") return "Эта задача уже закрыта.";

  const onTime = Date.now() <= new Date(match.due_at).getTime();
  await ctx.db.from("duty_reports").upsert(
    { org_id: match.org_id, assignment_id: match.id, user_id: ctx.user.id, content: report, on_time: onTime },
    { onConflict: "assignment_id" },
  );
  await ctx.db
    .from("duty_assignments")
    .update({ status: "done", completed_at: new Date().toISOString() })
    .eq("id", match.id);
  ctx.touch();
  return `Задача «${one(match.template)?.title}» закрыта ${onTime ? "вовремя" : "после дедлайна"}, отчёт записан.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Товары и остатки
// ─────────────────────────────────────────────────────────────────────────────

async function execProductInfo(ctx: ToolCtx, input: { query?: string }): Promise<string> {
  const { db } = ctx;
  const q = String(input.query ?? "").trim();
  if (!q) return "Ошибка: укажите название товара.";
  const prods = (await findProducts(db, q)).slice(0, 3);
  if (!prods.length) return `Товар «${q}» не найден в каталоге.`;

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
    let total = 0;
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
      total = [...byWh.values()].reduce((t, v) => t + v, 0);
      const top = [...byWh.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      stockLine = `остаток ${num(total)} шт (топ: ${top.map(([w, v]) => `${w} ${num(v)}`).join(", ")})`;
    }
    const sales30 = salesByNm.get(Number(p.nm_id)) ?? 0;
    const avg = sales30 / 30;
    const cover = avg > 0 ? Math.round(total / avg) : null;
    parts.push(
      `${p.title} (арт. ${p.nm_id}): продажи 30д — ${num(sales30)} шт (~${avg.toFixed(1)}/день), ${stockLine}` +
        (cover !== null ? `, хватит на ${cover} дн` : "") +
        (p.price_discounted_wb != null ? `, цена ${num(Number(p.price_discounted_wb))} ₽` : "") +
        (p.cost_price ? `, себестоимость ${num(Number(p.cost_price))} ₽` : ""),
    );
  }
  return parts.join("\n");
}

async function execStockReport(
  ctx: ToolCtx,
  input: { days?: number; by_warehouse?: boolean },
): Promise<string> {
  const { db } = ctx;

  if (input.by_warehouse) {
    const { data } = await db.rpc("agg_stock_by_warehouse", { p_store: DEMO_STORE_ID });
    const rows = ((data ?? []) as { warehouse: string; qty: number }[])
      .sort((a, b) => Number(b.qty) - Number(a.qty))
      .slice(0, 15);
    if (!rows.length) return "Данных по остаткам нет.";
    const total = rows.reduce((t, r) => t + Number(r.qty), 0);
    return [
      `ОСТАТКИ ПО СКЛАДАМ (топ-15, всего ${num(total)} шт):`,
      ...rows.map((r) => `- ${r.warehouse}: ${num(Number(r.qty))} шт`),
    ].join("\n");
  }

  const threshold = Math.min(90, Math.max(1, Math.round(Number(input.days) || 14)));
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 29);

  const [prodRes, salesRes, stockRes] = await Promise.all([
    db.from("products").select("id, nm_id, title").eq("store_id", DEMO_STORE_ID).limit(1000),
    db.rpc("agg_sales_by_nm", { p_store: DEMO_STORE_ID, p_since: since.toISOString() }),
    db.rpc("agg_stock_by_product", { p_store: DEMO_STORE_ID }),
  ]);
  const salesByNm = new Map(
    ((salesRes.data ?? []) as { nm_id: number; cnt: number }[]).map((r) => [Number(r.nm_id), Number(r.cnt)]),
  );
  const stockById = new Map(
    ((stockRes.data ?? []) as { product_id: string; on_stock: number }[]).map((r) => [r.product_id, Number(r.on_stock)]),
  );
  const items = ((prodRes.data ?? []) as { id: string; nm_id: number; title: string }[])
    .map((p) => {
      const sales30 = salesByNm.get(Number(p.nm_id)) ?? 0;
      const stock = stockById.get(p.id) ?? 0;
      const avg = sales30 / 30;
      return { title: p.title, stock, sales30, cover: avg > 0 ? Math.round(stock / avg) : null };
    })
    .filter((i) => i.cover !== null && i.cover <= threshold)
    .sort((a, b) => (a.cover ?? 0) - (b.cover ?? 0))
    .slice(0, 20);

  if (!items.length) return `Товаров с запасом меньше ${threshold} дней нет.`;
  return [
    `СКОРО ЗАКОНЧАТСЯ (запас < ${threshold} дн):`,
    ...items.map(
      (i) => `- ${i.title}: остаток ${num(i.stock)} шт, продажи 30д ${num(i.sales30)} шт → хватит на ${i.cover} дн`,
    ),
  ].join("\n");
}

async function execUpdateProduct(
  ctx: ToolCtx,
  input: {
    product?: string;
    cost_price?: number;
    logistics_cost?: number;
    status?: string;
    category?: string;
    brand?: string;
  },
): Promise<string> {
  const q = String(input.product ?? "").trim();
  if (!q) return "Ошибка: укажите товар.";
  const matches = await findProducts(ctx.db, q);
  const picked = pickOne(matches, (m) => m.title, q, "Товара");
  if ("ask" in picked) return picked.ask;

  const patch: Record<string, unknown> = {};
  const changed: string[] = [];
  const cost = posInt(input.cost_price);
  if (input.cost_price !== undefined && cost !== null) {
    patch.cost_price = cost;
    changed.push(`себестоимость ${num(cost)} ₽`);
  }
  const logistics = posInt(input.logistics_cost);
  if (input.logistics_cost !== undefined && logistics !== null) {
    patch.logistics_cost = logistics;
    changed.push(`логистика ${num(logistics)} ₽`);
  }
  if (String(input.status ?? "").trim()) {
    patch.status = String(input.status).trim().slice(0, 50);
    changed.push(`статус «${patch.status}»`);
  }
  if (String(input.category ?? "").trim()) {
    patch.category = String(input.category).trim().slice(0, 100);
    changed.push(`категория «${patch.category}»`);
  }
  if (String(input.brand ?? "").trim()) {
    patch.brand = String(input.brand).trim().slice(0, 100);
    changed.push(`бренд «${patch.brand}»`);
  }
  if (!changed.length) return "Ошибка: не указано, что менять (себестоимость, логистика, статус, категория, бренд).";

  const { error } = await ctx.db
    .from("products")
    .update(patch)
    .eq("id", picked.row.id)
    .eq("store_id", DEMO_STORE_ID);
  if (error) return `Не удалось обновить товар: ${error.message}`;
  ctx.touch();
  return `Товар «${picked.row.title}» обновлён: ${changed.join(", ")}.`;
}

async function execCreateProduct(
  ctx: ToolCtx,
  input: {
    nm_id?: number;
    title?: string;
    vendor_code?: string;
    brand?: string;
    category?: string;
    cost_price?: number;
  },
): Promise<string> {
  const nmId = posInt(input.nm_id);
  const title = String(input.title ?? "").trim();
  if (!nmId || !title) return "Ошибка: нужны артикул WB (nm_id) и название товара.";

  const { error } = await ctx.db.from("products").insert({
    store_id: DEMO_STORE_ID,
    nm_id: nmId,
    title: title.slice(0, 200),
    vendor_code: String(input.vendor_code ?? "").trim() || null,
    brand: String(input.brand ?? "").trim() || null,
    category: String(input.category ?? "").trim() || null,
    status: "Новинка",
    cost_price: posInt(input.cost_price) ?? 0,
    responsible_user_id: authorId(ctx.user),
  });
  if (error) {
    // unique (store_id, nm_id)
    if (error.code === "23505") return `Товар с артикулом ${nmId} уже есть в каталоге.`;
    return `Не удалось создать товар: ${error.message}`;
  }
  ctx.touch();
  return `Карточка «${title}» (арт. ${nmId}) создана.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Финансы
// ─────────────────────────────────────────────────────────────────────────────

async function execSetSalesPlan(
  ctx: ToolCtx,
  input: { period_start?: string; period_end?: string; amount_rub?: number },
): Promise<string> {
  const start = isoOr(input.period_start, null);
  const end = isoOr(input.period_end, null);
  const amount = posInt(input.amount_rub);
  if (!start || !end) return "Ошибка: нужны даты начала и конца периода в формате yyyy-mm-dd.";
  if (start >= end) return "Ошибка: начало периода должно быть раньше конца.";
  if (amount === null) return "Ошибка: нужна сумма плана в рублях.";

  const { error } = await ctx.db.from("sales_plans").upsert(
    {
      org_id: DEMO_ORG_ID,
      store_id: DEMO_STORE_ID,
      period_start: start,
      period_end: end,
      amount_rub: amount,
      created_by: authorId(ctx.user),
    },
    { onConflict: "store_id,period_start" },
  );
  if (error) return `Не удалось сохранить план: ${error.message}`;
  ctx.touch();
  return `План продаж на ${start} — ${end} установлен: ${num(amount)} ₽.`;
}

// ── Касса и расходы компании (правила — в data/cash-core) ───────────────────

// Общий разбор «сумма + статья + счёт» для расхода и прихода
async function resolveTxInput(
  ctx: ToolCtx,
  input: { amount?: number; category?: string; account?: string; date?: string },
  direction: "in" | "out",
): Promise<
  | { ok: false; message: string }
  | { ok: true; amount: number; categoryId: string; categoryName: string; accountId: string; accountName: string; date: string }
> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Ошибка: нужна сумма больше нуля." };
  }

  const query = String(input.category ?? "").trim();
  const matches = await findCategories(ctx.db, query, direction);
  if (!matches.length) {
    const all = await findCategories(ctx.db, "", direction);
    return {
      ok: false,
      message:
        `Статья «${query}» не найдена. Доступные: ${all.map((c) => c.name).join(", ")}. ` +
        "Уточни у сотрудника, какая подходит (или предложи создать новую в CRM → Финансы).",
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `Подходит несколько статей: ${matches.map((c) => c.name).join(", ")}. Уточни, какая нужна.`,
    };
  }
  const category = matches[0];

  let account: { id: string; name: string } | null = null;
  const accountQuery = String(input.account ?? "").trim();
  if (accountQuery) {
    const found = await findAccounts(ctx.db, accountQuery);
    if (!found.length) {
      const all = await findAccounts(ctx.db, "");
      return {
        ok: false,
        message: `Счёт «${accountQuery}» не найден. Есть: ${all.map((a) => a.name).join(", ")}.`,
      };
    }
    if (found.length > 1) {
      return {
        ok: false,
        message: `Подходит несколько счетов: ${found.map((a) => a.name).join(", ")}. Уточни, с какого.`,
      };
    }
    account = { id: found[0].id, name: found[0].name };
  } else {
    const fallback = await pickDefaultAccount(ctx.db);
    if (!fallback) {
      return {
        ok: false,
        message: "Счетов кассы ещё нет. Заведите счёт: CRM → Финансы → Касса → «Новый счёт».",
      };
    }
    account = { id: fallback.id, name: fallback.name };
  }

  return {
    ok: true,
    amount,
    categoryId: category.id,
    categoryName: category.name,
    accountId: account.id,
    accountName: account.name,
    date: isoOr(input.date, localIsoDate()) ?? localIsoDate(),
  };
}

async function execAddExpense(
  ctx: ToolCtx,
  input: { amount?: number; category?: string; account?: string; note?: string; date?: string },
): Promise<string> {
  const parsed = await resolveTxInput(ctx, input, "out");
  if (!parsed.ok) return parsed.message;

  const result = await createCashTx(ctx.db, cashActorOf(ctx.user), {
    kind: "out",
    accountId: parsed.accountId,
    categoryId: parsed.categoryId,
    amount: parsed.amount,
    occurredOn: parsed.date,
    note: input.note ? String(input.note) : null,
    source: "ai",
  });
  if (!result.ok) return `Не удалось записать расход: ${result.message}`;
  ctx.touch();
  return (
    `Расход записан: ${num(result.amountRub)} ₽ · статья «${parsed.categoryName}» · ` +
    `счёт «${parsed.accountName}» · дата ${parsed.date}. ` +
    (input.account ? "" : "Счёт выбран автоматически — скажи об этом сотруднику, чтобы он поправил, если платили с другого.")
  );
}

async function execAddIncome(
  ctx: ToolCtx,
  input: { amount?: number; category?: string; account?: string; note?: string; date?: string },
): Promise<string> {
  const parsed = await resolveTxInput(ctx, input, "in");
  if (!parsed.ok) return parsed.message;

  const result = await createCashTx(ctx.db, cashActorOf(ctx.user), {
    kind: "in",
    accountId: parsed.accountId,
    categoryId: parsed.categoryId,
    amount: parsed.amount,
    occurredOn: parsed.date,
    note: input.note ? String(input.note) : null,
    source: "ai",
  });
  if (!result.ok) return `Не удалось записать поступление: ${result.message}`;
  ctx.touch();
  return (
    `Поступление записано: ${num(result.amountRub)} ₽ · статья «${parsed.categoryName}» · ` +
    `счёт «${parsed.accountName}» · дата ${parsed.date}.`
  );
}

async function execCashBalance(ctx: ToolCtx): Promise<string> {
  const view = await getCashOverview(ctx.db);
  if (!view.accounts.length) {
    return "Счетов кассы ещё нет — их заводят в CRM → Финансы → Касса.";
  }
  const lines = [
    `ДЕНЬГИ КОМПАНИИ: всего ${num(view.totalRub)} ₽ по ${view.accounts.length} счетам.`,
    ...view.accounts.map(
      (a) =>
        `- ${a.name}: ${money(a.balance, a.currency)}` +
        (a.currency === "rub" ? "" : ` (≈ ${num(a.balanceRub)} ₽)`) +
        (a.lastTx ? ` · последняя операция ${a.lastTx}` : " · операций не было"),
    ),
    `За текущий месяц: пришло ${num(view.monthInRub)} ₽, ушло ${num(view.monthOutRub)} ₽, ` +
      `итог ${num(view.monthInRub - view.monthOutRub)} ₽.`,
  ];
  if (view.recent.length) {
    lines.push("Последние операции:");
    for (const t of view.recent.slice(0, 5)) {
      const what =
        t.kind === "transfer"
          ? `перевод на «${t.toAccountName ?? "—"}»`
          : `${t.kind === "in" ? "приход" : "расход"} «${t.categoryName ?? "без статьи"}»`;
      lines.push(`- ${t.occurredOn}: ${what} ${num(t.amountRub)} ₽ · счёт «${t.accountName}»${t.note ? ` · ${t.note}` : ""}`);
    }
  }
  return lines.join("\n");
}

async function execPnlReport(ctx: ToolCtx, input: { months?: number }): Promise<string> {
  const months = Math.min(12, Math.max(1, Math.round(Number(input.months) || 3)));
  const view = await getPnlView(ctx.db, months);
  const t = view.total;
  const cur = view.currency === "RUB" ? "₽" : view.currency;
  const money = (v: number) => `${num(v)} ${cur}`;
  const lines = [
    `ПРИБЫЛЬ ЗА ${months} МЕС.${view.hasWbReport ? " (удержания — из отчёта о реализации WB)" : " (отчёт WB не загружен, удержания оценочные)"}:`,
    `- Выручка: ${money(t.revenueRub)} (${num(t.qty)} шт)`,
    `- Удержания WB всего: ${money(t.wbFeesRub)}`,
  ];
  if (view.hasWbReport) {
    lines.push(
      `  · комиссия: ${money(t.commissionRub)}`,
      ...(t.acquiringRub > 0 ? [`  · эквайринг: ${money(t.acquiringRub)}`] : []),
      ...(t.logisticsRub > 0 ? [`  · логистика: ${money(t.logisticsRub)}`] : []),
      ...(t.storageRub > 0 ? [`  · хранение: ${money(t.storageRub)}`] : []),
      ...(t.penaltyRub > 0 ? [`  · штрафы: ${money(t.penaltyRub)}`] : []),
      ...(t.acceptanceRub > 0 ? [`  · платная приёмка: ${money(t.acceptanceRub)}`] : []),
    );
  }
  lines.push(
    `- Себестоимость проданного: ${money(t.cogsRub)}`,
    `- Валовая прибыль: ${money(t.grossRub)}`,
    ...(t.advertRub > 0
      ? [
          `- Реклама WB: ${money(t.advertRub)} (ДРР ${
            t.revenueRub > 0 ? ((t.advertRub / t.revenueRub) * 100).toFixed(1) : "0"
          }%)`,
        ]
      : []),
    `- Расходы компании: ${money(t.opexRub)}`,
    ...(t.otherIncomeRub > 0 ? [`- Прочие доходы: ${money(t.otherIncomeRub)}`] : []),
    `- ЧИСТАЯ ПРИБЫЛЬ: ${money(t.netRub)} (рентабельность ${t.marginPct}%)`,
    "По месяцам:",
    ...view.months.map(
      (m) =>
        `- ${m.label}: выручка ${money(m.revenueRub)}, чистая прибыль ${money(m.netRub)} (${m.marginPct}%)` +
        (m.revenueRub > 0 && m.source === "estimate" ? " — отчёт WB ещё не закрыт, оценка" : ""),
    ),
  );
  if (view.wbBalance) {
    lines.push(
      `На балансе кабинета WB (ещё не перечислено): ${num(view.wbBalance.current)} ${view.wbBalance.currency}.`,
    );
  }
  // Оговорки обязательны: без них цифра прибыли вводит в заблуждение
  if (view.costCoveragePct < 95) {
    lines.push(
      `ВАЖНО: себестоимость заполнена только у ${view.costCoveragePct}% продаж — прибыль завышена. Скажи об этом.`,
    );
  }
  if (!view.hasExpenses) {
    lines.push("ВАЖНО: расходы компании не внесены — прибыль без зарплат, налогов и внешней рекламы.");
  }
  if (view.currency !== "RUB") {
    lines.push(`ВАЖНО: кабинет ведёт расчёты в ${view.currency} — суммы выше в этой валюте, не в рублях.`);
  }
  return lines.join("\n");
}

async function execCompanyExpenses(ctx: ToolCtx, input: { days?: number }): Promise<string> {
  const days = Number(input.days);
  let from: string | undefined;
  if (Number.isFinite(days) && days > 0) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - Math.round(days) + 1);
    from = localIsoDate(d);
  }
  const view = await getExpensesView(ctx.db, from);
  if (!view.items.length) {
    return `РАСХОДЫ КОМПАНИИ за ${view.from} — ${view.to}: записей нет.`;
  }
  return [
    `РАСХОДЫ КОМПАНИИ за ${view.from} — ${view.to}: ${num(view.totalRub)} ₽ (${view.items.length} операций).`,
    `Из них влияют на прибыль: ${num(view.opexRub)} ₽.`,
    "По статьям:",
    ...view.categories.map(
      (c) => `- ${c.name}: ${num(c.amountRub)} ₽ (${c.sharePct}%, ${c.txCount} оп.)${c.inPnl ? "" : " — не влияет на прибыль"}`,
    ),
    "Последние операции:",
    ...view.items
      .slice(0, 8)
      .map(
        (t) =>
          `- ${t.occurredOn}: ${t.categoryName ?? "без статьи"} ${num(t.amountRub)} ₽` +
          `${t.note ? ` · ${t.note}` : ""}${t.authorName ? ` · внёс ${t.authorName}` : ""}`,
      ),
  ].join("\n");
}

// ── Заявки на выплату (правила — в data/payouts-core) ───────────────────────

async function execRequestPayout(
  ctx: ToolCtx,
  input: { amount?: number; title?: string; kind?: string; currency?: string; payee?: string; due_date?: string; supply?: string },
): Promise<string> {
  const kind = ["salary", "contractor", "factory", "reimbursement", "other"].includes(String(input.kind))
    ? (String(input.kind) as PayoutKind)
    : "contractor";

  // Счёт фабрики стараемся привязать к поставке — тогда оплата закроет долг
  let supplyId: string | null = null;
  if (input.supply) {
    const matches = await findSupplies(ctx.db, String(input.supply));
    const picked = pickOne(matches, (m) => m.title, String(input.supply), "Поставки");
    if ("ask" in picked) return picked.ask;
    supplyId = picked.row.id;
  }

  const result = await createPayoutRequest(ctx.db, cashActorOf(ctx.user), {
    kind,
    title: String(input.title ?? "").trim(),
    amount: Number(input.amount),
    currency: (["rub", "kgs", "cny", "uzs"].includes(String(input.currency))
      ? String(input.currency)
      : "rub") as Currency,
    payee: input.payee ? String(input.payee) : null,
    dueDate: input.due_date ? String(input.due_date) : null,
    supplyId,
  });
  if (!result.ok) return `Не удалось создать заявку: ${result.message}`;
  ctx.touch();
  return `${result.message} Руководителю ушло уведомление в Telegram.`;
}

async function execPayoutsList(ctx: ToolCtx): Promise<string> {
  const view = await getPayouts(ctx.db, { id: ctx.user.id, role: ctx.user.role });
  if (!view.items.length) return "ЗАЯВОК НА ВЫПЛАТУ нет.";
  const money = (p: { amount: number; currency: string }) =>
    `${num(p.amount)} ${CURRENCY_LABEL[p.currency] ?? p.currency}`;
  const lines = [
    `ЗАЯВКИ НА ВЫПЛАТУ: ждут решения ${view.pendingCount} на ${num(view.pendingRub)} ₽, ` +
      `согласовано к оплате ${num(view.approvedRub)} ₽, выплачено за месяц ${num(view.paidMonthRub)} ₽.`,
  ];
  for (const p of view.items.slice(0, 15)) {
    lines.push(
      `- «${p.title}» ${money(p)} · ${PAYOUT_KIND_LABELS[p.kind]} · ${PAYOUT_STATUS_LABELS[p.status]} · ` +
        `просит ${p.requesterName}` +
        (p.payee ? ` · кому: ${p.payee}` : "") +
        (p.dueDate ? ` · до ${p.dueDate}` : "") +
        (p.supplyTitle ? ` · поставка «${p.supplyTitle}»` : ""),
    );
  }
  return lines.join("\n");
}

// Поиск заявки по части названия среди тех, что видит пользователь
async function findPayout(
  ctx: ToolCtx,
  query: string,
  statuses: string[],
): Promise<{ ask: string } | { row: { id: string; title: string } }> {
  const view = await getPayouts(ctx.db, { id: ctx.user.id, role: ctx.user.role });
  const pool = view.items.filter((p) => statuses.includes(p.status));
  const norm = query.trim().toLowerCase();
  const matches = norm ? pool.filter((p) => p.title.toLowerCase().includes(norm)) : pool;
  if (!matches.length) {
    return {
      ask: `Заявка «${query}» не найдена среди тех, что ${statuses.includes("approved") ? "ждут оплаты" : "ждут решения"}.`,
    };
  }
  if (matches.length > 1) {
    return { ask: `Подходит несколько заявок: ${matches.map((m) => `«${m.title}»`).join(", ")}. Уточни, какая.` };
  }
  return { row: { id: matches[0].id, title: matches[0].title } };
}

async function execDecidePayout(
  ctx: ToolCtx,
  input: { payout?: string; decision?: string; note?: string },
): Promise<string> {
  const decision = input.decision === "reject" ? "reject" : "approve";
  const found = await findPayout(ctx, String(input.payout ?? ""), ["pending"]);
  if ("ask" in found) return found.ask;
  const res = await decidePayout(ctx.db, cashActorOf(ctx.user), found.row.id, decision, input.note ?? null);
  if (!res.ok) return `Не удалось: ${res.message}`;
  ctx.touch();
  return res.message;
}

async function execPayPayout(
  ctx: ToolCtx,
  input: { payout?: string; account?: string; paid_on?: string },
): Promise<string> {
  const found = await findPayout(ctx, String(input.payout ?? ""), ["approved", "pending"]);
  if ("ask" in found) return found.ask;

  let accountId: string | null = null;
  if (input.account) {
    const accounts = await findAccounts(ctx.db, String(input.account));
    if (!accounts.length) return `Счёт «${input.account}» не найден.`;
    if (accounts.length > 1) {
      return `Подходит несколько счетов: ${accounts.map((a) => a.name).join(", ")}. Уточни, с какого платим.`;
    }
    accountId = accounts[0].id;
  } else {
    const fallback = await pickDefaultAccount(ctx.db);
    if (!fallback) return "Счетов кассы ещё нет — заведите счёт в CRM → Финансы → Касса.";
    accountId = fallback.id;
  }

  const res = await payPayout(ctx.db, cashActorOf(ctx.user), found.row.id, accountId, {
    paidOn: input.paid_on ?? null,
  });
  if (!res.ok) return `Не удалось оплатить: ${res.message}`;
  ctx.touch();
  return `${res.message}${input.account ? "" : " Счёт выбран автоматически — скажи об этом сотруднику."}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Цепочка поставок и расходы
// ─────────────────────────────────────────────────────────────────────────────

const SUPPLY_STATUS_RU: Record<string, string> = {
  in_transit: "в пути",
  arrived: "приехал",
  received: "принят",
  sorting: "в разборе",
  in_stock: "на складе",
  distributed: "распределён по WB",
  cancelled: "отменён",
};

async function execSuppliesList(
  ctx: ToolCtx,
  input: { status?: string; query?: string },
): Promise<string> {
  let rows = await findSupplies(ctx.db, String(input.query ?? ""));
  const status = String(input.status ?? "").trim();
  if (status) rows = rows.filter((r) => r.status === status);
  if (!rows.length) return "Подходящих карточек отгрузки нет.";

  // Оплаты по найденным поставкам — одним запросом, чтобы показать «сколько закрыто»
  const { data: pays } = await ctx.db
    .from("supply_payments")
    .select("supply_id, kind, amount, currency")
    .in("supply_id", rows.map((r) => r.id));
  const paidRub = new Map<string, number>();
  for (const p of (pays ?? []) as { supply_id: string; amount: number; currency: string }[]) {
    paidRub.set(p.supply_id, (paidRub.get(p.supply_id) ?? 0) + toRub(Number(p.amount), p.currency));
  }

  return [
    `ПОСТАВКИ (${rows.length}):`,
    ...rows.slice(0, 15).map((r) => {
      const costRub = toRub(Number(r.sewing_cost), r.sewing_currency) + toRub(Number(r.cargo_cost), r.cargo_currency);
      const paid = paidRub.get(r.id) ?? 0;
      const debt = Math.max(0, costRub - paid);
      return (
        `- «${r.title}»: ${num(r.quantity)} шт, отгружена ${r.ship_date}, статус «${SUPPLY_STATUS_RU[r.status] ?? r.status}»` +
        (r.received_qty != null ? `, принято ${num(r.received_qty)} шт` : "") +
        `, стоимость ~${num(costRub)} ₽, оплачено ${num(paid)} ₽` +
        (debt > 0 ? `, остаток долга ~${num(debt)} ₽` : ", закрыта полностью")
      );
    }),
  ].join("\n");
}

async function execCreateFactory(
  ctx: ToolCtx,
  input: { name?: string; country?: string; note?: string },
): Promise<string> {
  const name = String(input.name ?? "").trim();
  const country = String(input.country ?? "").trim();
  if (!name) return "Ошибка: нужно название фабрики.";
  if (!["china", "uzbekistan"].includes(country)) {
    return "Ошибка: страна должна быть china (Китай) или uzbekistan (Узбекистан).";
  }
  const { error } = await ctx.db.from("factories").insert({
    org_id: DEMO_ORG_ID,
    name: name.slice(0, 200),
    country,
    note: String(input.note ?? "").trim() || null,
  });
  if (error) {
    if (error.code === "23505") return `Фабрика «${name}» уже заведена.`;
    return `Не удалось создать фабрику: ${error.message}`;
  }
  ctx.touch();
  return `Фабрика «${name}» (${country === "china" ? "Китай" : "Узбекистан"}) добавлена.`;
}

async function execCreateSupply(
  ctx: ToolCtx,
  input: {
    factory?: string;
    title?: string;
    quantity?: number;
    ship_date?: string;
    sewing_cost?: number;
    sewing_currency?: string;
    cargo_cost?: number;
    cargo_currency?: string;
    product?: string;
  },
): Promise<string> {
  const { db } = ctx;
  const factoryQ = String(input.factory ?? "").trim();
  const title = String(input.title ?? "").trim();
  const quantity = posInt(input.quantity);
  if (!factoryQ || !title || quantity === null) {
    return "Ошибка: нужны фабрика, наименование поставки и количество.";
  }

  const { data: factories } = await db
    .from("factories")
    .select("id, name, country")
    .eq("org_id", DEMO_ORG_ID)
    .ilike("name", `%${likeSafe(factoryQ)}%`)
    .limit(8);
  const picked = pickOne((factories ?? []) as { id: string; name: string }[], (f) => f.name, factoryQ, "Фабрики");
  if ("ask" in picked) {
    return picked.ask + " Если фабрики ещё нет — заведи её инструментом create_factory.";
  }

  let productId: string | null = null;
  if (String(input.product ?? "").trim()) {
    const matches = await findProducts(db, String(input.product));
    if (matches.length === 1) productId = matches[0].id;
  }

  const { error } = await db.from("supplies").insert({
    org_id: DEMO_ORG_ID,
    store_id: DEMO_STORE_ID,
    factory_id: picked.row.id,
    product_id: productId,
    title: title.slice(0, 200),
    quantity,
    ship_date: isoOr(input.ship_date, localIsoDate()),
    sewing_cost: posInt(input.sewing_cost) ?? 0,
    sewing_currency: currencyOr(input.sewing_currency, "cny"),
    cargo_cost: posInt(input.cargo_cost) ?? 0,
    cargo_currency: currencyOr(input.cargo_currency, "cny"),
    status: "in_transit",
    created_by: authorId(ctx.user),
  });
  if (error) return `Не удалось создать поставку: ${error.message}`;
  ctx.touch();
  return `Поставка «${title}» с фабрики «${picked.row.name}» создана: ${num(quantity)} шт, статус «в пути».`;
}

// ── РАСХОД: оплата по поставке (за товар или за карго) ──────────────────────
async function execAddSupplyPayment(
  ctx: ToolCtx,
  input: {
    supply?: string;
    kind?: string;
    amount?: number;
    currency?: string;
    paid_at?: string;
    note?: string;
  },
): Promise<string> {
  const supplyQ = String(input.supply ?? "").trim();
  const kind = String(input.kind ?? "").trim();
  const amount = posInt(input.amount);
  if (!supplyQ) return "Ошибка: укажите, по какой поставке платим.";
  if (!["goods", "cargo"].includes(kind)) {
    return "Ошибка: вид расхода должен быть goods (за товар) или cargo (за карго).";
  }
  if (amount === null || amount === 0) return "Ошибка: нужна сумма платежа больше нуля.";
  const currency = currencyOr(input.currency, "");
  if (!currency) return "Ошибка: нужна валюта — cny (юань), uzs (сум) или rub (рубль).";

  const matches = await findSupplies(ctx.db, supplyQ);
  const picked = pickOne(matches, (m) => m.title, supplyQ, "Поставки");
  if ("ask" in picked) return picked.ask;
  const supply = picked.row;

  const paidAt = isoOr(input.paid_at, localIsoDate())!;
  const { data: payment, error } = await ctx.db
    .from("supply_payments")
    .insert({
      supply_id: supply.id,
      kind,
      amount,
      currency,
      paid_at: paidAt,
      note: String(input.note ?? "").trim() || null,
      created_by: authorId(ctx.user),
    })
    .select("id")
    .single();
  if (error || !payment) return `Не удалось записать расход: ${error?.message ?? "ошибка БД"}`;
  ctx.touch();

  // Оплата уменьшает деньги на счетах — отражаем в кассе (если есть счёт в этой валюте)
  await mirrorSupplyPaymentToCash(ctx.db, cashActorOf(ctx.user), {
    id: String(payment.id),
    kind: kind as "goods" | "cargo",
    amount,
    currency: currency as Currency,
    paidAt,
    note: String(input.note ?? "").trim() || null,
    supplyTitle: supply.title,
  });

  // Сколько осталось должны по этой поставке — самое частое, что спросят следом
  const { data: pays } = await ctx.db
    .from("supply_payments")
    .select("amount, currency")
    .eq("supply_id", supply.id);
  const paidRub = ((pays ?? []) as { amount: number; currency: string }[]).reduce(
    (t, p) => t + toRub(Number(p.amount), p.currency),
    0,
  );
  const costRub =
    toRub(Number(supply.sewing_cost), supply.sewing_currency) +
    toRub(Number(supply.cargo_cost), supply.cargo_currency);
  const debt = Math.max(0, costRub - paidRub);

  return (
    `Расход записан: ${money(amount, currency)} за ${kind === "goods" ? "товар" : "карго"} ` +
    `по поставке «${supply.title}», дата ${paidAt}. ` +
    `Всего оплачено ~${num(paidRub)} ₽ из ~${num(costRub)} ₽` +
    (debt > 0 ? `, остаток долга ~${num(debt)} ₽.` : " — поставка закрыта полностью.")
  );
}

async function execExpensesReport(ctx: ToolCtx, input: { days?: number }): Promise<string> {
  const { db } = ctx;
  const days = Math.min(365, Math.max(1, Math.round(Number(input.days) || 30)));
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  // Локальная дата, НЕ toISOString: в поясе UTC+5/6 он отдаёт предыдущие сутки
  // и период молча уезжал бы на день (paid_at хранится как date).
  const sinceIso = localIsoDate(since);

  // Только те поля, что реально нужны для сумм — тип по срезу, а не по всей
  // строке поставки, иначе легко начать читать колонку, которой нет в select.
  type CostRow = {
    id: string;
    title: string;
    sewing_cost: number;
    sewing_currency: string;
    cargo_cost: number;
    cargo_currency: string;
  };
  const { data: supplies } = await db
    .from("supplies")
    .select("id, title, sewing_cost, sewing_currency, cargo_cost, cargo_currency, status")
    .eq("org_id", DEMO_ORG_ID)
    .neq("status", "cancelled")
    .limit(500);
  const rows = (supplies ?? []) as CostRow[];
  if (!rows.length) return "Поставок нет — расходов на закупку тоже.";

  const { data: pays } = await db
    .from("supply_payments")
    .select("supply_id, kind, amount, currency, paid_at")
    .in("supply_id", rows.map((r) => r.id))
    .limit(2000);
  const payments = (pays ?? []) as {
    supply_id: string;
    kind: string;
    amount: number;
    currency: string;
    paid_at: string;
  }[];

  // За период — по видам и по валютам (валюты не складываем, только пересчёт в ₽)
  const inPeriod = payments.filter((p) => p.paid_at >= sinceIso);
  const byKind = { goods: 0, cargo: 0 };
  const byCurrency: Record<string, number> = {};
  for (const p of inPeriod) {
    const rub = toRub(Number(p.amount), p.currency);
    if (p.kind === "goods") byKind.goods += rub;
    else byKind.cargo += rub;
    byCurrency[p.currency] = (byCurrency[p.currency] ?? 0) + Number(p.amount);
  }

  // Долг: полная стоимость всех поставок минус все оплаты за всё время
  const totalCost = rows.reduce(
    (t, r) => t + toRub(Number(r.sewing_cost), r.sewing_currency) + toRub(Number(r.cargo_cost), r.cargo_currency),
    0,
  );
  const totalPaid = payments.reduce((t, p) => t + toRub(Number(p.amount), p.currency), 0);

  // Топ незакрытых поставок — по ним и придут вопросы «кому должны»
  const paidBySupply = new Map<string, number>();
  for (const p of payments) {
    paidBySupply.set(p.supply_id, (paidBySupply.get(p.supply_id) ?? 0) + toRub(Number(p.amount), p.currency));
  }
  const debts = rows
    .map((r) => ({
      title: r.title,
      debt:
        toRub(Number(r.sewing_cost), r.sewing_currency) +
        toRub(Number(r.cargo_cost), r.cargo_currency) -
        (paidBySupply.get(r.id) ?? 0),
    }))
    .filter((d) => d.debt > 0)
    .sort((a, b) => b.debt - a.debt)
    .slice(0, 8);

  const lines = [
    `РАСХОДЫ НА ЗАКУПКУ за ${days} дн (курсы: ¥ 12,5 ₽ / сум 0,0068 ₽):`,
    `- Всего оплачено за период: ${num(byKind.goods + byKind.cargo)} ₽ (${inPeriod.length} платежей)`,
    `- За товар (отшивка): ${num(byKind.goods)} ₽`,
    `- За карго (перевозка): ${num(byKind.cargo)} ₽`,
  ];
  const curParts = Object.entries(byCurrency).map(([c, a]) => money(a, c));
  if (curParts.length) lines.push(`- По валютам: ${curParts.join(", ")}`);
  lines.push(
    "",
    "ВСЕГО ПО ВСЕМ ПОСТАВКАМ:",
    `- Стоимость поставок: ${num(totalCost)} ₽`,
    `- Оплачено: ${num(totalPaid)} ₽`,
    `- Остаток долга: ${num(Math.max(0, totalCost - totalPaid))} ₽`,
  );
  if (debts.length) {
    lines.push("", "НЕ ЗАКРЫТЫ (топ по сумме долга):");
    debts.forEach((d) => lines.push(`- «${d.title}»: ${num(d.debt)} ₽`));
  }
  return lines.join("\n");
}

async function execReceiveSupply(
  ctx: ToolCtx,
  input: { supply?: string; received_qty?: number; comment?: string },
): Promise<string> {
  const q = String(input.supply ?? "").trim();
  const received = posInt(input.received_qty);
  if (!q) return "Ошибка: укажите поставку.";
  if (received === null) return "Ошибка: укажите, сколько штук фактически принято.";

  const matches = await findSupplies(ctx.db, q);
  const picked = pickOne(matches, (m) => m.title, q, "Поставки");
  if ("ask" in picked) return picked.ask;
  const supply = picked.row;
  if (["received", "sorting", "in_stock", "distributed"].includes(supply.status)) {
    return `Поставка «${supply.title}» уже принята (статус «${SUPPLY_STATUS_RU[supply.status]}»).`;
  }

  const now = new Date();
  const transitDays = Math.max(
    0,
    Math.round((now.getTime() - new Date(supply.ship_date).getTime()) / 86_400_000),
  );
  const { error } = await ctx.db
    .from("supplies")
    .update({
      status: "received",
      received_at: now.toISOString(),
      received_qty: received,
      receipt_comment: String(input.comment ?? "").trim() || null,
      transit_days: transitDays,
    })
    .eq("id", supply.id);
  if (error) return `Не удалось провести приёмку: ${error.message}`;
  ctx.touch();

  const shortfall = supply.quantity - received;
  if (shortfall > 0) {
    void notifyRoles(
      ["owner", "admin", "manager"],
      `📦 <b>Приёмка с недостачей</b>: «${tgEsc(supply.title)}»\n` +
        `Отгружено ${supply.quantity} шт, принято ${received} шт — <b>не хватает ${shortfall} шт</b>.\n` +
        `Принял: ${tgEsc(ctx.user.name)}`,
    );
  }
  return (
    `Поставка «${supply.title}» принята: ${num(received)} шт из ${num(supply.quantity)} шт, ` +
    `в пути была ${transitDays} дн.` +
    (shortfall > 0 ? ` Недостача ${num(shortfall)} шт — руководству отправлено уведомление.` : " Пришла полностью.")
  );
}

async function execDistributeSupply(
  ctx: ToolCtx,
  input: { supply?: string; warehouse?: string; quantity?: number },
): Promise<string> {
  const q = String(input.supply ?? "").trim();
  const warehouse = String(input.warehouse ?? "").trim();
  const quantity = posInt(input.quantity);
  if (!q || !warehouse || quantity === null || quantity === 0) {
    return "Ошибка: нужны поставка, склад WB и количество больше нуля.";
  }

  const matches = await findSupplies(ctx.db, q);
  const picked = pickOne(matches, (m) => m.title, q, "Поставки");
  if ("ask" in picked) return picked.ask;
  const supply = picked.row;
  if (!["received", "sorting", "in_stock", "distributed"].includes(supply.status)) {
    return `Поставку «${supply.title}» сначала нужно принять (сейчас статус «${SUPPLY_STATUS_RU[supply.status]}»).`;
  }

  const { data: prev } = await ctx.db
    .from("wb_distributions")
    .select("quantity")
    .eq("supply_id", supply.id);
  const already = ((prev ?? []) as { quantity: number }[]).reduce((t, r) => t + Number(r.quantity), 0);
  const capacity = supply.received_qty ?? supply.quantity;
  if (already + quantity > capacity) {
    return `Нельзя распределить ${num(quantity)} шт: принято ${num(capacity)} шт, уже распределено ${num(already)} шт. Осталось ${num(capacity - already)} шт.`;
  }

  const { error } = await ctx.db.from("wb_distributions").insert({
    supply_id: supply.id,
    warehouse: warehouse.slice(0, 200),
    quantity,
    created_by: authorId(ctx.user),
  });
  if (error) return `Не удалось распределить: ${error.message}`;

  const total = already + quantity;
  // Всё разложено по складам → карточка переходит в финальный статус
  if (total >= capacity) {
    await ctx.db.from("supplies").update({ status: "distributed" }).eq("id", supply.id);
  } else if (supply.status === "received") {
    await ctx.db.from("supplies").update({ status: "sorting" }).eq("id", supply.id);
  }
  ctx.touch();

  return (
    `На склад «${warehouse}» отправлено ${num(quantity)} шт из поставки «${supply.title}». ` +
    (total >= capacity
      ? "Поставка распределена полностью."
      : `Осталось распределить ${num(capacity - total)} шт.`)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Дизайн
// ─────────────────────────────────────────────────────────────────────────────

const DESIGN_STATUS_RU: Record<string, string> = {
  new: "новая",
  in_progress: "в работе",
  review: "на проверке",
  done: "утверждена",
  rejected: "отменена",
};

type DesignRow = {
  id: string;
  title: string;
  status: string;
  brief: string | null;
  result_url: string | null;
  requester_id: string | null;
  assignee_id: string | null;
  assignee: { full_name: string | null } | { full_name: string | null }[] | null;
};

async function execDesignQueue(ctx: ToolCtx, input: { status?: string }): Promise<string> {
  let q = ctx.db
    .from("design_requests")
    .select("id, title, status, brief, result_url, requester_id, assignee_id, assignee:profiles!design_requests_assignee_id_fkey(full_name)")
    .eq("org_id", DEMO_ORG_ID)
    .order("created_at", { ascending: false })
    .limit(25);
  const status = String(input.status ?? "").trim();
  if (status) q = q.eq("status", status);
  else q = q.in("status", ["new", "in_progress", "review"]);

  const { data, error } = await q;
  if (error) return `Не удалось загрузить очередь дизайна: ${error.message}`;
  const rows = (data ?? []) as unknown as DesignRow[];
  if (!rows.length) return "Заявок на дизайн нет.";
  return [
    `ЗАЯВКИ НА ДИЗАЙН (${rows.length}):`,
    ...rows.map(
      (r) =>
        `- «${r.title}» — ${DESIGN_STATUS_RU[r.status] ?? r.status}` +
        (one(r.assignee)?.full_name ? `, дизайнер ${one(r.assignee)!.full_name}` : "") +
        (r.result_url ? `, макет: ${r.result_url}` : ""),
    ),
  ].join("\n");
}

async function execCreateDesignRequest(
  ctx: ToolCtx,
  input: { title?: string; brief?: string; references?: string; product?: string },
): Promise<string> {
  const title = String(input.title ?? "").trim();
  if (!title) return "Ошибка: нужно описание, что и для какого товара нарисовать.";

  let productId: string | null = null;
  if (String(input.product ?? "").trim()) {
    const matches = await findProducts(ctx.db, String(input.product));
    if (matches.length === 1) productId = matches[0].id;
  }

  const { error } = await ctx.db.from("design_requests").insert({
    org_id: DEMO_ORG_ID,
    product_id: productId,
    title: title.slice(0, 200),
    brief: String(input.brief ?? "").trim() || null,
    references_text: String(input.references ?? "").trim() || null,
    status: "new",
    requester_id: authorId(ctx.user),
  });
  if (error) return `Не удалось создать заявку: ${error.message}`;
  ctx.touch();

  void notifyRoles(
    ["designer", "seo"],
    `🎨 <b>Новая заявка на дизайн</b> от ${tgEsc(ctx.user.name)}:\n«${tgEsc(title)}»\n\nВзять в работу: CRM → Дизайн`,
  );
  return `Заявка на дизайн «${title}» создана, дизайнерам отправлено уведомление.`;
}

// Переходы зеркалят /api/design/[id] — правила жизненного цикла одни на все входы
const DESIGN_TRANSITIONS: Record<string, { from: string[]; to: string; need: Permission }> = {
  take: { from: ["new"], to: "in_progress", need: "design:submit" },
  submit: { from: ["in_progress", "new"], to: "review", need: "design:submit" },
  approve: { from: ["review"], to: "done", need: "design:approve" },
  return: { from: ["review"], to: "in_progress", need: "design:approve" },
  cancel: { from: ["new", "in_progress", "review"], to: "rejected", need: "design:approve" },
};

async function execDesignAction(
  ctx: ToolCtx,
  input: { request?: string; action?: string; result_url?: string; comment?: string },
): Promise<string> {
  const q = String(input.request ?? "").trim();
  const action = String(input.action ?? "").trim();
  const transition = DESIGN_TRANSITIONS[action];
  if (!q) return "Ошибка: укажите заявку.";
  if (!transition) return "Ошибка: действие должно быть take, submit, approve, return или cancel.";
  if (!can(ctx.user.role, transition.need)) {
    return transition.need === "design:submit"
      ? "Ошибка: брать в работу и сдавать макеты могут только дизайнеры."
      : "Ошибка: утверждать и отменять заявки может только руководитель.";
  }
  const resultUrl = String(input.result_url ?? "").trim();
  const comment = String(input.comment ?? "").trim();
  if (action === "submit" && !resultUrl) {
    return "Для сдачи макета нужна ссылка на файл (Figma/диск). Спроси её у дизайнера.";
  }
  if (action === "return" && !comment) {
    return "Чтобы вернуть на доработку, нужен комментарий — что именно поправить. Спроси его.";
  }

  const { data } = await ctx.db
    .from("design_requests")
    .select("id, title, status, requester_id, assignee_id")
    .eq("org_id", DEMO_ORG_ID)
    .ilike("title", `%${likeSafe(q)}%`)
    .limit(8);
  const rows = (data ?? []) as DesignRow[];
  const picked = pickOne(rows, (r) => r.title, q, "Заявки на дизайн");
  if ("ask" in picked) return picked.ask;
  const req = picked.row;

  if (!transition.from.includes(req.status)) {
    return `Заявка «${req.title}» сейчас в статусе «${DESIGN_STATUS_RU[req.status] ?? req.status}» — это действие сейчас недоступно.`;
  }

  const patch: Record<string, unknown> = { status: transition.to };
  if (action === "take") patch.assignee_id = authorId(ctx.user);
  if (action === "submit") {
    patch.result_url = resultUrl;
    patch.result_comment = comment || null;
    patch.assignee_id = authorId(ctx.user);
  }
  if (["approve", "return", "cancel"].includes(action)) patch.review_comment = comment || null;

  const { error } = await ctx.db.from("design_requests").update(patch).eq("id", req.id);
  if (error) return `Не удалось обновить заявку: ${error.message}`;
  ctx.touch();

  const title = tgEsc(req.title);
  const who = tgEsc(ctx.user.name);
  if (action === "submit") {
    if (req.requester_id) {
      void notifyProfile(
        String(req.requester_id),
        `🎨 <b>Макет готов</b>: «${title}»\nДизайнер: ${who}. Смотреть: CRM → Дизайн → На проверке`,
      );
    }
    void notifyRoles(["owner", "manager"], `🎨 Макет «${title}» ждёт утверждения (сдал: ${who}). CRM → Дизайн`);
  } else if ((action === "approve" || action === "return") && req.assignee_id) {
    void notifyProfile(
      String(req.assignee_id),
      action === "approve"
        ? `✅ <b>Дизайн утверждён</b>: «${title}» (${who})${comment ? `\nКомментарий: ${tgEsc(comment)}` : ""}`
        : `↩️ <b>Дизайн вернули на доработку</b>: «${title}» (${who})\nКомментарий: ${tgEsc(comment)}`,
    );
  }

  return `Заявка «${req.title}» → статус «${DESIGN_STATUS_RU[transition.to]}».`;
}

// ─────────────────────────────────────────────────────────────────────────────
// РНП (план по товару на неделю)
// ─────────────────────────────────────────────────────────────────────────────

// ISO-неделя: год и номер недели по стандарту, как в rnp_plans (iso_year/iso_week)
function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // пн=1 … вс=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // четверг той же недели
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

async function execSetRnpPlan(
  ctx: ToolCtx,
  input: {
    product?: string;
    plan_orders?: number;
    plan_sales?: number;
    plan_views?: number;
    giveaways?: number;
    week_offset?: number;
  },
): Promise<string> {
  const q = String(input.product ?? "").trim();
  if (!q) return "Ошибка: укажите товар.";
  const matches = await findProducts(ctx.db, q);
  const picked = pickOne(matches, (m) => m.title, q, "Товара");
  if ("ask" in picked) return picked.ask;

  const offset = Math.max(-8, Math.min(8, Math.round(Number(input.week_offset) || 0)));
  const target = new Date();
  target.setDate(target.getDate() + offset * 7);
  const { year, week } = isoWeek(target);

  const patch: Record<string, unknown> = {
    product_id: picked.row.id,
    iso_year: year,
    iso_week: week,
    responsible_user_id: authorId(ctx.user),
    updated_at: new Date().toISOString(),
  };
  const changed: string[] = [];
  const fields: Array<[keyof typeof input, string, string]> = [
    ["plan_orders", "plan_orders", "план заказов"],
    ["plan_sales", "plan_sales", "план продаж"],
    ["plan_views", "plan_views", "план показов"],
    ["giveaways", "giveaways", "раздачи"],
  ];
  for (const [key, column, label] of fields) {
    const v = posInt(input[key]);
    if (input[key] !== undefined && v !== null) {
      patch[column] = v;
      changed.push(`${label} ${num(v)}`);
    }
  }
  if (!changed.length) return "Ошибка: не указано ни одного планового показателя.";

  const { error } = await ctx.db.from("rnp_plans").upsert(patch, { onConflict: "product_id,iso_year,iso_week" });
  if (error) return `Не удалось сохранить план РНП: ${error.message}`;
  ctx.touch();
  return `План РНП по «${picked.row.title}» на неделю ${week}/${year}: ${changed.join(", ")}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Команда
// ─────────────────────────────────────────────────────────────────────────────

async function execTeamList(ctx: ToolCtx): Promise<string> {
  const { data, error } = await ctx.db
    .from("org_members")
    .select("role, profile:profiles(full_name, login, telegram_id)")
    .eq("org_id", DEMO_ORG_ID);
  if (error) return `Не удалось загрузить команду: ${error.message}`;
  const rows = (data ?? []) as unknown as Array<{
    role: string;
    profile: { full_name: string | null; login: string | null; telegram_id: number | null } | null;
  }>;
  if (!rows.length) return "Участников нет.";
  return [
    `КОМАНДА (${rows.length}):`,
    ...rows.map((m) => {
      const p = one(m.profile);
      return (
        `- ${p?.full_name ?? "—"} · роль ${m.role}` +
        (p?.login ? ` · логин ${p.login}` : "") +
        (p?.telegram_id ? " · Telegram привязан" : " · Telegram НЕ привязан")
      );
    }),
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Диспетчер
// ─────────────────────────────────────────────────────────────────────────────

type Handler = (ctx: ToolCtx, input: Record<string, never>) => Promise<string>;

const HANDLERS: Record<string, Handler> = {
  my_tasks: (ctx) => execMyTasks(ctx),
  create_task: execCreateTask as Handler,
  start_task: execStartTask as Handler,
  complete_task: execCompleteTask as Handler,
  cancel_task: execCancelTask as Handler,
  team_report: execTeamReport as Handler,
  my_duties: (ctx) => execMyDuties(ctx),
  complete_my_duty: execCompleteMyDuty as Handler,
  product_info: execProductInfo as Handler,
  stock_report: execStockReport as Handler,
  update_product: execUpdateProduct as Handler,
  create_product: execCreateProduct as Handler,
  set_sales_plan: execSetSalesPlan as Handler,
  add_expense: execAddExpense as Handler,
  add_income: execAddIncome as Handler,
  cash_balance: (ctx) => execCashBalance(ctx),
  pnl_report: execPnlReport as Handler,
  company_expenses: execCompanyExpenses as Handler,
  request_payout: execRequestPayout as Handler,
  payouts_list: (ctx) => execPayoutsList(ctx),
  decide_payout: execDecidePayout as Handler,
  pay_payout: execPayPayout as Handler,
  supplies_list: execSuppliesList as Handler,
  create_factory: execCreateFactory as Handler,
  create_supply: execCreateSupply as Handler,
  add_supply_payment: execAddSupplyPayment as Handler,
  expenses_report: execExpensesReport as Handler,
  receive_supply: execReceiveSupply as Handler,
  distribute_supply: execDistributeSupply as Handler,
  design_queue: execDesignQueue as Handler,
  create_design_request: execCreateDesignRequest as Handler,
  design_action: execDesignAction as Handler,
  set_rnp_plan: execSetRnpPlan as Handler,
  team_list: (ctx) => execTeamList(ctx),
};

// Имя инструмента → исполнение. Возвращает текст для tool_result.
// Права проверяются ЗДЕСЬ (по тому же каталогу, что и выдача инструментов):
// модель может выдумать имя или роль могла смениться между вызовами.
export async function executeTool(
  db: SupabaseClient,
  user: SnapshotUser,
  name: string,
  input: Record<string, unknown>,
  onMutation?: () => void,
): Promise<string> {
  const spec = CATALOG.find((t) => t.name === name);
  const handler = HANDLERS[name];
  if (!spec || !handler) return `Неизвестный инструмент: ${name}`;
  if (spec.leadOnly && !isLead(user.role)) {
    return "Ошибка: это действие доступно только руководителю (директор, администратор, старший менеджер).";
  }
  if (spec.permission && !can(user.role, spec.permission)) {
    return `Ошибка: у роли «${user.roleLabel}» нет прав на это действие.`;
  }

  try {
    return await handler({ db, user, touch: () => onMutation?.() }, input as Record<string, never>);
  } catch (e) {
    console.error(`[ai/tools] ${name}:`, e);
    return "Ошибка выполнения действия, попробуйте ещё раз.";
  }
}
