// Контракты данных для панелей. Провайдер (mock | supabase) — src/backend/data/index.ts

export type DashboardKpis = {
  profitRub: number;
  profitabilityPct: number;
  salesRub: number;
  salesQty: number;
  ordersRub: number;
  ordersQty: number;
  stockQty: number;
  stockWarehouses: number;
};

export type DailyPoint = {
  date: string; // ISO yyyy-mm-dd
  label: string; // dd.MM
  sumRub: number;
  qty: number;
};

export type WarehouseStock = {
  warehouse: string;
  qty: number;
};

export type DashboardData = {
  kpis: DashboardKpis;
  ordersDynamics: DailyPoint[]; // бар-чарт «Динамика заказов»
  ordersTrend: DailyPoint[]; // лайн-чарт «Заказы за период»
  stocksByWarehouse: WarehouseStock[]; // донат «Остатки по складам»
  updatedAt: string;
};

export type ProductEconomics = {
  costPrice: number;
  logistics: number;
  profitRub: number;
  marginPct: number;
  profitabilityPct: number;
  drrPct: number;
  ctrPct: number;
  views: number;
  buyoutPct: number;
  croPct: number;
  sppPct: number;
  priceRub: number;
};

export type SizeMatrix = {
  sizes: string[]; // XXS..5XL
  rows: { label: string; values: number[] }[]; // На складе / В пути / Общий / В пошиве
};

export type RnpDay = {
  date: string;
  label: string; // «01.07 ср»
  ordersFact: number;
  ordersPlan: number;
  sppPct: number;
  salesFact: number;
  salesPlan: number;
  avgCheck: number;
  giveaways: number;
  ordersSumRub: number;
  salesSumRub: number;
  views: number;
  clicks: number;
  ctrPct: number;
  cartQty: number;
  cartPct: number;
  orderPct: number;
  croPct: number;
};

export type RnpWeek = {
  label: string; // «Нед 1» … «ИТОГ»
  ordersFact: number;
  ordersPlan: number;
  salesFact: number;
  salesPlan: number;
  ordersSumRub: number;
  salesSumRub: number;
};

export type RnpProduct = {
  id: string;
  nmId: number;
  tabLabel: string; // ярлык вкладки
  title: string;
  status: string; // «Локомотив» и др.
  responsible: string;
  economics: ProductEconomics;
  sizeMatrix: SizeMatrix;
  days: RnpDay[];
  weeks: RnpWeek[];
};

export type ProductListItem = {
  id: string;
  nmId: number;
  vendorCode: string;
  title: string;
  brand: string;
  category: string;
  status: string;
  costPrice: number;
  logisticsCost: number;
  stockQty: number;
  responsible: string;
  // Контент WB (фото/описание/цены — из синхронизации кабинета)
  photoUrl: string | null;
  photos: string[]; // галерея (big)
  description: string | null;
  priceWb: number | null; // цена до скидки
  priceDiscountedWb: number | null; // цена со скидкой продавца
  // Снабжение и продажи (КП: что продаётся, в пути в Москву, на сколько хватит)
  inTransitToMoscow: number; // шт в пути (поставки in_transit/arrived)
  avgDailySales: number; // ср. продаж в день за 30 дней
  daysOfCover: number | null; // на сколько хватит остатка (дней); null — продаж нет
  salesRank30d: number; // продаж за 30 дней (для ранжирования «хорошо/плохо»)
  isWeak: boolean; // слабый товар — кандидат на рекомендацию ИИ
};

// ─── План продаж WB (полугодие) — план/факт по дням ──────────────────────────

export type PlanFactDay = {
  date: string; // yyyy-mm-dd
  label: string; // dd.MM
  planRub: number; // дневной план (сумма периода / дней)
  factRub: number; // факт продаж за день
  isFuture: boolean; // день ещё не наступил (факта нет по определению)
};

export type SalesPlanView = {
  hasPlan: boolean;
  periodStart: string; // yyyy-mm-dd
  periodEnd: string;
  amountRub: number; // план на период
  factToDateRub: number; // факт с начала периода
  planToDateRub: number; // план с начала периода по сегодня
  completionPct: number; // факт / план-на-сегодня
  dailyPlanRub: number; // план на день
  neededDailyRub: number; // сколько нужно в день до конца периода
  days: PlanFactDay[];
};

export type FinanceRow = {
  period: string; // «Июнь 2026»
  salesRub: number;
  commissionRub: number;
  logisticsRub: number;
  storageRub: number;
  penaltyRub: number;
  toPayRub: number;
  profitRub: number;
};

// ─── Касса и расходы (миграция 0024) ─────────────────────────────────────────

export type CashAccountKind = "cash" | "bank" | "card" | "wb" | "other";
export type CashTxKind = "in" | "out" | "transfer";

export type CashAccount = {
  id: string;
  name: string;
  kind: CashAccountKind;
  currency: Currency; // валюта счёта
  balance: number; // остаток в валюте счёта
  balanceRub: number; // он же в рублях (по общему курсу)
  txCount: number;
  lastTx: string | null; // дата последней операции, yyyy-mm-dd
};

export type ExpenseCategory = {
  id: string;
  name: string;
  direction: "in" | "out";
  inPnl: boolean; // влияет ли на прибыль периода
  emoji: string | null;
};

export type CashTx = {
  id: string;
  kind: CashTxKind;
  accountId: string;
  accountName: string;
  toAccountName: string | null; // для перевода
  categoryId: string | null;
  categoryName: string | null;
  categoryEmoji: string | null;
  amount: number; // в валюте счёта
  currency: Currency;
  amountRub: number;
  occurredOn: string; // yyyy-mm-dd
  note: string | null;
  authorName: string | null;
  source: "manual" | "bot" | "ai" | "supply_payment" | "wb_payout";
};

export type CashFlowMonth = {
  month: string; // yyyy-mm-01
  label: string; // «Июль»
  inRub: number;
  outRub: number;
};

export type CashOverview = {
  accounts: CashAccount[];
  totalRub: number; // всего денег в кассе, ₽
  monthInRub: number; // приход за текущий месяц
  monthOutRub: number; // расход за текущий месяц
  flow: CashFlowMonth[]; // помесячно за последние 6 мес
  recent: CashTx[]; // лента последних операций
};

export type ExpenseCategorySlice = {
  categoryId: string | null;
  name: string;
  emoji: string | null;
  inPnl: boolean;
  amountRub: number;
  txCount: number;
  sharePct: number;
};

export type ExpensesView = {
  from: string; // yyyy-mm-dd
  to: string;
  totalRub: number; // все расходы периода
  opexRub: number; // из них влияющих на прибыль
  categories: ExpenseCategorySlice[];
  items: CashTx[]; // операции периода (kind = out)
  monthly: { month: string; label: string; totalRub: number }[];
};

// ─── ОПиУ (отчёт о прибылях и убытках) ───────────────────────────────────────

export type PnlMonth = {
  month: string; // yyyy-mm-01
  label: string; // «Июль 2026»
  revenueRub: number; // выручка (продажи по цене со скидкой, минус возвраты)
  wbFeesRub: number; // удержания WB (выручка − к перечислению)
  cogsRub: number; // себестоимость проданного товара
  grossRub: number; // валовая прибыль
  opexRub: number; // операционные расходы (касса, статьи с in_pnl)
  otherIncomeRub: number; // прочие доходы
  netRub: number; // чистая прибыль
  marginPct: number; // рентабельность к выручке
  qty: number; // продано штук
  costCoveragePct: number; // % продаж с заполненной себестоимостью
};

export type PnlView = {
  months: PnlMonth[]; // от старого к новому
  total: PnlMonth; // итог за период
  expenseSlices: ExpenseCategorySlice[]; // расходы периода по статьям
  costCoveragePct: number; // покрытие себестоимостью за период
  hasExpenses: boolean; // заведены ли расходы вообще
  advertSpendRub: number; // расход на рекламу из кабинета WB (если синхронизирован)
};

export type TaskItem = {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "in_progress" | "done";
  priority: "low" | "normal" | "high" | "urgent";
  assignee: string;
  assigneeId: string | null; // кто может закрывать (исполнитель) — для UI-кнопок
  dueDate: string | null;
  productLabel: string | null;
  // Отчёт о выполнении (обязателен при закрытии — миграция 0023)
  report: string | null;
  completedAt: string | null;
  completedOnTime: boolean | null; // null — срока не было
};

export type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: string; // member_role
  joinedAt: string;
};

export type IntegrationStatus = {
  provider: "wb" | "claude" | "telegram";
  title: string;
  status: "pending" | "valid" | "invalid";
  hint: string;
  scopes: string[];
  lastSyncAt: string | null;
};

export type Tariff = {
  code: string;
  name: string;
  priceMonth: number;
  maxStores: number;
  maxProducts: number | null;
  aiTokensMonth: number;
  syncIntervalMin: number;
  current: boolean;
};

// ─── Цепочка поставок (КП) ───────────────────────────────────────────────────

export type SupplyCountry = "china" | "uzbekistan";
export type Currency = "cny" | "uzs" | "rub";
export type SupplyStatus =
  | "in_transit" // В пути
  | "arrived" // Приехал (авто через 15 дней, ожидает приёмки)
  | "received" // Принят (приёмщик подтвердил «Товар прибыл»)
  | "sorting" // В разборе
  | "in_stock" // Лежит на складе фул-фирмы
  | "distributed" // Распределён по складам WB
  | "cancelled";

export type Factory = {
  id: string;
  name: string;
  country: SupplyCountry;
  note: string | null;
  suppliesCount: number; // всего поставок
  shippedQty: number; // сколько отшили, шт
  shippedSumRub: number; // на какую сумму (отшивка+карго в ₽)
  inTransitCount: number; // сейчас в пути
  avgTransitDays: number | null; // ср. время в пути по завершённым
};

export type SupplyPayment = {
  id: string;
  kind: "goods" | "cargo"; // за товар / за карго
  amount: number;
  currency: Currency;
  paidAt: string;
  note: string | null;
};

export type WbDistribution = {
  id: string;
  warehouse: string;
  quantity: number;
};

export type Supply = {
  id: string;
  factoryId: string;
  factoryName: string;
  country: SupplyCountry;
  productId: string | null;
  title: string;
  quantity: number;
  shipDate: string;
  sewingCost: number;
  sewingCurrency: Currency;
  cargoCost: number;
  cargoCurrency: Currency;
  status: SupplyStatus;
  statusLabel: string;
  autoArrived: boolean; // статус выставлен авто-правилом 15 дней (derived)
  daysInTransit: number | null; // сколько уже едет (для активных) или итог
  receivedAt: string | null;
  receivedQty: number | null;
  receiptComment: string | null;
  transitDays: number | null;
  shortage: number; // недостача = quantity − receivedQty (если принято меньше)
  responsible: string;
  payments: SupplyPayment[];
  paidGoodsRub: number; // оплачено за товар, ₽
  paidCargoRub: number; // оплачено за карго, ₽
  owedRub: number; // сколько ещё должны (отшивка+карго − оплачено), ₽
  distributions: WbDistribution[];
  distributedQty: number;
};

export type FulfillmentSummary = {
  receivedQty: number; // приняли (получено фактически)
  sortingQty: number; // в разборе
  inStockQty: number; // лежит
  distributedQty: number; // распределено по WB
  shortageQty: number; // суммарная недостача
  cards: Supply[]; // карточки на стадии фул-фирмы
};

// ─── Регламент обязанностей и отчёты ─────────────────────────────────────────

export type DutyStatus = "pending" | "done" | "missed";

export type DutyItem = {
  id: string; // id назначения (duty_assignments)
  code: string;
  title: string;
  description: string | null;
  frequency: "daily" | "weekly";
  dueAt: string; // ISO дедлайн
  dueLabel: string; // «до 11:00»
  hoursToComplete: number;
  status: DutyStatus;
  completedAt: string | null;
  requiresReport: boolean;
  reportContent: string | null;
  reportOnTime: boolean | null;
  assigneeId: string;
  assigneeName: string;
};

// Сводка дня для вкладки «Отчёты» (директор / старший менеджер)
// Отчёт по закрытой задаче (страница «Отчёты» — руководству)
export type TaskReportItem = {
  id: string;
  title: string;
  assignee: string;
  report: string | null;
  completedAt: string;
  onTime: boolean | null;
  dueDate: string | null;
};

export type ReportsBoard = {
  date: string; // yyyy-mm-dd (выбранный день)
  total: number;
  done: number;
  onTime: number;
  missed: number;
  pending: number;
  items: DutyItem[]; // все назначения дня по всем сотрудникам (с отчётами)
};

// ─── Остатки по складам (страница «Остатки») ─────────────────────────────────

export type WarehouseStockRunway = {
  warehouse: string;
  qty: number;
  orders30d: number; // заказов с этого склада за 30 дней
  daysOfCover: number | null; // qty / (orders30d/30); null — заказов не было
};

export type StocksOverview = {
  warehouses: WarehouseStockRunway[]; // по убыванию количества
  totalQty: number; // всего на складах WB
  inTransitQty: number; // в пути (к клиенту/возвраты)
  productsWithStock: number; // товаров с ненулевым остатком
};

// Остатки конкретного товара: склад × размер (последний снимок)
export type ProductStockRow = {
  warehouse: string;
  size: string;
  onStock: number;
  inTransit: number;
};

// ─── Дизайн карточек (заявки менеджеров → дизайнер → утверждение) ───────────

export type DesignStatus = "new" | "in_progress" | "review" | "done" | "rejected";

export type DesignRequest = {
  id: string;
  title: string; // какой товар / что нужно
  brief: string | null; // задача: обложка, слайды, RICH…
  referencesText: string | null; // референсы: ссылки, примеры
  status: DesignStatus;
  productId: string | null;
  productTitle: string | null;
  productPhotoUrl: string | null;
  requesterName: string;
  assigneeName: string | null; // дизайнер, взявший в работу
  resultUrl: string | null; // ссылка на макет
  resultComment: string | null;
  reviewComment: string | null; // комментарий утверждающего
  createdAt: string;
  updatedAt: string;
};

// Единый контракт ответа рекомендаций по товару (Claude или эвристика)
export type ProductRecommendation = {
  productId: string;
  source: "claude" | "heuristic";
  summary: string;
  problems: { metric: string; severity: "low" | "medium" | "high"; reason: string }[];
  recommendations: { action: string; impact: string; priority: number }[];
};
