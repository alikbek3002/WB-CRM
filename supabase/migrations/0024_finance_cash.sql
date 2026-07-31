-- ─────────────────────────────────────────────────────────────────────────────
-- 0024: Управленческие финансы — КАССА, РАСХОДЫ и ОПиУ (прибыль по-настоящему).
--
--   WB API даёт только выручку и удержания маркетплейса. Реальную прибыль
--   считать нельзя, пока в системе нет денег компании: сколько заплатили за
--   рекламу, зарплаты, карго, налоги и сколько наличных/на счетах осталось.
--
--   Модель намеренно одна на всё («книга денег»), чтобы не было двойного учёта:
--     • cash_accounts     — где лежат деньги (наличные, банк, карта, юани…)
--     • expense_categories — статьи прихода/расхода (+ флаг «идёт ли в ОПиУ»)
--     • cash_tx           — каждая операция: приход / расход / перевод
--   «Расходы» в интерфейсе = cash_tx с kind='out'. Касса = счета + их операции.
--
--   ОПиУ (P&L) собирается на чтении из четырёх источников:
--     выручка (raw_sales) − удержания WB (выручка − for_pay) − себестоимость
--     проданного (products.cost_price) − расходы периода (cash_tx, in_pnl).
--   Закуп товара и переводы между счетами в ОПиУ НЕ входят (это движение
--   активов, не затрата периода) — за это отвечает expense_categories.in_pnl.
-- ─────────────────────────────────────────────────────────────────────────────

------------------------------------------------------------------------------
-- cash_accounts — счета/кошельки компании
------------------------------------------------------------------------------

create table cash_accounts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  name            text not null,
  kind            text not null default 'cash'
                    check (kind in ('cash','bank','card','wb','other')),
  currency        text not null default 'rub'
                    check (currency in ('rub','cny','uzs')),
  opening_balance numeric(14,2) not null default 0,   -- остаток на момент заведения
  note            text,
  archived        boolean not null default false,
  sort_order      integer not null default 100,
  created_by      uuid references profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, name)
);

------------------------------------------------------------------------------
-- expense_categories — статьи движения денег
--   direction: 'out' — расход, 'in' — приход
--   in_pnl:    учитывать ли статью в ОПиУ (прибыли).
--     false — закуп товара (попадёт в прибыль через себестоимость проданного),
--             поступления от WB (выручка уже посчитана по продажам),
--             пополнение/изъятие владельцем.
------------------------------------------------------------------------------

create table expense_categories (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  name       text not null,
  direction  text not null default 'out' check (direction in ('out','in')),
  in_pnl     boolean not null default true,
  emoji      text,                                    -- для бота и списков
  archived   boolean not null default false,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

------------------------------------------------------------------------------
-- cash_tx — книга операций (приход / расход / перевод)
--   amount     — сумма в валюте счёта-источника
--   amount_to  — сколько зачислено на счёт-получатель (перевод с конвертацией)
--   rate_to_rub — курс валюты счёта к рублю на дату операции (rub → 1)
--   amount_rub — сумма в рублях (для сводок и ОПиУ), считается автоматически
--   source/source_id — откуда пришла операция: рука, бот, ИИ, оплата поставки
------------------------------------------------------------------------------

create table cash_tx (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  kind          text not null check (kind in ('in','out','transfer')),
  account_id    uuid not null references cash_accounts(id) on delete restrict,
  to_account_id uuid references cash_accounts(id) on delete restrict,
  category_id   uuid references expense_categories(id) on delete set null,
  amount        numeric(14,2) not null check (amount > 0),
  amount_to     numeric(14,2) check (amount_to is null or amount_to > 0),
  currency      text not null default 'rub'
                  check (currency in ('rub','cny','uzs')),
  rate_to_rub   numeric(14,6) not null default 1 check (rate_to_rub > 0),
  amount_rub    numeric(16,2) generated always as (round(amount * rate_to_rub, 2)) stored,
  occurred_on   date not null default current_date,
  note          text,
  source        text not null default 'manual'
                  check (source in ('manual','bot','ai','supply_payment','wb_payout')),
  source_id     uuid,
  created_by    uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  -- перевод: обязателен второй счёт (другой) и без статьи; приход/расход — наоборот
  constraint cash_tx_transfer_shape check (
    (kind = 'transfer' and to_account_id is not null and to_account_id <> account_id
       and category_id is null)
    or (kind <> 'transfer' and to_account_id is null)
  )
);

------------------------------------------------------------------------------
-- Триггеры и индексы
------------------------------------------------------------------------------

create trigger trg_cash_accounts_updated_at
  before update on cash_accounts
  for each row execute function set_updated_at();

create index idx_cash_accounts_org     on cash_accounts (org_id) where not archived;
create index idx_expense_categories_org on expense_categories (org_id) where not archived;
create index idx_cash_tx_org_date      on cash_tx (org_id, occurred_on desc);
create index idx_cash_tx_account       on cash_tx (account_id);
create index idx_cash_tx_to_account    on cash_tx (to_account_id) where to_account_id is not null;
create index idx_cash_tx_category      on cash_tx (category_id);
-- одна оплата поставки → максимум одна операция кассы (защита от дублей)
create unique index uq_cash_tx_source on cash_tx (source, source_id)
  where source_id is not null;

------------------------------------------------------------------------------
-- RLS (зеркалит 0009: читают члены org, пишут owner/admin/manager)
------------------------------------------------------------------------------

alter table cash_accounts      enable row level security;
alter table expense_categories enable row level security;
alter table cash_tx            enable row level security;

create policy "cash_accounts: read own org" on cash_accounts
  for select using (org_id in (select auth_org_ids()));
create policy "cash_accounts: managers write" on cash_accounts
  for all using (auth_role(org_id) in ('owner','admin','manager'))
  with check (auth_role(org_id) in ('owner','admin','manager'));

create policy "expense_categories: read own org" on expense_categories
  for select using (org_id in (select auth_org_ids()));
create policy "expense_categories: managers write" on expense_categories
  for all using (auth_role(org_id) in ('owner','admin','manager'))
  with check (auth_role(org_id) in ('owner','admin','manager'));

create policy "cash_tx: read own org" on cash_tx
  for select using (org_id in (select auth_org_ids()));
create policy "cash_tx: managers write" on cash_tx
  for all using (auth_role(org_id) in ('owner','admin','manager'))
  with check (auth_role(org_id) in ('owner','admin','manager'));

------------------------------------------------------------------------------
-- Стартовый справочник для каждой существующей организации (идемпотентно).
-- Названия — как их произносят в команде, чтобы ИИ и бот угадывали статью.
------------------------------------------------------------------------------

insert into cash_accounts (org_id, name, kind, currency, sort_order)
select o.id, a.name, a.kind, a.currency, a.sort_order
from orgs o
cross join (values
  ('Наличные',        'cash', 'rub',  10),
  ('Расчётный счёт',  'bank', 'rub',  20),
  ('Карта',           'card', 'rub',  30),
  ('Юани (карго)',    'other','cny',  40)
) as a(name, kind, currency, sort_order)
on conflict (org_id, name) do nothing;

insert into expense_categories (org_id, name, direction, in_pnl, emoji, sort_order)
select o.id, c.name, c.direction, c.in_pnl, c.emoji, c.sort_order
from orgs o
cross join (values
  -- расходы, влияющие на прибыль периода
  ('Реклама WB',          'out', true,  '📣', 10),
  ('Зарплата',            'out', true,  '👥', 20),
  ('Логистика WB',        'out', true,  '🚚', 30),
  ('Хранение WB',         'out', true,  '🏬', 40),
  ('Штрафы WB',           'out', true,  '⚠️', 50),
  ('Карго и доставка',    'out', true,  '✈️', 60),
  ('Фото и дизайн',       'out', true,  '🎨', 70),
  ('Налоги',              'out', true,  '🧾', 80),
  ('Сервисы и подписки',  'out', true,  '💻', 90),
  ('Аренда',              'out', true,  '🏢', 100),
  ('Прочие расходы',      'out', true,  '▪️', 110),
  -- движение активов: в прибыль периода не входит
  ('Закуп товара',        'out', false, '📦', 120),
  ('Выплата владельцу',   'out', false, '🏦', 130),
  -- приходы
  ('Поступление от WB',   'in',  false, '💰', 10),
  ('Пополнение владельцем','in', false, '➕', 20),
  ('Прочий доход',        'in',  true,  '✨', 30)
) as c(name, direction, in_pnl, emoji, sort_order)
on conflict (org_id, name) do nothing;

------------------------------------------------------------------------------
-- Агрегаты чтения (PostgREST режет ответы до 1000 строк — считаем в Postgres)
------------------------------------------------------------------------------

-- Остатки по счетам: стартовый остаток + приходы − расходы ± переводы.
-- Сумма в валюте счёта (в рубли пересчитывает TS по общему курсу).
create or replace function agg_cash_balances(p_org uuid)
returns table(
  account_id uuid, name text, kind text, currency text,
  balance numeric, tx_count bigint, last_tx date
)
language sql stable as $$
  select
    a.id, a.name, a.kind, a.currency,
    a.opening_balance
      + coalesce(sum(case
          when t.kind = 'in'                       then t.amount
          when t.kind in ('out','transfer')
               and t.account_id = a.id             then -t.amount
          else 0 end), 0)
      + coalesce(sum(case
          when t.kind = 'transfer' and t.to_account_id = a.id
            then coalesce(t.amount_to, t.amount)
          else 0 end), 0),
    count(t.id) filter (where t.id is not null),
    max(t.occurred_on)
  from cash_accounts a
  left join cash_tx t
    on t.org_id = a.org_id
   and (t.account_id = a.id or t.to_account_id = a.id)
  where a.org_id = p_org and not a.archived
  group by a.id, a.name, a.kind, a.currency, a.opening_balance, a.sort_order
  order by a.sort_order, a.name;
$$;

-- Движение денег по месяцам (ДДС): пришло / ушло, ₽. Переводы не считаем —
-- они не меняют общий объём денег компании.
create or replace function agg_cash_flow_monthly(p_org uuid, p_since date)
returns table(month date, in_rub numeric, out_rub numeric)
language sql stable as $$
  select
    date_trunc('month', occurred_on)::date,
    coalesce(sum(amount_rub) filter (where kind = 'in'), 0),
    coalesce(sum(amount_rub) filter (where kind = 'out'), 0)
  from cash_tx
  where org_id = p_org and occurred_on >= p_since and kind <> 'transfer'
  group by 1 order by 1;
$$;

-- Расходы по статьям за период (для круга «на что уходят деньги»)
create or replace function agg_expenses_by_category(p_org uuid, p_from date, p_to date)
returns table(
  category_id uuid, name text, emoji text, in_pnl boolean,
  amount_rub numeric, tx_count bigint
)
language sql stable as $$
  select
    c.id, coalesce(c.name, 'Без статьи'), c.emoji, coalesce(c.in_pnl, true),
    coalesce(sum(t.amount_rub), 0), count(t.id)
  from cash_tx t
  left join expense_categories c on c.id = t.category_id
  where t.org_id = p_org and t.kind = 'out'
    and t.occurred_on between p_from and p_to
  group by c.id, c.name, c.emoji, c.in_pnl
  order by 5 desc;
$$;

-- Расходы по месяцам: всего и та часть, что влияет на прибыль (in_pnl)
create or replace function agg_expenses_monthly(p_org uuid, p_since date)
returns table(month date, opex_rub numeric, total_rub numeric)
language sql stable as $$
  select
    date_trunc('month', t.occurred_on)::date,
    coalesce(sum(t.amount_rub) filter (where coalesce(c.in_pnl, true)), 0),
    coalesce(sum(t.amount_rub), 0)
  from cash_tx t
  left join expense_categories c on c.id = t.category_id
  where t.org_id = p_org and t.kind = 'out' and t.occurred_on >= p_since
  group by 1 order by 1;
$$;

-- Прочие доходы по месяцам (только те, что влияют на прибыль)
create or replace function agg_other_income_monthly(p_org uuid, p_since date)
returns table(month date, income_rub numeric)
language sql stable as $$
  select
    date_trunc('month', t.occurred_on)::date,
    coalesce(sum(t.amount_rub), 0)
  from cash_tx t
  join expense_categories c on c.id = t.category_id
  where t.org_id = p_org and t.kind = 'in' and c.in_pnl
    and t.occurred_on >= p_since
  group by 1 order by 1;
$$;

-- Продажи по месяцам: выручка (цена со скидкой) и «к перечислению» от WB.
-- Возвраты вычитаются. Разница выручка − к перечислению = удержания WB.
create or replace function agg_sales_monthly(p_store uuid, p_since timestamptz)
returns table(month date, qty bigint, revenue_rub numeric, for_pay_rub numeric)
language sql stable as $$
  select
    date_trunc('month', sale_date)::date,
    count(*) filter (where not coalesce(is_return, false))
      - count(*) filter (where coalesce(is_return, false)),
    coalesce(sum(case when coalesce(is_return, false)
                      then -coalesce(price_with_disc, 0)
                      else  coalesce(price_with_disc, 0) end), 0),
    coalesce(sum(case when coalesce(is_return, false)
                      then -coalesce(for_pay, 0)
                      else  coalesce(for_pay, 0) end), 0)
  from raw_sales
  where store_id = p_store and sale_date >= p_since
  group by 1 order by 1;
$$;

-- Себестоимость проданного товара по месяцам (COGS).
-- coverage_qty — сколько продаж имеют заполненную себестоимость: если покрытие
-- низкое, прибыль завышена, и интерфейс обязан об этом предупредить.
create or replace function agg_cogs_monthly(p_store uuid, p_since timestamptz)
returns table(month date, cogs_rub numeric, covered_qty bigint, total_qty bigint)
language sql stable as $$
  select
    date_trunc('month', s.sale_date)::date,
    coalesce(sum(case when coalesce(s.is_return, false)
                      then -coalesce(p.cost_price, 0)
                      else  coalesce(p.cost_price, 0) end), 0),
    count(*) filter (where p.cost_price is not null
                       and not coalesce(s.is_return, false)),
    count(*) filter (where not coalesce(s.is_return, false))
  from raw_sales s
  left join products p on p.nm_id = s.nm_id and p.store_id = s.store_id
  where s.store_id = p_store and s.sale_date >= p_since
  group by 1 order by 1;
$$;

-- Удержания WB из финансового отчёта (если отчёт синхронизирован)
create or replace function agg_wb_fees_monthly(p_store uuid, p_since date)
returns table(
  month date, commission_rub numeric, logistics_rub numeric,
  storage_rub numeric, penalty_rub numeric
)
language sql stable as $$
  select
    date_trunc('month', period_start)::date,
    coalesce(sum(commission), 0), coalesce(sum(logistics), 0),
    coalesce(sum(storage_fee), 0), coalesce(sum(penalty), 0)
  from raw_finance_report
  where store_id = p_store and period_start >= p_since
  group by 1 order by 1;
$$;

-- Расход на внутреннюю рекламу WB по месяцам (если синхронизирован)
create or replace function agg_advert_monthly(p_store uuid, p_since date)
returns table(month date, spend_rub numeric)
language sql stable as $$
  select date_trunc('month', stat_date)::date, coalesce(sum(sum), 0)
  from raw_advert_daily
  where store_id = p_store and stat_date >= p_since
  group by 1 order by 1;
$$;
