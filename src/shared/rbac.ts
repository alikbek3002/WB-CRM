// RBAC: роли и матрица прав из раздела 5.1 плана.
// Роли хранятся в БД как enum member_role (миграции 0002 + 0018).

export type MemberRole =
  | "owner"
  | "admin"
  | "manager"
  | "analyst"
  | "viewer"
  | "designer" // дизайнер карточек
  | "seo" // SEO-менеджер (и дизайнер)
  | "kiz" // менеджер по КИЗам (маркировка)
  | "adv" // менеджер по внутренней рекламе
  | "shipping"; // менеджер по отгрузкам на склады WB

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: "Директор",
  admin: "Администратор",
  manager: "Старший менеджер",
  analyst: "Аналитик",
  viewer: "Наблюдатель",
  designer: "Дизайнер",
  seo: "SEO-менеджер",
  kiz: "Менеджер по КИЗам",
  adv: "Менеджер по рекламе",
  shipping: "Менеджер по отгрузкам",
};

export type Permission =
  | "dashboard:view"
  | "rnp:view"
  | "rnp:edit" // редактирование планов
  | "products:view"
  | "products:edit" // себестоимость, статусы, карточки
  | "products:groups" // создать/удалить группы товаров и раскидать по ним товары
  | "finance:view"
  | "finance:plan" // задать план продаж WB на период
  | "finance:cash" // касса: остатки по счетам, движение денег, ОПиУ
  | "finance:expense" // вносить расходы/приходы и править кассу
  | "currency:manage" // сводить курсы валют к сому (директор и ст. менеджер)
  | "payout:request" // попросить выплату (зарплата, подрядчик, счёт фабрики)
  | "payout:approve" // согласовать и оплатить заявку
  | "tasks:view" // viewer видит только свои — фильтрация на уровне данных/RLS
  | "team:manage"
  | "integrations:manage" // API-ключи
  | "tariffs:manage"
  // ─── Цепочка поставок (КП) ───
  | "factory:view"
  | "factory:edit" // создание фабрик
  | "supply:view"
  | "supply:edit" // создание карточек отгрузки (закупщики)
  | "supply:pay" // оплаты товар/карго (финансисты)
  | "supply:receive" // приёмка + распределение по WB (приёмщик Москва)
  | "fulfillment:view"
  | "fulfillment:manage" // тарифы фул-фирмы и начисления за разбор
  // ─── Регламент и отчёты ───
  | "duty:view" // мои ежедневные обязанности
  | "duty:complete" // отметить выполнение + отчёт
  | "duty:manage" // править сам регламент (директор — всем, ст. менеджер — кроме своего)
  | "reports:view" // отчёты всех менеджеров (директор/ст. менеджер)
  // ─── Дизайн карточек ───
  | "design:view" // очередь заявок на дизайн
  | "design:request" // создать заявку (товар + референсы)
  | "design:submit" // сдать макет (дизайнер)
  | "design:approve"; // утвердить/вернуть (директор/ст. менеджер)

const ALL: Permission[] = [
  "dashboard:view",
  "rnp:view",
  "rnp:edit",
  "products:view",
  "products:edit",
  "products:groups",
  "finance:view",
  "finance:plan",
  "finance:cash",
  "finance:expense",
  "currency:manage",
  "payout:request",
  "payout:approve",
  "tasks:view",
  "team:manage",
  "integrations:manage",
  "tariffs:manage",
  "factory:view",
  "factory:edit",
  "supply:view",
  "supply:edit",
  "supply:pay",
  "supply:receive",
  "fulfillment:view",
  "fulfillment:manage",
  "duty:view",
  "duty:complete",
  "duty:manage",
  "reports:view",
  "design:view",
  "design:request",
  "design:submit",
  "design:approve",
];

export const ROLE_PERMISSIONS: Record<MemberRole, Permission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== "tariffs:manage"),
  manager: [
    "dashboard:view",
    "rnp:view",
    "rnp:edit",
    "products:view",
    "products:edit",
    "products:groups", // директор и ст. менеджер делят товары по группам
    "finance:view",
    "finance:plan",
    "finance:cash",
    "finance:expense",
    "currency:manage", // курс доллара к сому сводят директор и ст. менеджер
    "payout:request",
    "payout:approve",
    "tasks:view",
    "factory:view",
    "factory:edit",
    "supply:view",
    "supply:edit",
    "supply:pay",
    "supply:receive",
    "fulfillment:view",
    "fulfillment:manage",
    "duty:view",
    "duty:complete",
    // Регламент ст. менеджер правит всем, КРОМЕ себя — это проверяется по самой
    // обязанности (shared/duties.ts), правом такое не выразить
    "duty:manage",
    "reports:view", // старший менеджер видит отчёты команды
    "design:view",
    "design:request",
    "design:approve",
  ],
  analyst: [
    "dashboard:view",
    "payout:request",
    "rnp:view",
    "products:view",
    "finance:view",
    "tasks:view",
    "factory:view",
    "supply:view",
    "fulfillment:view",
    "duty:view",
  ],
  viewer: [
    // Наблюдатель (гость/инвестор) — только чтение: заявки на выплату ему не
    // положены, деньги компании он не просит
    "dashboard:view",
    "rnp:view",
    "tasks:view",
    "factory:view",
    "supply:view",
    "fulfillment:view",
  ],
  // ─── Специализации (реальная команда) ───
  designer: [
    "dashboard:view",
    "payout:request",
    "products:view",
    "tasks:view",
    "duty:view",
    "duty:complete",
    "design:view",
    "design:submit",
  ],
  seo: [
    "dashboard:view",
    "payout:request",
    "products:view",
    "products:edit", // SEO правит карточки (ключи, тексты)
    "tasks:view",
    "duty:view",
    "duty:complete",
    "design:view",
    "design:request",
    "design:submit", // Назира — SEO и дизайнер
  ],
  kiz: [
    "dashboard:view",
    "payout:request",
    "products:view",
    "supply:view",
    "fulfillment:view",
    "tasks:view",
    "duty:view",
    "duty:complete",
  ],
  adv: [
    "dashboard:view",
    "payout:request",
    "products:view",
    "rnp:view",
    "tasks:view",
    "duty:view",
    "duty:complete",
    "design:view",
    "design:request", // заказ креативов для рекламы
  ],
  shipping: [
    "dashboard:view",
    "payout:request",
    "products:view",
    "supply:view",
    "supply:edit",
    "supply:receive",
    "fulfillment:view",
    "tasks:view",
    "duty:view",
    "duty:complete",
    "design:view", // видит статусы дизайна перед отгрузкой
  ],
};

export function can(role: MemberRole, permission: Permission): boolean {
  // ?. — сессия-заглушка (anonymous при выключенном демо) не имеет строки в
  // матрице → любое право = false. Не бросаем, чтобы API отвечал 403, а не 500.
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function isMemberRole(value: string): value is MemberRole {
  return value in ROLE_LABELS;
}
