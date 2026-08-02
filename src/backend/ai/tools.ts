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
  CASH_NOTIFY_THRESHOLD_RUB,
  createCashTx,
  createExpenseCategory,
  deleteCashTx,
  findAccounts,
  findCategories,
  findMembers,
  getCashOverview,
  getExpensesView,
  getPayrollView,
  getPnlView,
  mirrorSupplyPaymentToCash,
  type CashActor,
  type MemberRef,
} from "../data/cash-core";
import {
  createPayoutRequest,
  decidePayout,
  getPayouts,
  payPayout,
  PAYOUT_KIND_LABELS,
  PAYOUT_STATUS_LABELS,
} from "../data/payouts-core";
import { ensureDutyAssignments, getDutyStats, localIsoDate } from "../data/duties-core";
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
// kgs в CURRENCIES нет (счета кассы — rub/cny/uzs), но заявки бывают в сомах
const CURRENCY_LABEL: Record<string, string> = { cny: "¥", uzs: "сум", rub: "₽", kgs: "сом" };

// Схемы-заготовки, чтобы описания инструментов не расползались
const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "number", description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});

type ToolSpec = ToolDef & {
  permission?: Permission;
  // Достаточно ЛЮБОГО из прав — для инструментов, полезных нескольким ролям
  // с разными правами (например, design_action: сдаёт дизайнер, утверждает лид)
  permissionsAny?: Permission[];
  leadOnly?: boolean;
};

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
  {
    name: "duty_stats",
    permission: "duty:view",
    description:
      "СТАТИСТИКА ДИСЦИПЛИНЫ по регламенту за период: кто выполняет свои задачи хорошо, кто срывает, " +
      "процент выполнения и своевременности. Руководитель видит всю команду, сотрудник — только себя. " +
      "Используй на «как команда работает по регламенту», «кто хуже всех за неделю», «моя дисциплина за месяц».",
    input_schema: obj({
      days: int("Период: 7 (неделя, по умолчанию) или 30 (месяц)"),
      person: str("Имя сотрудника, если интересует один человек (только для руководителя)"),
    }),
  },
  {
    name: "complete_duty_for",
    leadOnly: true,
    description:
      "Закрыть задачу регламента ЗА СОТРУДНИКА (руководитель принял работу устно/лично). " +
      "Используй на «закрой за Азиза задачу по отзывам, он всё сделал». " +
      "Если по шаблону обязателен отчёт — спроси, что именно сделано, и передай текст.",
    input_schema: obj(
      {
        employee: str("Имя сотрудника, чью задачу закрываем"),
        duty: str("Часть названия задачи регламента"),
        report: str("Что сделано (обязательно, если задача требует отчёт)"),
      },
      ["employee", "duty"],
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
      "Статью пиши словами — система найдёт подходящую. Если счёт не назван и счетов несколько — " +
      "инструмент вернёт список: уточни у сотрудника, с какого платили. «Вчера» и другие относительные даты переведи в yyyy-mm-dd сам.",
    input_schema: obj(
      {
        amount: int("Сумма расхода (в валюте счёта; для рублёвого счёта — рубли)"),
        category: str("Статья расхода словами: «реклама», «зарплата», «налоги», «карго», «закуп товара»…"),
        account: str("Название счёта, если известно: «наличные», «карта», «юани» (необязательно)"),
        note: str("За что именно (необязательно, но полезно)"),
        date: str("Дата расхода yyyy-mm-dd (по умолчанию сегодня; «вчера» — вычисли и передай явно)"),
        confirm: {
          type: "boolean",
          description:
            "true ТОЛЬКО если сотрудник явно подтвердил крупную сумму (от 100 000 ₽) отдельным сообщением",
        },
      },
      ["amount", "category"],
    ),
  },
  {
    name: "add_income",
    permission: "finance:expense",
    description:
      "Записать ПОСТУПЛЕНИЕ денег на счёт (выплата от WB, возврат, пополнение владельцем). " +
      "Используй на «пришло 800 тысяч от WB», «положил в кассу 50 000». Если счёт не назван и счетов несколько — уточни.",
    input_schema: obj(
      {
        amount: int("Сумма поступления"),
        category: str("Статья прихода словами: «поступление от WB», «пополнение владельцем», «прочий доход»"),
        account: str("На какой счёт (необязательно)"),
        note: str("Комментарий (необязательно)"),
        date: str("Дата yyyy-mm-dd (по умолчанию сегодня)"),
        confirm: {
          type: "boolean",
          description:
            "true ТОЛЬКО если сотрудник явно подтвердил крупную сумму (от 100 000 ₽) отдельным сообщением",
        },
      },
      ["amount", "category"],
    ),
  },
  {
    name: "transfer_money",
    permission: "finance:expense",
    description:
      "Перевод денег МЕЖДУ СЧЕТАМИ кассы (наличные → карта, карта → юани…). Общая сумма денег не меняется. " +
      "Используй на «переведи 50 тысяч с карты на наличные», «снял с карты 100к». " +
      "Если счета в РАЗНЫХ валютах — обязательно спроси, сколько зачислено на второй счёт (это курс сделки).",
    input_schema: obj(
      {
        from_account: str("Счёт списания (название)"),
        to_account: str("Счёт зачисления (название)"),
        amount: int("Сумма списания (в валюте счёта-источника)"),
        amount_to: int(
          "Сколько зачислено на второй счёт — ОБЯЗАТЕЛЬНО при разных валютах счетов (необязательно при одинаковых)",
        ),
        date: str("Дата yyyy-mm-dd (по умолчанию сегодня)"),
        note: str("Комментарий (необязательно)"),
        confirm: {
          type: "boolean",
          description:
            "true ТОЛЬКО если сотрудник явно подтвердил крупную сумму (от 100 000 ₽) отдельным сообщением",
        },
      },
      ["from_account", "to_account", "amount"],
    ),
  },
  {
    name: "delete_cash_tx",
    permission: "finance:expense",
    description:
      "Удалить ОШИБОЧНУЮ операцию кассы (расход/приход/перевод, внесённые по ошибке или дублем). НЕОБРАТИМО. " +
      "Используй на «удали расход 3000 от вчера», «я ошибся, убери последнюю операцию». " +
      "Ищет по сумме, дате, статье/комментарию; удаляет ТОЛЬКО при однозначном совпадении, иначе покажет кандидатов.",
    input_schema: obj(
      {
        amount: int("Сумма операции (главный признак поиска)"),
        date: str("Дата операции yyyy-mm-dd, если известна (необязательно)"),
        query: str("Слова из статьи или комментария: «реклама», «такси»… (необязательно)"),
        account: str("Название счёта (необязательно)"),
      },
      ["amount"],
    ),
  },
  {
    name: "create_expense_category",
    permission: "finance:expense",
    description:
      "Создать новую СТАТЬЮ расходов или приходов кассы. Используй, когда подходящей статьи нет " +
      "и сотрудник подтвердил, что нужна новая (например «Сертификация», «Обучение»).",
    input_schema: obj(
      {
        name: str("Название статьи (коротко, по-русски)"),
        direction: {
          type: "string",
          enum: ["out", "in"],
          description: "out — статья расходов, in — статья приходов",
        },
        in_pnl: {
          type: "boolean",
          description:
            "false — движение активов (закуп товара, вывод владельцу), НЕ уменьшает прибыль в ОПиУ. По умолчанию true",
        },
        emoji: str("Эмодзи для статьи (необязательно)"),
        confirm_new: {
          type: "boolean",
          description: "true — создать, даже если есть похожая статья (после подтверждения сотрудника)",
        },
      },
      ["name", "direction"],
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
    name: "unit_economics",
    permission: "finance:view",
    description:
      "ЮНИТ-ЭКОНОМИКА по товарам за период: выручка, удержания WB, реклама, себестоимость, прибыль, маржа и ДРР по каждому SKU. " +
      "Используй на «какая юнит-экономика», «какой товар самый прибыльный», «что в минусе», «маржа по пижаме». " +
      "С параметром product — детальный разбор одного товара.",
    input_schema: obj({
      days: int("За сколько последних дней (по умолчанию 30, максимум 90)"),
      product: str("Часть названия товара или артикул WB — для разбора одного SKU (необязательно)"),
    }),
  },

  {
    name: "pay_salary",
    permission: "finance:expense",
    leadOnly: true,
    description:
      "НАЧИСЛИТЬ ВЫПЛАТУ СОТРУДНИКУ: зарплата, аванс, премия, гонорар, возмещение расходов. " +
      "Деньги сразу списываются со счёта кассы и попадают в отчёт «Выплаты команде» — видно, кому сколько выплатили. " +
      "Используй на «начисли Азизу зарплату 60 тысяч», «выплати Назире премию 10к», «отдал аванс Алие 20000». " +
      "Сотрудника ищем по имени. Сотруднику придёт уведомление в Telegram. " +
      "Если нужно СОГЛАСОВАНИЕ руководителя, а не сразу деньги — используй request_payout.",
    input_schema: obj(
      {
        employee: str("Имя сотрудника (например «Азиз» или «Назира»)"),
        amount: int("Сумма выплаты (в валюте счёта; для рублёвого счёта — рубли)"),
        kind: {
          type: "string",
          enum: ["salary", "bonus", "contractor", "reimbursement"],
          description:
            "ОБЯЗАТЕЛЬНО выбери по смыслу: salary — зарплата или аванс, bonus — премия (премия НИКОГДА не salary), " +
            "contractor — гонорар за услуги, reimbursement — возместить потраченное. Не уверен — спроси.",
        },
        account: str(
          "Название счёта, с которого платим. Если не назван и счетов несколько — инструмент вернёт список, уточни",
        ),
        date: str("Дата выплаты yyyy-mm-dd (по умолчанию сегодня)"),
        note: str("За что: «зарплата за июль», «аванс», «премия за план» (необязательно)"),
        confirm: {
          type: "boolean",
          description:
            "true ТОЛЬКО если сотрудник явно подтвердил крупную сумму (от 100 000 ₽) отдельным сообщением",
        },
      },
      ["employee", "amount", "kind"],
    ),
  },
  {
    name: "payroll_report",
    permission: "finance:cash",
    leadOnly: true,
    description:
      "КОМУ СКОЛЬКО ВЫПЛАТИЛИ: разрез выплат по сотрудникам за период — суммы, число выплат, из чего сложилось (оклад, премия, возмещение). " +
      "Используй на «сколько выплатили Азизу за месяц», «кому сколько заплатили», «сколько ушло на зарплаты», «фонд оплаты труда».",
    input_schema: obj({
      employee: str("Имя сотрудника, если нужен разрез по одному человеку (необязательно)"),
      days: int("За сколько последних дней (по умолчанию — с начала месяца)"),
    }),
  },
  {
    name: "my_salary",
    // Без permission: свои деньги видит каждый сотрудник; изоляция — внутри,
    // запрос жёстко фильтруется .eq("person_id", ctx.user.id)
    description:
      "Сколько сотрудник получил ОТ КОМПАНИИ: его собственные выплаты за период (зарплата, премии, возмещения) и заявки, которые ещё ждут оплаты. " +
      "Показывает ТОЛЬКО деньги самого спрашивающего. Используй на «сколько мне заплатили», «когда была последняя зарплата», «сколько я получил за месяц».",
    input_schema: obj({
      days: int("За сколько последних дней (по умолчанию 90)"),
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
          description:
            "ОБЯЗАТЕЛЬНО выбери по смыслу: salary — зарплата/аванс, contractor — подрядчик/услуги, " +
            "factory — счёт фабрики, reimbursement — возместить сотруднику, other — прочее. Не уверен — спроси.",
        },
        currency: {
          type: "string",
          enum: ["rub", "kgs", "cny", "uzs"],
          description:
            "Валюта суммы — ОБЯЗАТЕЛЬНО. НЕ подставляй rub сам: если речь про фабрику/Китай, " +
            "скорее всего юани (cny); если валюта не звучала — переспроси у сотрудника.",
        },
        payee: str("Кому платим, если это не сотрудник компании: имя подрядчика, фотографа, компании"),
        employee: str("Имя сотрудника-адресата, если платим кому-то из команды — тогда выплата попадёт в его карточку"),
        due_date: str("Оплатить до, yyyy-mm-dd (необязательно)"),
        supply: str("Часть названия поставки, если это счёт фабрики (необязательно)"),
      },
      ["amount", "title", "kind", "currency"],
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
      "Оплатить СОГЛАСОВАННУЮ заявку: деньги списываются со счёта кассы и попадают в расходы. " +
      "Несогласованную (pending) оплатить нельзя — сначала decide_payout. " +
      "Используй на «оплати заявку фотографу с карты», «выплати аванс наличными».",
    input_schema: obj(
      {
        payout: str("Часть названия заявки"),
        account: str(
          "Название счёта, с которого платим. Если не назван и счетов несколько — инструмент вернёт список, уточни",
        ),
        paid_on: str("Дата оплаты yyyy-mm-dd (по умолчанию сегодня)"),
        confirm: {
          type: "boolean",
          description:
            "true ТОЛЬКО если сотрудник явно подтвердил крупную сумму (от 100 000 ₽) отдельным сообщением",
        },
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
        sewing_cost: int(
          "Стоимость отшивки (долг фабрике) — ОБЯЗАТЕЛЬНА: без неё долги и себестоимость врут. Не назвали — спроси",
        ),
        sewing_currency: {
          type: "string",
          enum: CURRENCIES,
          description: "Валюта отшивки (не указана — возьмём по стране фабрики: Китай ¥, Узбекистан сум)",
        },
        cargo_cost: int("Стоимость карго (перевозка), если уже известна"),
        cargo_currency: {
          type: "string",
          enum: CURRENCIES,
          description: "Валюта карго (не указана — по стране фабрики)",
        },
        cost_unknown: {
          type: "boolean",
          description:
            "true ТОЛЬКО если сотрудник ЯВНО сказал, что стоимость отшивки пока неизвестна / внесёт позже",
        },
        product: str("Часть названия товара WB, если поставку надо связать с карточкой (необязательно)"),
      },
      ["factory", "title", "quantity", "sewing_cost"],
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
    // Виден только тем, кто реально может хоть что-то сделать с заявкой:
    // дизайнер/SEO сдают, руководители утверждают. Точные права на каждый
    // переход проверяются внутри (DESIGN_TRANSITIONS).
    permissionsAny: ["design:submit", "design:approve"],
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
    if (t.permissionsAny && !t.permissionsAny.some((p) => can(role, p))) return false;
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

// ── Деньги: строгий выбор счёта и подтверждение крупных сумм ────────────────

type AccountRef = { id: string; name: string; currency: Currency };

// Счёт для денежной операции. Не указан: один счёт → берём его (и называем в
// ответе), несколько → НЕ выполняем, возвращаем список — модель уточнит у
// человека. Молчаливого «дефолтного» счёта больше нет: деньги не списываются
// с угаданного счёта.
async function resolveAccountStrict(
  ctx: ToolCtx,
  accountQuery: unknown,
): Promise<{ ok: true; account: AccountRef; autoPicked: boolean } | { ok: false; message: string }> {
  const q = String(accountQuery ?? "").trim();
  if (q) {
    const found = await findAccounts(ctx.db, q);
    if (!found.length) {
      const all = await findAccounts(ctx.db, "");
      return {
        ok: false,
        message: `Счёт «${q}» не найден. Есть: ${all.map((a) => a.name).join(", ")}. Уточни у сотрудника.`,
      };
    }
    if (found.length > 1) {
      return {
        ok: false,
        message: `Подходит несколько счетов: ${found.map((a) => a.name).join(", ")}. Уточни, какой именно.`,
      };
    }
    return { ok: true, account: found[0], autoPicked: false };
  }

  const all = await findAccounts(ctx.db, "");
  if (!all.length) {
    return {
      ok: false,
      message: "Счетов кассы ещё нет. Заведите счёт: CRM → Финансы → Касса → «Новый счёт».",
    };
  }
  if (all.length > 1) {
    return {
      ok: false,
      message:
        `С какого счёта проводим? Есть: ${all
          .map((a) => `${a.name} (${CURRENCY_LABEL[a.currency] ?? a.currency})`)
          .join(", ")}. ` + "Спроси у сотрудника и повтори вызов с параметром account.",
    };
  }
  return { ok: true, account: all[0], autoPicked: true };
}

// Стоп-кран на крупные суммы: без явного подтверждения человека операция не
// проводится. Порог тот же, что у Telegram-пуша директору о крупных расходах.
function confirmGate(amountRub: number, confirm: unknown, summary: string): string | null {
  if (amountRub < CASH_NOTIFY_THRESHOLD_RUB || confirm === true) return null;
  return (
    `Крупная сумма — ${num(amountRub)} ₽. Ничего не записано. ` +
    `Покажи сотруднику сводку (${summary}) и дождись явного «да», ` +
    "затем повтори вызов с confirm=true."
  );
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

  // Поиск строго среди членов НАШЕЙ организации (findMembers идёт через
  // org_members) — прямой запрос к profiles без org-фильтра мог найти чужого
  const candidates = await findMembers(db, q);
  if (!candidates.length) {
    const all = await findMembers(db, "");
    return `Сотрудник «${q}» не найден. В команде: ${all.map((m) => m.name).join(", ")}. Уточни имя или логин.`;
  }
  if (candidates.length > 1) {
    return `Нашлось несколько: ${candidates.map((c) => `${c.name} (${c.roleLabel})`).join(", ")}. Уточни, кому именно.`;
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
  return `Задача создана и назначена: ${assignee.name}. Уведомление в Telegram отправлено (если привязан).`;
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

// ── Дисциплина за период и закрытие регламента за сотрудника (руководителю) ──

const GRADE_RU: Record<string, string> = {
  good: "🟢 отлично",
  ok: "🟡 средне",
  bad: "🔴 плохо",
};

async function execDutyStats(
  ctx: ToolCtx,
  input: { days?: number; person?: string },
): Promise<string> {
  // Сначала пометить просроченные pending → missed, иначе цифры сразу после
  // дедлайна будут завышены (веб делает это в readDuties, у бота крон реже)
  await ensureDutyAssignments(ctx.db);
  const stats = await getDutyStats(ctx.db);
  const days = (posInt(input.days) ?? 7) <= 7 ? 7 : 30;
  const period = days === 7 ? stats.d7 : stats.d30;

  let list = period.employees;
  if (!isLead(ctx.user.role)) {
    // Специалист видит только свою дисциплину — как на сайте
    list = list.filter((e) => e.assigneeId === ctx.user.id);
    if (!list.length) return `За последние ${days} дн. назначений по регламенту у вас не было.`;
  } else if (String(input.person ?? "").trim()) {
    const found = await resolveEmployee(ctx, String(input.person));
    if ("ask" in found) return found.ask;
    list = list.filter((e) => e.assigneeId === found.member.id);
    if (!list.length) {
      return `${found.member.name}: назначений по регламенту за последние ${days} дн. не было.`;
    }
  }
  if (!list.length) return `За последние ${days} дн. данных по регламенту нет.`;

  const lines = [
    `ДИСЦИПЛИНА РЕГЛАМЕНТА за ${days} дн. (с ${period.from}): ` +
      `команда — выполнение ${period.teamCompletionPct}%, вовремя ${period.teamOnTimePct}%.`,
  ];
  for (const e of list) {
    lines.push(
      `- ${e.assigneeName}: ${GRADE_RU[e.grade]} · балл ${e.score}/100 · ` +
        `${e.done} из ${e.total} выполнено (${e.completionPct}%), вовремя ${e.onTimePct}%` +
        (e.missed ? ` · просрочено ${e.missed}` : ""),
    );
    if (e.problems.length) {
      lines.push(
        `  чаще срывается: ${e.problems
          .map((p) => `«${p.title}» (просрочено ${p.missed}, с опозданием ${p.late})`)
          .join("; ")}`,
      );
    }
  }
  return lines.join("\n");
}

async function execCompleteDutyFor(
  ctx: ToolCtx,
  input: { employee?: string; duty?: string; report?: string },
): Promise<string> {
  const q = String(input.duty ?? "").trim();
  if (!q) return "Ошибка: укажи, какую задачу регламента закрыть.";

  const found = await resolveEmployee(ctx, String(input.employee ?? ""));
  if ("ask" in found) return found.ask;
  const member = found.member;

  const rows = await myDutiesToday(ctx.db, member.id);
  const norm = (s: string) => s.toLowerCase();
  const matches = rows.filter((r) => norm(one(r.template)?.title ?? "").includes(norm(q)));
  if (!matches.length) {
    const titles = rows.map((r) => one(r.template)?.title).filter(Boolean);
    return `У ${member.name} на сегодня нет задачи «${q}». Его задачи: ${titles.join("; ") || "нет"}.`;
  }
  if (matches.length > 1) {
    return `Подходит несколько задач ${member.name}: ${matches
      .map((r) => `«${one(r.template)?.title}»`)
      .join(", ")}. Уточни, какая.`;
  }
  const match = matches[0];
  if (match.status === "done") return `Эта задача у ${member.name} уже закрыта.`;

  // Требование отчёта — по шаблону задачи
  const { data: tpl } = await ctx.db
    .from("duty_assignments")
    .select("template:duty_templates(requires_report)")
    .eq("id", match.id)
    .maybeSingle();
  const requiresReport = Boolean(
    one((tpl?.template ?? null) as { requires_report: boolean } | { requires_report: boolean }[] | null)
      ?.requires_report,
  );
  const report = String(input.report ?? "").trim();
  if (requiresReport && !report) {
    return `По задаче «${one(match.template)?.title}» обязателен отчёт. Спроси у руководителя, что именно сделано, и повтори вызов с текстом.`;
  }

  const onTime = Date.now() <= new Date(match.due_at).getTime();
  if (report) {
    await ctx.db.from("duty_reports").upsert(
      {
        org_id: match.org_id,
        assignment_id: match.id,
        user_id: member.id,
        content: `Закрыто руководителем ${ctx.user.name}: ${report}`,
        on_time: onTime,
      },
      { onConflict: "assignment_id" },
    );
  }
  await ctx.db
    .from("duty_assignments")
    .update({ status: "done", completed_at: new Date().toISOString() })
    .eq("id", match.id);
  ctx.touch();
  return (
    `Задача «${one(match.template)?.title}» закрыта за ${member.name} ` +
    `${onTime ? "вовремя" : "после дедлайна"}.` +
    (report ? " В отчёте помечено, что закрыл руководитель." : " Отчёт не требовался — закрыто без него.")
  );
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
    patch.cost_price_source = "manual";
    patch.cost_price_updated_at = new Date().toISOString();
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
  if (patch.cost_price !== undefined) {
    await ctx.db.from("product_cost_history").insert({
      product_id: picked.row.id,
      cost_price: patch.cost_price,
      source: "manual",
      created_by: authorId(ctx.user),
    });
  }
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

  const costPrice = posInt(input.cost_price) ?? 0;
  const { data: created, error } = await ctx.db
    .from("products")
    .insert({
      store_id: DEMO_STORE_ID,
      nm_id: nmId,
      title: title.slice(0, 200),
      vendor_code: String(input.vendor_code ?? "").trim() || null,
      brand: String(input.brand ?? "").trim() || null,
      category: String(input.category ?? "").trim() || null,
      status: "Новинка",
      cost_price: costPrice,
      responsible_user_id: authorId(ctx.user),
    })
    .select("id")
    .single();
  if (error) {
    // unique (store_id, nm_id)
    if (error.code === "23505") return `Товар с артикулом ${nmId} уже есть в каталоге.`;
    return `Не удалось создать товар: ${error.message}`;
  }
  if (costPrice > 0 && created?.id) {
    await ctx.db.from("product_cost_history").insert({
      product_id: created.id,
      cost_price: costPrice,
      source: "manual",
      created_by: authorId(ctx.user),
    });
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
  | {
      ok: true;
      amount: number;
      categoryId: string;
      categoryName: string;
      accountId: string;
      accountName: string;
      accountCurrency: Currency;
      autoPicked: boolean;
      date: string;
    }
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
        "Уточни у сотрудника, какая подходит — или предложи создать новую (инструмент create_expense_category).",
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `Подходит несколько статей: ${matches.map((c) => c.name).join(", ")}. Уточни, какая нужна.`,
    };
  }
  const category = matches[0];

  const acc = await resolveAccountStrict(ctx, input.account);
  if (!acc.ok) return { ok: false, message: acc.message };

  return {
    ok: true,
    amount,
    categoryId: category.id,
    categoryName: category.name,
    accountId: acc.account.id,
    accountName: acc.account.name,
    accountCurrency: acc.account.currency,
    autoPicked: acc.autoPicked,
    date: isoOr(input.date, localIsoDate()) ?? localIsoDate(),
  };
}

async function execAddExpense(
  ctx: ToolCtx,
  input: {
    amount?: number;
    category?: string;
    account?: string;
    note?: string;
    date?: string;
    confirm?: boolean;
  },
): Promise<string> {
  const parsed = await resolveTxInput(ctx, input, "out");
  if (!parsed.ok) return parsed.message;

  const gate = confirmGate(
    toRub(parsed.amount, parsed.accountCurrency),
    input.confirm,
    `расход ${num(parsed.amount)} ${CURRENCY_LABEL[parsed.accountCurrency] ?? "₽"} · статья «${parsed.categoryName}» · счёт «${parsed.accountName}» · ${parsed.date}`,
  );
  if (gate) return gate;

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
    (parsed.autoPicked ? "Счёт в кассе один — взят он." : "")
  );
}

async function execAddIncome(
  ctx: ToolCtx,
  input: {
    amount?: number;
    category?: string;
    account?: string;
    note?: string;
    date?: string;
    confirm?: boolean;
  },
): Promise<string> {
  const parsed = await resolveTxInput(ctx, input, "in");
  if (!parsed.ok) return parsed.message;

  const gate = confirmGate(
    toRub(parsed.amount, parsed.accountCurrency),
    input.confirm,
    `приход ${num(parsed.amount)} ${CURRENCY_LABEL[parsed.accountCurrency] ?? "₽"} · статья «${parsed.categoryName}» · счёт «${parsed.accountName}» · ${parsed.date}`,
  );
  if (gate) return gate;

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
    `счёт «${parsed.accountName}» · дата ${parsed.date}.` +
    (parsed.autoPicked ? " Счёт в кассе один — взят он." : "")
  );
}

// ── Перевод между счетами и удаление ошибочной операции ─────────────────────

async function execTransferMoney(
  ctx: ToolCtx,
  input: {
    from_account?: string;
    to_account?: string;
    amount?: number;
    amount_to?: number;
    date?: string;
    note?: string;
    confirm?: boolean;
  },
): Promise<string> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return "Ошибка: нужна сумма перевода больше нуля.";
  }
  const fromQ = String(input.from_account ?? "").trim();
  const toQ = String(input.to_account ?? "").trim();
  if (!fromQ || !toQ) return "Ошибка: нужны оба счёта — откуда и куда переводим.";

  const from = await resolveAccountStrict(ctx, fromQ);
  if (!from.ok) return from.message;
  const to = await resolveAccountStrict(ctx, toQ);
  if (!to.ok) return to.message;
  if (from.account.id === to.account.id) {
    return "Счёт списания и счёт зачисления совпали — уточни, между какими счетами перевод.";
  }

  const cross = from.account.currency !== to.account.currency;
  const amountTo = Number(input.amount_to);
  // amount_to уважаем и при одной валюте: «перевёл 100к, дошло 98 500» (комиссия)
  const hasTo = Number.isFinite(amountTo) && amountTo > 0;
  if (cross && !hasTo) {
    return (
      `Счета в разных валютах («${from.account.name}» ${CURRENCY_LABEL[from.account.currency]} → ` +
      `«${to.account.name}» ${CURRENCY_LABEL[to.account.currency]}). ` +
      "Спроси, сколько зачислено на второй счёт (курс сделки), и повтори с amount_to."
    );
  }

  const gate = confirmGate(
    toRub(amount, from.account.currency),
    input.confirm,
    `перевод ${num(amount)} ${CURRENCY_LABEL[from.account.currency]} со счёта «${from.account.name}» на «${to.account.name}»`,
  );
  if (gate) return gate;

  const result = await createCashTx(ctx.db, cashActorOf(ctx.user), {
    kind: "transfer",
    accountId: from.account.id,
    toAccountId: to.account.id,
    amount,
    amountTo: hasTo ? amountTo : null,
    occurredOn: isoOr(input.date, localIsoDate()),
    note: input.note ? String(input.note) : null,
    source: "ai",
  });
  if (!result.ok) return `Не удалось провести перевод: ${result.message}`;
  ctx.touch();
  return (
    `Перевод проведён: ${num(amount)} ${CURRENCY_LABEL[from.account.currency]} · ` +
    `«${from.account.name}» → «${to.account.name}»` +
    (hasTo && (cross || amountTo !== amount)
      ? ` (зачислено ${num(amountTo)} ${CURRENCY_LABEL[to.account.currency]})`
      : "") +
    "."
  );
}

async function execDeleteCashTx(
  ctx: ToolCtx,
  input: { amount?: number; date?: string; query?: string; account?: string },
): Promise<string> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return "Ошибка: назови сумму операции, которую нужно удалить.";
  }
  const date = isoOr(input.date, null);
  const q = String(input.query ?? "").trim().toLowerCase();
  const accQ = String(input.account ?? "").trim().toLowerCase();

  // Ищем за последние 60 дней ТОЛЬКО ручные операции (manual/bot/ai):
  // системные нельзя — удаление оплаты заявки рассинхронизирует payout_requests,
  // а поступление WB воскреснет при следующем синке. Сумму матчим и в валюте
  // операции, и в рублях (сотрудник обычно называет рубли), допуск ±1.
  const since = localIsoDate(new Date(Date.now() - 60 * 86_400_000));
  const LIMIT = 100;
  let sel = ctx.db
    .from("cash_tx")
    .select(
      "id, kind, amount, currency, amount_rub, occurred_on, note, account:cash_accounts!cash_tx_account_id_fkey(name), category:expense_categories(name)",
    )
    .eq("org_id", DEMO_ORG_ID)
    .in("source", ["manual", "bot", "ai"])
    .gte("occurred_on", since)
    .or(
      `and(amount.gte.${amount - 1},amount.lte.${amount + 1}),` +
        `and(amount_rub.gte.${amount - 1},amount_rub.lte.${amount + 1})`,
    )
    .order("occurred_on", { ascending: false })
    .limit(LIMIT);
  if (date) sel = sel.eq("occurred_on", date);
  const { data, error } = await sel;
  if (error) return `Не удалось найти операцию: ${error.message}`;
  if ((data ?? []).length >= LIMIT) {
    return "Слишком много операций с такой суммой — уточни дату (yyyy-mm-dd), и я поищу точнее.";
  }

  type Row = {
    id: string;
    kind: string;
    amount: number;
    currency: string;
    amount_rub: number;
    occurred_on: string;
    note: string | null;
    account: { name: string } | { name: string }[] | null;
    category: { name: string } | { name: string }[] | null;
  };
  let rows = ((data ?? []) as unknown as Row[]).map((r) => ({
    ...r,
    accountName: one(r.account)?.name ?? "—",
    categoryName: one(r.category)?.name ?? "",
  }));
  if (q) {
    rows = rows.filter(
      (r) =>
        r.categoryName.toLowerCase().includes(q) || (r.note ?? "").toLowerCase().includes(q),
    );
  }
  if (accQ) rows = rows.filter((r) => r.accountName.toLowerCase().includes(accQ));

  const label = (r: (typeof rows)[number]) =>
    `${r.occurred_on}: ${r.kind === "in" ? "приход" : r.kind === "transfer" ? "перевод" : "расход"} ` +
    `${num(r.amount)} ${CURRENCY_LABEL[r.currency] ?? r.currency} · ${r.categoryName || "без статьи"} · ` +
    `счёт «${r.accountName}»${r.note ? ` · ${r.note}` : ""}`;

  if (!rows.length) {
    return (
      `Операция на ${num(amount)} за последние 60 дней не найдена среди ручных записей. ` +
      "Уточни сумму, дату или статью. Системные операции (оплата заявки, поступление WB, оплата поставки) " +
      "я не удаляю — их отменяют в своих карточках."
    );
  }
  if (rows.length > 1) {
    // Удаление необратимо — при любой неоднозначности только спрашиваем
    return (
      `Нашлось несколько операций, ничего не удалено:\n` +
      rows.slice(0, 6).map((r) => `- ${label(r)}`).join("\n") +
      "\nУточни дату или комментарий, чтобы я удалил ровно одну."
    );
  }

  const target = rows[0];
  const res = await deleteCashTx(ctx.db, cashActorOf(ctx.user), target.id);
  if (!res.ok) return `Не удалось удалить: ${res.message}`;
  ctx.touch();
  return `Удалена операция: ${label(target)}. Действие необратимо — назови её сотруднику полностью.`;
}

async function execCreateExpenseCategory(
  ctx: ToolCtx,
  input: {
    name?: string;
    direction?: string;
    in_pnl?: boolean;
    emoji?: string;
    confirm_new?: boolean;
  },
): Promise<string> {
  const name = String(input.name ?? "").trim();
  const direction = String(input.direction ?? "").trim() as "in" | "out";
  if (!name) return "Ошибка: нужно название статьи.";
  if (!["in", "out"].includes(direction)) {
    return "Ошибка: direction должен быть out (расход) или in (приход).";
  }

  // Защита от дублей: похожая статья уже есть → сначала подтверждение
  const similar = await findCategories(ctx.db, name, direction);
  if (similar.length && input.confirm_new !== true) {
    return (
      `Похожая статья уже есть: ${similar.map((c) => `«${c.name}»`).join(", ")}. ` +
      "Спроси сотрудника: использовать её или точно создать новую? Для новой повтори с confirm_new=true."
    );
  }

  const res = await createExpenseCategory(ctx.db, cashActorOf(ctx.user), {
    name,
    direction,
    inPnl: input.in_pnl !== false,
    emoji: input.emoji ? String(input.emoji) : null,
  });
  if (!res.ok) return `Не удалось создать статью: ${res.message}`;
  ctx.touch();
  return `${res.message} Направление: ${direction === "out" ? "расход" : "приход"}${input.in_pnl === false ? ", в прибыль не входит (движение активов)" : ""}.`;
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

// ── Юнит-экономика (agg_unit_econ) ──────────────────────────────────────────
// Компактная копия расчёта из data/supabase.ts getUnitEconomics: тот модуль
// использует alias-импорты и не годится для tsx-бота, а сюда нужен только
// текстовый срез. Хранение/приёмку берём из детальных отчётов, если они уже
// синхронизированы (сумма > 0), иначе из финотчёта — как на странице.

type UnitEconAggRow = {
  nm_id: number;
  sale_qty: number;
  return_qty: number;
  revenue_rub: number;
  commission_rub: number;
  acquiring_rub: number;
  logistics_rub: number;
  storage_fin_rub: number;
  storage_rub: number;
  acceptance_fin_rub: number;
  acceptance_rub: number;
  penalty_rub: number;
  deduction_rub: number;
  advert_rub: number;
};

async function execUnitEconomics(
  ctx: ToolCtx,
  input: { days?: number; product?: string },
): Promise<string> {
  const days = Math.min(90, Math.max(7, posInt(input.days) ?? 30));
  const to = new Date();
  to.setHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));

  const [aggRes, prodRes] = await Promise.all([
    ctx.db.rpc("agg_unit_econ", {
      p_store: DEMO_STORE_ID,
      p_from: localIsoDate(from),
      p_to: localIsoDate(to),
    }),
    ctx.db
      .from("products")
      .select("nm_id, title, cost_price")
      .eq("store_id", DEMO_STORE_ID),
  ]);
  if (aggRes.error) return `Не удалось получить юнит-экономику: ${aggRes.error.message}`;
  const agg = (aggRes.data ?? []) as UnitEconAggRow[];
  if (!agg.length) {
    return `Юнит-экономика за ${days} дн.: данных нет (нет продаж или отчёты WB ещё не синхронизированы).`;
  }
  const prodByNm = new Map(
    ((prodRes.data ?? []) as { nm_id: number; title: string; cost_price: number | null }[]).map(
      (p) => [Number(p.nm_id), p],
    ),
  );

  // Источник хранения/приёмки выбираем глобально — как на странице «Экономика»
  const useDailyStorage = agg.reduce((t, r) => t + Number(r.storage_rub ?? 0), 0) > 0;
  const useDetailAcceptance = agg.reduce((t, r) => t + Number(r.acceptance_rub ?? 0), 0) > 0;

  const items = agg.map((r) => {
    const nm = Number(r.nm_id);
    const p = prodByNm.get(nm);
    const qty = Math.max(0, Number(r.sale_qty ?? 0) - Number(r.return_qty ?? 0));
    const revenue = Number(r.revenue_rub ?? 0);
    const storage = Number(useDailyStorage ? r.storage_rub : r.storage_fin_rub) || 0;
    const acceptance = Number(useDetailAcceptance ? r.acceptance_rub : r.acceptance_fin_rub) || 0;
    const wbFees =
      Number(r.commission_rub ?? 0) +
      Number(r.acquiring_rub ?? 0) +
      Number(r.logistics_rub ?? 0) +
      storage +
      acceptance +
      Number(r.penalty_rub ?? 0) +
      Number(r.deduction_rub ?? 0);
    const advert = Number(r.advert_rub ?? 0);
    const costPrice = Number(p?.cost_price ?? 0);
    const cogs = costPrice * qty;
    const profit = revenue - wbFees - advert - cogs;
    return {
      nm,
      title: nm === 0 ? "Нераспределённое (медийная реклама, хранение без товара)" : (p?.title ?? `nm ${nm}`),
      qty,
      revenue,
      wbFees,
      advert,
      cogs,
      costPrice,
      profit,
      marginPct: revenue > 0 ? Math.round((profit / revenue) * 100) : 0,
      drrPct: revenue > 0 ? Math.round((advert / revenue) * 1000) / 10 : 0,
    };
  });

  const fmtRow = (i: (typeof items)[number]) =>
    `«${i.title}»: продано ${num(i.qty)} шт, выручка ${num(i.revenue)} ₽, ` +
    `удержания WB ${num(i.wbFees)} ₽, реклама ${num(i.advert)} ₽ (ДРР ${i.drrPct}%), ` +
    `себестоимость ${num(i.cogs)} ₽${i.costPrice === 0 && i.nm !== 0 ? " (⚠ себестоимость не заполнена!)" : ""}, ` +
    `прибыль ${num(i.profit)} ₽ (маржа ${i.marginPct}%)`;

  // Разбор одного товара
  const q = String(input.product ?? "").trim();
  if (q) {
    const norm = q.toLowerCase();
    const matches = items.filter(
      (i) => i.nm !== 0 && (i.title.toLowerCase().includes(norm) || String(i.nm) === q.replace(/\D/g, "")),
    );
    const picked = pickOne(matches, (i) => i.title, q, "Товара с продажами за период");
    if ("ask" in picked) return picked.ask;
    return `ЮНИТ-ЭКОНОМИКА за ${days} дн.:\n${fmtRow(picked.row)}`;
  }

  const products = items.filter((i) => i.nm !== 0).sort((a, b) => b.profit - a.profit);
  const unallocated = items.find((i) => i.nm === 0);
  const totals = items.reduce(
    (s, i) => ({ revenue: s.revenue + i.revenue, profit: s.profit + i.profit }),
    { revenue: 0, profit: 0 },
  );
  const losers = products.filter((i) => i.profit < 0).slice(-3).reverse();
  const noCost = products.filter((i) => i.costPrice === 0).length;

  return [
    `ЮНИТ-ЭКОНОМИКА за ${days} дн.: выручка ${num(totals.revenue)} ₽, прибыль ${num(totals.profit)} ₽ по ${products.length} SKU.` +
      (noCost > 0 ? ` ⚠ У ${noCost} SKU не заполнена себестоимость — их прибыль завышена.` : ""),
    "Топ по прибыли:",
    ...products.slice(0, 5).map((i) => `- ${fmtRow(i)}`),
    ...(losers.length ? ["Убыточные:", ...losers.map((i) => `- ${fmtRow(i)}`)] : []),
    ...(unallocated && (unallocated.wbFees !== 0 || unallocated.advert !== 0)
      ? [`Нераспределённое (не привязано к товарам): удержания ${num(unallocated.wbFees)} ₽, реклама ${num(unallocated.advert)} ₽.`]
      : []),
  ].join("\n");
}

// ── Заявки на выплату (правила — в data/payouts-core) ───────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Выплаты людям
// ─────────────────────────────────────────────────────────────────────────────

// Какую статью расхода берём под тип выплаты. Названия те же, что в кассе, —
// сотрудник видит в CRM ровно то, что продиктовал боту.
const SALARY_CATEGORY: Record<string, string> = {
  salary: "Зарплата",
  bonus: "Премии и бонусы",
  contractor: "Подрядчики и услуги",
  reimbursement: "Возмещение сотруднику",
};

// Сотрудник по имени: «Азиз» → профиль. Переспрашиваем, если совпало несколько.
async function resolveEmployee(
  ctx: ToolCtx,
  query: string,
): Promise<{ ask: string } | { member: MemberRef }> {
  const q = String(query ?? "").trim();
  if (!q) return { ask: "Уточни, кому именно выплата — назови имя сотрудника." };
  const matches = await findMembers(ctx.db, q);
  if (!matches.length) {
    const all = await findMembers(ctx.db, "");
    return {
      ask:
        `Сотрудник «${q}» не найден. В команде: ${all.map((m) => m.name).join(", ")}. ` +
        "Уточни имя.",
    };
  }
  if (matches.length > 1) {
    return {
      ask: `Подходит несколько человек: ${matches.map((m) => `${m.name} (${m.roleLabel})`).join(", ")}. Уточни, кто именно.`,
    };
  }
  return { member: matches[0] };
}

async function execPaySalary(
  ctx: ToolCtx,
  input: {
    employee?: string;
    amount?: number;
    kind?: string;
    account?: string;
    date?: string;
    note?: string;
    confirm?: boolean;
  },
): Promise<string> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return "Ошибка: нужна сумма больше нуля. Спроси, сколько начислить.";
  }

  // Тип выплаты — строго: премия, попавшая в статью «Зарплата», перекашивает ФОТ
  const kindRaw = String(input.kind ?? "").trim();
  if (!Object.hasOwn(SALARY_CATEGORY, kindRaw)) {
    return (
      "Уточни тип выплаты: зарплата или аванс (salary), премия (bonus), " +
      "гонорар за услуги (contractor) или возмещение расходов (reimbursement)."
    );
  }

  const found = await resolveEmployee(ctx, String(input.employee ?? ""));
  if ("ask" in found) return found.ask;
  const member = found.member;

  const wantedCategory = SALARY_CATEGORY[kindRaw];
  const categories = await findCategories(ctx.db, wantedCategory, "out");
  if (!categories.length) {
    const all = await findCategories(ctx.db, "", "out");
    return (
      `Статья «${wantedCategory}» не заведена. Есть: ${all.map((c) => c.name).join(", ")}. ` +
      "Заведите её в CRM → Финансы → Расходы или скажи, какую использовать."
    );
  }
  const category = categories[0];

  const acc = await resolveAccountStrict(ctx, input.account);
  if (!acc.ok) return acc.message;
  const account = acc.account;

  const date = isoOr(input.date, localIsoDate()) ?? localIsoDate();

  const gate = confirmGate(
    toRub(amount, account.currency),
    input.confirm,
    `${member.name} · ${num(amount)} ${CURRENCY_LABEL[account.currency] ?? "₽"} · статья «${category.name}» · счёт «${account.name}» · ${date}`,
  );
  if (gate) return gate;

  const result = await createCashTx(ctx.db, cashActorOf(ctx.user), {
    kind: "out",
    accountId: account.id,
    categoryId: category.id,
    amount,
    occurredOn: date,
    note: input.note ? String(input.note) : `${category.name} · ${member.name}`,
    personId: member.id,
    source: "ai",
  });
  if (!result.ok) return `Не удалось начислить выплату: ${result.message}`;
  ctx.touch();

  return (
    `Выплата проведена: ${num(result.amountRub)} ₽ · ${member.name} (${member.roleLabel}) · ` +
    `статья «${category.name}» · счёт «${account.name}» · дата ${date}. ` +
    "Сумма попала в отчёт «Выплаты команде»; сотруднику ушло уведомление в Telegram, если его аккаунт привязан." +
    (acc.autoPicked ? " Счёт в кассе один — взят он." : "")
  );
}

async function execPayrollReport(
  ctx: ToolCtx,
  input: { employee?: string; days?: number },
): Promise<string> {
  const days = posInt(input.days);
  const from = days
    ? localIsoDate(new Date(Date.now() - (days - 1) * 86_400_000))
    : localIsoDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const to = localIsoDate();

  const view = await getPayrollView(ctx.db, from, to);

  // Разрез по одному человеку
  if (input.employee) {
    const found = await resolveEmployee(ctx, String(input.employee));
    if ("ask" in found) return found.ask;
    const person = view.people.find((p) => p.personId === found.member.id);
    if (!person) {
      return `${found.member.name}: выплат за период ${from}…${to} нет.`;
    }
    const lines = [
      `ВЫПЛАТЫ · ${person.name} (${person.roleLabel}) за ${from}…${to}: ` +
        `${num(person.amountRub)} ₽ за ${person.txCount} выплат` +
        (person.lastPaidOn ? `, последняя ${person.lastPaidOn}` : "") +
        `. Это ${person.sharePct}% всех выплат команде.`,
    ];
    if (person.slices.length) {
      lines.push(
        "Из чего сложилось: " +
          person.slices.map((s) => `${s.name} — ${num(s.amountRub)} ₽`).join("; "),
      );
    }
    if (person.monthly.length > 1) {
      lines.push(
        "По месяцам: " + person.monthly.map((m) => `${m.label} — ${num(m.amountRub)} ₽`).join("; "),
      );
    }
    const own = view.items.filter((t) => t.personId === person.personId).slice(0, 8);
    if (own.length) {
      lines.push("Операции:");
      for (const t of own) {
        lines.push(
          `- ${t.occurredOn}: ${num(t.amountRub)} ₽ · ${t.categoryName ?? "без статьи"}` +
            (t.note ? ` · ${t.note}` : ""),
        );
      }
    }
    return lines.join("\n");
  }

  if (!view.people.length) {
    return (
      `ВЫПЛАТЫ КОМАНДЕ за ${from}…${to}: адресных выплат нет.` +
      (view.unassignedRub > 0
        ? ` При этом по «людским» статьям ушло ${num(view.unassignedRub)} ₽ без указания сотрудника — стоит указывать, кому платили.`
        : "")
    );
  }

  const lines = [
    `ВЫПЛАТЫ КОМАНДЕ за ${from}…${to}: всего ${num(view.totalRub)} ₽ на ${view.people.length} человек ` +
      `(${view.items.length} выплат).`,
  ];
  for (const p of view.people) {
    lines.push(
      `- ${p.name} (${p.roleLabel}): ${num(p.amountRub)} ₽ · ${p.sharePct}% · ${p.txCount} выплат` +
        (p.lastPaidOn ? ` · последняя ${p.lastPaidOn}` : "") +
        (p.slices.length
          ? ` · ${p.slices.map((s) => `${s.name} ${num(s.amountRub)}`).join(", ")}`
          : ""),
    );
  }
  if (view.unassignedRub > 0) {
    lines.push(
      `Без указания сотрудника: ${num(view.unassignedRub)} ₽ (${view.unassignedCount} операций) — ` +
        "в разрезе по людям их не видно.",
    );
  }
  if (view.pendingRub > 0) {
    lines.push(`Ждут выплаты по заявкам: ${num(view.pendingRub)} ₽.`);
  }
  return lines.join("\n");
}

// Свои деньги видит любой сотрудник — но только свои
async function execMySalary(ctx: ToolCtx, input: { days?: number }): Promise<string> {
  const days = posInt(input.days) ?? 90;
  const from = localIsoDate(new Date(Date.now() - (days - 1) * 86_400_000));
  const to = localIsoDate();

  const [txRes, payouts] = await Promise.all([
    ctx.db
      .from("cash_tx")
      .select("occurred_on, amount_rub, note, category:expense_categories(name)")
      .eq("org_id", DEMO_ORG_ID)
      .eq("kind", "out")
      .eq("person_id", ctx.user.id)
      .gte("occurred_on", from)
      .lte("occurred_on", to)
      .order("occurred_on", { ascending: false })
      .limit(50),
    getPayouts(ctx.db, { id: ctx.user.id, role: ctx.user.role }),
  ]);
  if (txRes.error) return `Не удалось прочитать выплаты: ${txRes.error.message}`;

  const rows = (txRes.data ?? []) as unknown as {
    occurred_on: string;
    amount_rub: number;
    note: string | null;
    category: { name: string } | { name: string }[] | null;
  }[];
  const total = rows.reduce((t, r) => t + Number(r.amount_rub ?? 0), 0);

  const waiting = payouts.items.filter(
    (p) => p.requesterId === ctx.user.id && (p.status === "pending" || p.status === "approved"),
  );

  const lines = [
    `МОИ ВЫПЛАТЫ за ${from}…${to}: ${num(total)} ₽ за ${rows.length} ` +
      (rows.length === 1 ? "выплату" : "выплат") + ".",
  ];
  for (const r of rows.slice(0, 10)) {
    lines.push(
      `- ${r.occurred_on}: ${num(Number(r.amount_rub ?? 0))} ₽ · ${one(r.category)?.name ?? "без статьи"}` +
        (r.note ? ` · ${r.note}` : ""),
    );
  }
  if (waiting.length) {
    lines.push("Заявки в работе:");
    for (const p of waiting) {
      lines.push(
        `- «${p.title}» ${num(p.amountRub)} ₽ · ${PAYOUT_STATUS_LABELS[p.status]}`,
      );
    }
  }
  if (!rows.length && !waiting.length) {
    lines.push("Пока ничего не начислено — если ждёшь выплату, попроси её через заявку.");
  }
  return lines.join("\n");
}

async function execRequestPayout(
  ctx: ToolCtx,
  input: {
    amount?: number;
    title?: string;
    kind?: string;
    currency?: string;
    payee?: string;
    employee?: string;
    due_date?: string;
    supply?: string;
  },
): Promise<string> {
  // Тип и валюта — строго, без тихих дефолтов: юаневый счёт фабрики, молча
  // записанный в рублях, разъедется с реальностью в ~12 раз.
  const kindRaw = String(input.kind ?? "").trim();
  if (!["salary", "contractor", "factory", "reimbursement", "other"].includes(kindRaw)) {
    return (
      "Уточни тип выплаты: зарплата/аванс (salary), подрядчик или услуги (contractor), " +
      "счёт фабрики (factory), возмещение сотруднику (reimbursement) или прочее (other)."
    );
  }
  const kind = kindRaw as PayoutKind;

  const currencyRaw = String(input.currency ?? "").trim().toLowerCase();
  if (!["rub", "kgs", "cny", "uzs"].includes(currencyRaw)) {
    return (
      "Уточни валюту заявки: рубли (rub), сомы (kgs), юани (cny) или сумы (uzs). " +
      "Не подставляй рубли сам, если валюта не звучала."
    );
  }

  // Счёт фабрики стараемся привязать к поставке — тогда оплата закроет долг
  let supplyId: string | null = null;
  if (input.supply) {
    const matches = await findSupplies(ctx.db, String(input.supply));
    const picked = pickOne(matches, (m) => m.title, String(input.supply), "Поставки");
    if ("ask" in picked) return picked.ask;
    supplyId = picked.row.id;
  }

  // Адресат из команды — тогда после оплаты выплата попадёт в его карточку
  let payeeUserId: string | null = null;
  if (input.employee) {
    const found = await resolveEmployee(ctx, String(input.employee));
    if ("ask" in found) return found.ask;
    payeeUserId = found.member.id;
  }

  const result = await createPayoutRequest(ctx.db, cashActorOf(ctx.user), {
    kind,
    title: String(input.title ?? "").trim(),
    amount: Number(input.amount),
    currency: currencyRaw as Currency,
    payee: input.payee ? String(input.payee) : null,
    payeeUserId,
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
): Promise<
  | { ask: string; notFound?: boolean }
  | { row: { id: string; title: string; amount: number; currency: string; amountRub: number } }
> {
  const view = await getPayouts(ctx.db, { id: ctx.user.id, role: ctx.user.role });
  const pool = view.items.filter((p) => statuses.includes(p.status));
  const norm = query.trim().toLowerCase();
  const matches = norm ? pool.filter((p) => p.title.toLowerCase().includes(norm)) : pool;
  if (!matches.length) {
    return {
      ask: `Заявка «${query}» не найдена среди тех, что ${statuses.includes("approved") ? "ждут оплаты" : "ждут решения"}.`,
      notFound: true,
    };
  }
  if (matches.length > 1) {
    return { ask: `Подходит несколько заявок: ${matches.map((m) => `«${m.title}»`).join(", ")}. Уточни, какая.` };
  }
  const m = matches[0];
  return {
    row: { id: m.id, title: m.title, amount: m.amount, currency: m.currency, amountRub: m.amountRub },
  };
}

async function execDecidePayout(
  ctx: ToolCtx,
  input: { payout?: string; decision?: string; note?: string },
): Promise<string> {
  // Строго approve|reject: раньше любая опечатка модели тихо СОГЛАСОВЫВАЛА заявку
  const decision =
    input.decision === "reject" ? "reject" : input.decision === "approve" ? "approve" : null;
  if (!decision) {
    return "Не понял решение по заявке. Спроси у руководителя явно: согласовать или отклонить?";
  }
  const found = await findPayout(ctx, String(input.payout ?? ""), ["pending"]);
  if ("ask" in found) return found.ask;
  const res = await decidePayout(ctx.db, cashActorOf(ctx.user), found.row.id, decision, input.note ?? null);
  if (!res.ok) return `Не удалось: ${res.message}`;
  ctx.touch();
  return res.message;
}

async function execPayPayout(
  ctx: ToolCtx,
  input: { payout?: string; account?: string; paid_on?: string; confirm?: boolean },
): Promise<string> {
  // Оплачиваем ТОЛЬКО согласованные. В вебе оплата pending трактуется как
  // «согласовал и оплатил» одним кликом руководителя, но для голосового/чатового
  // ввода это слишком опасно — оставляем два явных шага.
  const found = await findPayout(ctx, String(input.payout ?? ""), ["approved"]);
  if ("ask" in found) {
    // В pending заглядываем ТОЛЬКО когда среди согласованных ничего нет:
    // на «нашлось несколько согласованных» надо уточнять, а не предлагать
    // согласовать постороннюю pending-заявку с похожим названием
    if (found.notFound) {
      const pending = await findPayout(ctx, String(input.payout ?? ""), ["pending"]);
      if (!("ask" in pending)) {
        return (
          `Заявка «${pending.row.title}» ещё НЕ согласована — сначала согласование (decide_payout), потом оплата. ` +
          "Если руководитель сказал «согласуй и оплати» — сделай оба шага по очереди."
        );
      }
    }
    return found.ask;
  }
  const payout = found.row;

  // Счёт: указан → строгий резолв; не указан → предпочитаем счёт в валюте
  // заявки (как в вебе), а не первый попавшийся
  let account: AccountRef;
  let autoPicked = false;
  const accQuery = String(input.account ?? "").trim();
  if (accQuery) {
    const acc = await resolveAccountStrict(ctx, accQuery);
    if (!acc.ok) return acc.message;
    account = acc.account;
  } else {
    const all = await findAccounts(ctx.db, "");
    if (!all.length) return "Счетов кассы ещё нет — заведите счёт в CRM → Финансы → Касса.";
    const matching = all.filter((a) => a.currency === payout.currency);
    const pool = matching.length ? matching : all;
    if (pool.length > 1) {
      return (
        `С какого счёта оплатить «${payout.title}» (${money(payout.amount, payout.currency)})? ` +
        `Подходящие: ${pool.map((a) => `${a.name} (${CURRENCY_LABEL[a.currency] ?? a.currency})`).join(", ")}. ` +
        "Уточни у сотрудника."
      );
    }
    account = pool[0];
    autoPicked = true;
  }

  // Валюта счёта ≠ валюте заявки: сумма запишется в валюте счёта БЕЗ пересчёта
  // (5000 ¥ с рублёвого счёта = 5000 ₽ в кассе) — только с явным подтверждением
  if (account.currency !== payout.currency && input.confirm !== true) {
    return (
      `Заявка в ${CURRENCY_LABEL[payout.currency] ?? payout.currency} (${money(payout.amount, payout.currency)}), ` +
      `а счёт «${account.name}» — в ${CURRENCY_LABEL[account.currency] ?? account.currency}. ` +
      "Сумма запишется в валюте счёта БЕЗ пересчёта и исказит кассу. " +
      "Лучше укажи счёт в валюте заявки; если платили именно с этого счёта — подтверди у сотрудника и повтори с confirm=true."
    );
  }

  const gate = confirmGate(
    payout.amountRub,
    input.confirm,
    `оплата заявки «${payout.title}» ~${num(payout.amountRub)} ₽ со счёта «${account.name}»`,
  );
  if (gate) return gate;

  const res = await payPayout(ctx.db, cashActorOf(ctx.user), payout.id, account.id, {
    paidOn: input.paid_on ?? null,
  });
  if (!res.ok) return `Не удалось оплатить: ${res.message}`;
  ctx.touch();
  return `${res.message}${autoPicked ? ` Счёт: «${account.name}» (подобран по валюте заявки).` : ""}`;
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
    cost_unknown?: boolean;
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

  // «Бесплатная» поставка портит долги фабрике и себестоимость — стоимость
  // отшивки обязательна, ноль допустим только по явному «внесём позже»
  const sewingCost = posInt(input.sewing_cost);
  const costUnknown = input.cost_unknown === true;
  if ((sewingCost === null || sewingCost === 0) && !costUnknown) {
    return (
      "Спроси стоимость отшивки (долг фабрике) и её валюту — без неё отчёт по долгам будет врать. " +
      "Если сотрудник говорит, что стоимость пока неизвестна, повтори вызов с cost_unknown=true."
    );
  }

  const { data: factories } = await db
    .from("factories")
    .select("id, name, country")
    .eq("org_id", DEMO_ORG_ID)
    .ilike("name", `%${likeSafe(factoryQ)}%`)
    .limit(8);
  const picked = pickOne(
    (factories ?? []) as { id: string; name: string; country: string }[],
    (f) => f.name,
    factoryQ,
    "Фабрики",
  );
  if ("ask" in picked) {
    return picked.ask + " Если фабрики ещё нет — заведи её инструментом create_factory.";
  }

  let productId: string | null = null;
  if (String(input.product ?? "").trim()) {
    const matches = await findProducts(db, String(input.product));
    if (matches.length === 1) productId = matches[0].id;
  }

  // Валюта по умолчанию — из страны фабрики, а не слепое cny
  const defaultCurrency = picked.row.country === "uzbekistan" ? "uzs" : "cny";
  const sewingCurrency = currencyOr(input.sewing_currency, defaultCurrency);
  const cargoCost = posInt(input.cargo_cost);
  const cargoCurrency = currencyOr(input.cargo_currency, defaultCurrency);

  const { error } = await db.from("supplies").insert({
    org_id: DEMO_ORG_ID,
    store_id: DEMO_STORE_ID,
    factory_id: picked.row.id,
    product_id: productId,
    title: title.slice(0, 200),
    quantity,
    ship_date: isoOr(input.ship_date, localIsoDate()),
    sewing_cost: sewingCost ?? 0,
    sewing_currency: sewingCurrency,
    cargo_cost: cargoCost ?? 0,
    cargo_currency: cargoCurrency,
    status: "in_transit",
    created_by: authorId(ctx.user),
  });
  if (error) return `Не удалось создать поставку: ${error.message}`;
  ctx.touch();
  return (
    `Поставка «${title}» с фабрики «${picked.row.name}» создана: ${num(quantity)} шт, статус «в пути». ` +
    (sewingCost
      ? `Отшивка: ${num(sewingCost)} ${CURRENCY_LABEL[sewingCurrency]}${input.sewing_currency ? "" : " (валюта по стране фабрики — проверь)"}.`
      : "Стоимость отшивки НЕ внесена (по слову сотрудника) — напомни внести позже, долги фабрике пока не считаются.") +
    (cargoCost
      ? ` Карго: ${num(cargoCost)} ${CURRENCY_LABEL[cargoCurrency]}.`
      : " Карго не указано — добавится позже через оплату или карточку поставки.")
  );
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
  duty_stats: execDutyStats as Handler,
  complete_duty_for: execCompleteDutyFor as Handler,
  product_info: execProductInfo as Handler,
  stock_report: execStockReport as Handler,
  update_product: execUpdateProduct as Handler,
  create_product: execCreateProduct as Handler,
  set_sales_plan: execSetSalesPlan as Handler,
  add_expense: execAddExpense as Handler,
  add_income: execAddIncome as Handler,
  transfer_money: execTransferMoney as Handler,
  delete_cash_tx: execDeleteCashTx as Handler,
  create_expense_category: execCreateExpenseCategory as Handler,
  pay_salary: execPaySalary as Handler,
  payroll_report: execPayrollReport as Handler,
  my_salary: execMySalary as Handler,
  cash_balance: (ctx) => execCashBalance(ctx),
  pnl_report: execPnlReport as Handler,
  company_expenses: execCompanyExpenses as Handler,
  unit_economics: execUnitEconomics as Handler,
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
  if (spec.permissionsAny && !spec.permissionsAny.some((p) => can(user.role, p))) {
    return `Ошибка: у роли «${user.roleLabel}» нет прав на это действие.`;
  }

  try {
    return await handler({ db, user, touch: () => onMutation?.() }, input as Record<string, never>);
  } catch (e) {
    // Вход логируем обрезанным: там могут быть длинные тексты отчётов
    console.error(`[ai/tools] ${name}:`, JSON.stringify(input ?? {}).slice(0, 500), e);
    const code = (e as { code?: string } | null)?.code;
    const known: Record<string, string> = {
      "23505": "такая запись уже существует",
      "23503": "ссылка на несуществующую запись",
      "22P02": "не найдено (неверный идентификатор)",
      PGRST116: "не найдено",
    };
    const hint = code && known[code] ? ` (${known[code]})` : "";
    return `Ошибка выполнения действия «${name}»${hint}. Скажи пользователю, что не получилось, и предложи попробовать ещё раз.`;
  }
}
