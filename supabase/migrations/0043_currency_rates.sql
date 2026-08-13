-- ─────────────────────────────────────────────────────────────────────────────
-- 0043: Курсы валют и одна базовая валюта на всю систему — СОМ.
--
--   ЧТО БЫЛО НЕ ТАК. Базовой валютой сводок считался рубль, а курсы жили в
--   константе кода (src/shared/constants.ts: cny 12,5 / uzs 0,0068 / kgs 0,93).
--   При этом кабинет WB киргизского юрлица считает В СОМАХ:
--     select currency_name, count(*) from raw_finance_report → KGS, 619 552
--     select currency from wb_balance                        → KGS
--   Выручка, комиссии, логистика и реклама лежат в *_rub уже сомами, а касса
--   пересчитывалась «в рубли»: у всех выплат WB rate_to_rub = 0,93, поэтому
--   amount_rub был на 7% меньше реально пришедших сомов. В ОПиУ выручка (сомы)
--   складывалась с расходами (рубли) — сравнивать такие числа нельзя.
--
--   ЧТО ДЕЛАЕМ. Базовая валюта = сом. Курс каждой валюты к сому хранится в БД и
--   правится руками (директор и старший менеджер, право currency:manage,
--   вкладка «Финансы → Валюты»). Добавляем доллар: фабрики и карго всё чаще
--   считают в USD, а выбрать его было негде.
--
--   Имена *_rub / rate_to_rub оставлены умышленно: в WB-агрегатах они и раньше
--   держали сомы, и переименование сотни колонок и полей в двадцати функциях
--   стоило бы дороже, чем договорённость «*_rub = базовая валюта». Ниже это
--   закреплено в comment on column, чтобы следующий читатель не решил, что там
--   рубли, и не вернул конвертацию.
-- ─────────────────────────────────────────────────────────────────────────────

------------------------------------------------------------------------------
-- currency_rates — сколько сомов стоит одна единица валюты
--   Один курс на валюту (не история): бухгалтерия ведётся «по текущему курсу»,
--   а курс сделки, где он важен, фиксируется на самой операции
--   (cash_tx.rate_to_rub, supplies.cargo_rate_to_rub, supply_items.sewing_rate_to_rub).
--   updated_by = null → курс ещё не сводили руками, стоит наш ориентир.
------------------------------------------------------------------------------

create table if not exists currency_rates (
  org_id      uuid not null references orgs(id) on delete cascade,
  code        text not null check (code in ('kgs','usd','rub','cny','uzs')),
  rate_to_kgs numeric(14,6) not null check (rate_to_kgs > 0),
  updated_by  uuid references profiles(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (org_id, code),
  -- сом к сому — всегда 1: иначе одна опечатка перекосит все суммы разом
  constraint currency_rates_base_is_one check (code <> 'kgs' or rate_to_kgs = 1)
);

comment on table currency_rates is
  'Курс валюты к сому (базовая валюта компании). Правят директор и ст. менеджер.';
comment on column currency_rates.rate_to_kgs is 'Сколько сомов стоит 1 единица валюты';
comment on column currency_rates.updated_by is 'null — курс не сводили руками, стоит дефолт';

drop trigger if exists trg_currency_rates_updated_at on currency_rates;
create trigger trg_currency_rates_updated_at
  before update on currency_rates
  for each row execute function set_updated_at();

-- Ориентиры на август 2026. Реальные значения задаются в интерфейсе.
insert into currency_rates (org_id, code, rate_to_kgs)
select o.id, r.code, r.rate
from orgs o
cross join (values
  ('kgs', 1::numeric),
  ('usd', 87.5::numeric),
  ('rub', 1.1::numeric),
  ('cny', 12.2::numeric),
  ('uzs', 0.0069::numeric)
) as r(code, rate)
on conflict (org_id, code) do nothing;

alter table currency_rates enable row level security;

-- Чтение — своя организация; пишет сервисный слой (service_role обходит RLS),
-- право currency:manage проверяется в приложении (backend/data/currency-core.ts).
drop policy if exists "currency_rates: read own org" on currency_rates;
create policy "currency_rates: read own org" on currency_rates
  for select using (org_id in (select auth_org_ids()));

------------------------------------------------------------------------------
-- Доллар (и сом, где его не было) во всех денежных таблицах
------------------------------------------------------------------------------

alter table cash_accounts drop constraint if exists cash_accounts_currency_check;
alter table cash_accounts add constraint cash_accounts_currency_check
  check (currency in ('kgs','usd','rub','cny','uzs'));

alter table cash_tx drop constraint if exists cash_tx_currency_check;
alter table cash_tx add constraint cash_tx_currency_check
  check (currency in ('kgs','usd','rub','cny','uzs'));

alter table payout_requests drop constraint if exists payout_requests_currency_check;
alter table payout_requests add constraint payout_requests_currency_check
  check (currency in ('kgs','usd','rub','cny','uzs'));

alter table supplies drop constraint if exists supplies_sewing_currency_check;
alter table supplies add constraint supplies_sewing_currency_check
  check (sewing_currency in ('kgs','usd','rub','cny','uzs'));

alter table supplies drop constraint if exists supplies_cargo_currency_check;
alter table supplies add constraint supplies_cargo_currency_check
  check (cargo_currency in ('kgs','usd','rub','cny','uzs'));

alter table supply_items drop constraint if exists supply_items_sewing_currency_check;
alter table supply_items add constraint supply_items_sewing_currency_check
  check (sewing_currency in ('kgs','usd','rub','cny','uzs'));

alter table supply_payments drop constraint if exists supply_payments_currency_check;
alter table supply_payments add constraint supply_payments_currency_check
  check (currency in ('kgs','usd','rub','cny','uzs'));

-- Заявку на выплату по умолчанию заводим в своей валюте, а не в рублях
alter table payout_requests alter column currency set default 'kgs';

------------------------------------------------------------------------------
-- factories.currency — в чём фабрика выставляет счёт
--   Раньше валюту угадывали по стране (Китай → юань, Узбекистан → сум), из-за
--   чего китайская фабрика со счётами в долларах заводилась «в юанях» и
--   себестоимость партии врала в разы. Теперь это свойство фабрики: карточка
--   поставки подставляет её валюту в отшив и карго.
------------------------------------------------------------------------------

alter table factories
  add column if not exists currency text not null default 'cny'
    check (currency in ('kgs','usd','rub','cny','uzs'));

update factories set currency = 'uzs' where country = 'uzbekistan' and currency = 'cny';

comment on column factories.currency is 'Валюта расчётов с фабрикой (подставляется в поставку)';

------------------------------------------------------------------------------
-- Смысл денежных колонок: *_rub — это БАЗОВАЯ валюта, то есть сом
------------------------------------------------------------------------------

comment on column cash_tx.rate_to_rub is
  'Курс валюты операции к базовой валюте (сому) на дату операции; kgs → 1';
comment on column cash_tx.amount_rub is
  'Сумма в базовой валюте (сомах) = amount × rate_to_rub. Имя историческое.';
comment on column supplies.cargo_rate_to_rub is
  'Курс валюты карго к сому, зафиксированный при заведении поставки';
comment on column supply_items.sewing_rate_to_rub is
  'Курс валюты отшива к сому, зафиксированный при заведении позиции';

------------------------------------------------------------------------------
-- Пересчёт уже записанных операций кассы под базу «сом»
--   Сомовые операции (все выплаты WB) шли с курсом 0,93 — теперь 1: касса и
--   ОПиУ перестают занижать деньги от маркетплейса на 7%.
------------------------------------------------------------------------------

update cash_tx set rate_to_rub = 1
where currency = 'kgs' and rate_to_rub <> 1;

-- Прочие валюты: записанный курс был «к рублю» и под базу «сом» неверен.
-- Исторических курсов к сому нет — ставим текущий. На момент миграции таких
-- операций в базе нет (все 12 записей — выплаты WB в сомах).
update cash_tx t set rate_to_rub = r.rate_to_kgs
from currency_rates r
where r.org_id = t.org_id and r.code = t.currency and t.currency <> 'kgs';
