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

// Происхождение себестоимости: руками / импорт из файла / из приёмки поставки
export type CostPriceSource = "manual" | "import" | "supply";

// Юнит-экономика товара за период (факт из отчётов WB, на единицу — где уместно)
export type ProductUnitEcon = {
  periodDays: number;
  saleQty: number; // продано за период, шт (за вычетом возвратов)
  priceRub: number; // средняя цена реализации за единицу
  commissionRub: number; // комиссия WB + эквайринг, за единицу
  logisticsRub: number; // логистика за единицу
  storageRub: number; // хранение за единицу
  acceptanceRub: number; // приёмка за единицу
  advertRub: number; // реклама за единицу
  costPrice: number; // себестоимость единицы
  profitPerUnitRub: number;
  profitRub: number; // прибыль за период (все продажи)
  marginPct: number; // прибыль / выручка
  roiPct: number; // прибыль / себестоимость проданного
  drrPct: number; // реклама / выручка
};

// Группа товаров («группа Алик», «группа Тимур») — деление каталога между
// ответственными. Создают и раскидывают директор/ст. менеджер (products:groups).
export type ProductGroup = {
  id: string;
  name: string;
};

// Остаток одного размера товара (последний снимок складов WB) + скорость
export type ProductSizeStock = {
  size: string;
  onStock: number; // на складах WB
  inTransit: number; // в пути между складами WB
  sales30d: number; // продаж этого размера за 30 дней
  daysOfCover: number | null; // на сколько хватит размера (дней); null — продаж нет
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
  costPriceSource: CostPriceSource;
  costPriceUpdatedAt: string | null;
  // Из чего сложилась себестоимость (₽/шт). Сумма трёх = costPrice, когда
  // источник «supply». При ручном вводе и импорте разбивки нет — всё в отшиве.
  costSewingRub: number;
  costCargoRub: number;
  costFulfillmentRub: number;
  logisticsCost: number;
  stockQty: number;
  sizes: ProductSizeStock[]; // разбивка остатка по размерам (сумма = stockQty)
  groupId: string | null; // группа товаров (null — без группы)
  groupName: string | null;
  responsible: string;
  econ: ProductUnitEcon | null; // юнит-экономика за 30 дней (null — продаж не было)
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

// Показатели — как в виджете плана ЛК WB (программа «скидка за выполнение
// плана»): план на период ставит WB, суммы в валюте кабинета (у киргизского
// юрлица — сомы). Поля *Rub исторические — значение в валюте `currency`.
export type SalesPlanView = {
  hasPlan: boolean;
  periodStart: string; // yyyy-mm-dd
  periodEnd: string;
  amountRub: number; // план на период
  factToDateRub: number; // факт с начала периода
  planToDateRub: number; // план с начала периода по сегодня
  completionPct: number; // темп: факт / план-на-сегодня
  completionTotalPct: number; // как в ЛК: факт / ВЕСЬ план на период
  dailyPlanRub: number; // план на день (план / дни периода)
  neededDailyRub: number; // остаток / оставшиеся дни (включая сегодня)
  remainingRub: number; // осталось продать до плана
  remainingDays: number; // осталось дней (включая сегодня)
  avgDailyFactRub: number; // текущий темп: средний факт за последние 14 дней
  forecastRub: number; // прогноз на конец периода по текущему темпу
  forecastPct: number; // прогноз / план
  currency: string; // валюта кабинета: RUB, KGS…
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
  isPayroll: boolean; // деньги человеку (зарплата, премия, подрядчик, возмещение)
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
  personId: string | null; // кому эти деньги (сотрудник)
  personName: string | null;
  source: "manual" | "bot" | "ai" | "supply_payment" | "wb_payout" | "payout";
  // processing — WB отправил выплату, но деньги ещё не дошли до счёта:
  // в остатках и ДДС не участвует, ждёт подтверждения кнопкой
  status: "processing" | "received";
};

export type CashFlowMonth = {
  month: string; // yyyy-mm-01
  label: string; // «Июль»
  inRub: number;
  outRub: number;
};

export type CashOverview = {
  accounts: CashAccount[];
  // Деньги, которые WB ещё не перечислил: они есть у компании, но не в кассе.
  // Показываем отдельно, чтобы «всего денег» не смешивало наличные и дебиторку.
  wbBalance: { currency: string; current: number; forWithdraw: number; checkedAt: string } | null;
  totalRub: number; // всего денег в кассе, ₽ (без выплат «в обработке»)
  monthInRub: number; // приход за текущий месяц
  monthOutRub: number; // расход за текущий месяц
  flow: CashFlowMonth[]; // помесячно за последние 6 мес
  recent: CashTx[]; // лента последних операций
  // Выплаты WB «в обработке»: отчёт сформирован, деньги ещё не на счёте.
  // Подтверждаются кнопкой «Поступили на счёт» — тогда попадают в остатки.
  wbProcessing: CashTx[];
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

// ─── Заявки на выплату (миграция 0029) ──────────────────────────────────────

export type PayoutKind = "salary" | "contractor" | "factory" | "reimbursement" | "other";
export type PayoutStatus = "pending" | "approved" | "rejected" | "paid" | "cancelled";

export type PayoutRequest = {
  id: string;
  kind: PayoutKind;
  status: PayoutStatus;
  title: string;
  description: string | null;
  amount: number;
  currency: Currency;
  amountRub: number; // для сводок
  dueDate: string | null;
  payee: string | null; // кому платим, если не сам заявитель
  payeeUserId: string | null; // тот же адресат, но сотрудником из команды
  payeeUserName: string | null;
  requesterId: string;
  requesterName: string;
  requesterRole: string | null;
  categoryId: string | null;
  categoryName: string | null;
  factoryId: string | null;
  factoryName: string | null;
  supplyId: string | null;
  supplyTitle: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  paidAt: string | null;
  paidAccountName: string | null;
  createdAt: string;
};

export type PayoutsView = {
  items: PayoutRequest[];
  pendingCount: number;
  pendingRub: number; // сколько ждёт согласования
  approvedRub: number; // согласовано, но ещё не оплачено
  paidMonthRub: number; // выплачено в этом месяце
};

// ─── Выплаты команде: кому сколько ушло (миграция 0030) ─────────────────────

export type PayrollSlice = {
  categoryId: string | null;
  name: string; // «Зарплата», «Премии и бонусы», «Возмещение сотруднику»
  emoji: string | null;
  amountRub: number;
  txCount: number;
};

export type PayrollPerson = {
  personId: string;
  name: string;
  role: string; // код роли (member_role)
  roleLabel: string;
  amountRub: number; // выплачено за период
  txCount: number;
  lastPaidOn: string | null; // yyyy-mm-dd
  sharePct: number; // доля от фонда выплат за период
  slices: PayrollSlice[]; // из чего сложилось
  monthly: { month: string; label: string; amountRub: number }[];
};

export type PayrollView = {
  from: string; // yyyy-mm-dd
  to: string;
  totalRub: number; // фонд выплат людям за период
  people: PayrollPerson[];
  unassignedRub: number; // выплаты «людям» без указанного сотрудника
  unassignedCount: number;
  items: CashTx[]; // операции периода (только адресные выплаты)
  pendingRub: number; // согласовано к выплате, но ещё не оплачено
};

// ─── ОПиУ (отчёт о прибылях и убытках) ───────────────────────────────────────

export type PnlMonth = {
  month: string; // yyyy-mm-01
  label: string; // «Июль 2026»
  revenueRub: number; // выручка (реализация за вычетом возвратов)
  wbFeesRub: number; // ИТОГО удержания WB (сумма строк ниже)
  // Детализация удержаний — из отчёта о реализации WB (v5/reportDetailByPeriod).
  // Если отчёт за месяц ещё не синхронизирован, в commissionRub попадает
  // оценка «выручка − к перечислению», остальные строки нулевые (source).
  commissionRub: number; // комиссия WB
  acquiringRub: number; // эквайринг
  logisticsRub: number; // логистика
  storageRub: number; // хранение
  penaltyRub: number; // штрафы
  acceptanceRub: number; // платная приёмка
  deductionRub: number; // прочие удержания
  advertRub: number; // расход на внутреннюю рекламу WB
  cogsRub: number; // себестоимость проданного товара
  grossRub: number; // валовая прибыль (выручка − удержания WB − себестоимость)
  opexRub: number; // расходы компании из кассы (статьи с in_pnl)
  otherIncomeRub: number; // прочие доходы
  netRub: number; // чистая прибыль
  marginPct: number; // рентабельность к выручке
  qty: number; // продано штук
  costCoveragePct: number; // % продаж с заполненной себестоимостью
  source: "wb_report" | "estimate"; // откуда удержания: отчёт WB или оценка
};

export type PnlView = {
  months: PnlMonth[]; // от старого к новому
  total: PnlMonth; // итог за период
  expenseSlices: ExpenseCategorySlice[]; // расходы периода по статьям
  costCoveragePct: number; // покрытие себестоимостью за период
  hasExpenses: boolean; // заведены ли расходы вообще
  hasWbReport: boolean; // синхронизирован ли отчёт о реализации WB
  reportUntil: string | null; // по какую дату WB посчитал (позже — без удержаний)
  advertSpendRub: number; // расход на рекламу из кабинета WB
  currency: string; // валюта кабинета из отчёта WB: RUB, KGS…
  wbBalance: { currency: string; current: number; forWithdraw: number; checkedAt: string } | null;
  // Из чего складываются «прочие удержания» (самовыкупы, подмены…) по месяцам
  deductionDetails: { month: string; operName: string; amountRub: number }[];
};

// ─── Юнит-экономика (страница «Экономика») ───────────────────────────────────

export type UnitEconRow = {
  nmId: number; // 0 — «нераспределённое»: медийная реклама, хранение/удержания без товара
  title: string;
  photoUrl: string | null;
  category: string;
  saleQty: number; // продано − возвраты, шт
  revenueRub: number;
  commissionRub: number; // комиссия WB
  acquiringRub: number;
  logisticsRub: number;
  storageRub: number;
  acceptanceRub: number;
  penaltyRub: number;
  deductionRub: number;
  advertRub: number;
  drrPct: number; // реклама / выручка
  costPrice: number; // себестоимость единицы
  costPriceSource: CostPriceSource | null;
  cogsRub: number; // себестоимость проданного за период
  profitRub: number;
  profitPerUnitRub: number;
  marginPct: number;
  roiPct: number;
};

export type UnitEconView = {
  from: string; // yyyy-mm-dd
  to: string;
  days: number;
  rows: UnitEconRow[]; // товары, отсортированы по прибыли
  unallocated: UnitEconRow | null; // nm_id=0 + сверка хранения/приёмки с финотчётом
  totals: {
    saleQty: number;
    revenueRub: number;
    wbFeesRub: number;
    advertRub: number;
    cogsRub: number;
    profitRub: number;
    marginPct: number;
  };
  storageSource: "daily" | "finance"; // откуда хранение: детальный отчёт или финотчёт
  costCoveragePct: number; // % проданных штук с заполненной себестоимостью
};

// ─── Поставки FBW (приёмки складов WB) ───────────────────────────────────────

export type WbIncomeGroup = {
  incomeId: number;
  date: string; // дата поставки, yyyy-mm-dd
  dateClose: string | null; // дата принятия
  warehouse: string;
  totalQty: number;
  positions: number; // позиций (артикулов)
  status: string;
  items: { nmId: number; title: string; qty: number }[]; // топ-позиции
};

export type TaskItem = {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "in_progress" | "done";
  priority: "low" | "normal" | "high" | "urgent";
  assignee: string;
  assigneeId: string | null; // кто может закрывать (исполнитель) — для UI-кнопок
  createdById: string | null; // автор задачи (может брать бесхозные свои задачи)
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
// kgs — валюта киргизского кабинета WB (в ней приходят деньги от маркетплейса)
export type Currency = "cny" | "uzs" | "rub" | "kgs";
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
  kind: "goods" | "cargo" | "fulfillment"; // за товар / за карго / фул-фирме
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

// Позиция поставки: один артикул со своим количеством и отшивом.
// Карго и услуги фул-фирмы — общие на поставку, распределяются между позициями
// пропорционально количеству (см. backend/data/cost-core.ts).
export type SupplyItem = {
  id: string;
  productId: string | null;
  title: string;
  quantity: number; // отгружено
  receivedQty: number | null; // принято
  sewingCost: number;
  sewingCurrency: Currency;
  // Себестоимость единицы по этой позиции (₽), считается из партии
  sewingRub: number;
  cargoRub: number;
  fulfillmentRub: number;
  unitCostRub: number;
};

// Фул-фирма: тариф за единицу приёмки/разбора/упаковки
export type FulfillmentPartner = {
  id: string;
  name: string;
  ratePerUnitRub: number;
  note: string | null;
  archived: boolean;
  suppliesCount: number; // сколько поставок разобрала
  chargedRub: number; // начислено всего
  paidRub: number; // оплачено
  owedRub: number; // долг
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
  items: SupplyItem[]; // позиции (пусто — поставка по старой схеме «один товар»)
  payments: SupplyPayment[];
  paidGoodsRub: number; // оплачено за товар, ₽
  paidCargoRub: number; // оплачено за карго, ₽
  paidFulfillmentRub: number; // оплачено фул-фирме, ₽
  // Услуги фул-фирмы: факт, либо тариф партнёра × принято
  fulfillmentPartnerId: string | null;
  fulfillmentPartnerName: string | null;
  fulfillmentRub: number; // начислено фул-фирме за эту поставку, ₽
  owedRub: number; // сколько ещё должны (отшивка + карго + ФФ − оплачено), ₽
  distributions: WbDistribution[];
  distributedQty: number;
};

export type FulfillmentSummary = {
  receivedQty: number; // приняли (получено фактически)
  sortingQty: number; // в разборе
  inStockQty: number; // лежит
  distributedQty: number; // распределено по WB
  shortageQty: number; // суммарная недостача
  // Деньги фул-фирмы: до 0037 модуль был только в штуках
  chargedRub: number; // начислено за услуги
  paidRub: number; // оплачено
  owedRub: number; // долг фул-фирме
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

// ─── Статистика дисциплины регламента за период ──────────────────────────────

export type DutyGrade = "good" | "ok" | "bad";

export type DutyEmployeeStat = {
  assigneeId: string;
  assigneeName: string;
  total: number; // назначений за период (сегодняшние pending не в счёт)
  done: number;
  missed: number;
  doneOnTime: number; // закрыто до дедлайна (по completed_at <= due_at)
  completionPct: number; // 0..100
  onTimePct: number; // 0..100
  score: number; // 0..100 — половина за выполнение, половина за своевременность
  grade: DutyGrade; // ≥80 good · 50–79 ok · <50 bad
  problems: { title: string; missed: number; late: number }[]; // топ-3 срываемых
};

export type DutyStatsPeriod = {
  days: 7 | 30;
  from: string; // yyyy-mm-dd
  employees: DutyEmployeeStat[]; // отсортированы по score (лучшие сверху)
  teamCompletionPct: number;
  teamOnTimePct: number;
};

export type DutyStats = { d7: DutyStatsPeriod; d30: DutyStatsPeriod };

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
// К чему относится совет — чтобы в карточке было сразу видно, что чинить:
// фото, цену, описание, размерный ряд, рекламу или поставку.
export type ProductRecoArea =
  | "photo"
  | "price"
  | "description"
  | "sizes"
  | "ads"
  | "supply"
  | "other";

// Воронка карточки за период: показы → корзина → заказ → выкуп.
// Именно она отвечает на «почему товар слабый»: провал показ→корзина — вопрос
// к фото/цене/заголовку, корзина→заказ — к цене, низкий выкуп — к описанию
// и размерной сетке (люди заказали, померили и вернули).
export type ProductFunnel = {
  days: number;
  opens: number;
  carts: number;
  orders: number;
  buyouts: number;
  cartRate: number; // % показов, дошедших до корзины
  orderRate: number; // % корзин, дошедших до заказа
  buyoutRate: number; // % заказов, выкупленных
};

export type ProductRecommendation = {
  productId: string;
  source: "claude" | "heuristic";
  verdict: "strong" | "ok" | "weak";
  summary: string;
  problems: { metric: string; severity: "low" | "medium" | "high"; reason: string }[];
  recommendations: {
    area: ProductRecoArea;
    action: string;
    impact: string;
    priority: number;
  }[];
  funnel?: ProductFunnel | null; // показываем цифры рядом с разбором
};
