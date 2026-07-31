-- ─────────────────────────────────────────────────────────────────────────────
-- 0029: Заявки на выплату — деньги ходят по одному маршруту и оставляют след.
--
--   Как в жизни: менеджер просит оплатить подрядчика, дизайнер — гонорар,
--   закупщик — счёт фабрики. Сейчас это живёт в переписке, а в CRM попадает
--   (в лучшем случае) уже фактом расхода. Теперь весь путь фиксируется:
--     запросил → руководитель согласовал (или отклонил) → оплатили.
--   Оплата не «ещё одна кнопка», а та же операция кассы: заявка при оплате
--   создаёт cash_tx (или оплату поставки, если привязана к фабрике), поэтому
--   остаток денег и ОПиУ сходятся сами собой.
--
--   Плюс встречное направление: деньги от WB. Отчёт о реализации знает, сколько
--   маркетплейс перечислит за период, — заводим это приходом автоматически
--   (source = 'wb_payout'), чтобы касса не набивалась руками.
-- ─────────────────────────────────────────────────────────────────────────────

------------------------------------------------------------------------------
-- Валюта кабинета. У киргизского юрлица WB считает в сомах, значит и счёт для
-- поступлений от WB должен быть в сомах.
------------------------------------------------------------------------------

alter table cash_accounts drop constraint if exists cash_accounts_currency_check;
alter table cash_accounts add constraint cash_accounts_currency_check
  check (currency in ('rub','cny','uzs','kgs'));

alter table cash_tx drop constraint if exists cash_tx_currency_check;
alter table cash_tx add constraint cash_tx_currency_check
  check (currency in ('rub','cny','uzs','kgs'));

------------------------------------------------------------------------------
-- Источник операции кассы. source_ref — внешний идентификатор НЕ-uuid формы
-- (номер отчёта WB, id заявки), по нему держим защиту от повторной записи.
------------------------------------------------------------------------------

alter table cash_tx add column if not exists source_ref text;

alter table cash_tx drop constraint if exists cash_tx_source_check;
alter table cash_tx add constraint cash_tx_source_check
  check (source in ('manual','bot','ai','supply_payment','wb_payout','payout'));

create unique index if not exists uq_cash_tx_source_ref on cash_tx (source, source_ref)
  where source_ref is not null;

------------------------------------------------------------------------------
-- payout_requests — заявка на выплату
--   kind: salary — зарплата/аванс, contractor — подрядчик и разовые работы,
--         factory — счёт фабрики (обычно с привязкой к поставке),
--         reimbursement — вернуть сотруднику потраченное, other — прочее.
--   Статусы: pending → approved → paid; rejected — отказ; cancelled — снял сам.
------------------------------------------------------------------------------

create table payout_requests (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  kind         text not null default 'contractor'
                 check (kind in ('salary','contractor','factory','reimbursement','other')),
  status       text not null default 'pending'
                 check (status in ('pending','approved','rejected','paid','cancelled')),
  -- кто просит и за что
  requester_id uuid not null references profiles(id) on delete cascade,
  payee        text,                                   -- кому платим, если не сам заявитель
  title        text not null,                          -- за что (коротко)
  description  text,                                   -- подробности, номер счёта
  amount       numeric(14,2) not null check (amount > 0),
  currency     text not null default 'rub' check (currency in ('rub','cny','uzs','kgs')),
  due_date     date,                                   -- когда нужно оплатить
  -- к чему относится
  category_id  uuid references expense_categories(id) on delete set null,
  factory_id   uuid references factories(id) on delete set null,
  supply_id    uuid references supplies(id) on delete set null,
  -- решение
  decided_by   uuid references profiles(id) on delete set null,
  decided_at   timestamptz,
  decision_note text,                                  -- причина отказа / комментарий
  -- оплата
  paid_at      timestamptz,
  paid_tx_id   uuid references cash_tx(id) on delete set null,
  paid_account_id uuid references cash_accounts(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger trg_payout_requests_updated_at
  before update on payout_requests
  for each row execute function set_updated_at();

create index idx_payout_requests_org_status on payout_requests (org_id, status, created_at desc);
create index idx_payout_requests_requester  on payout_requests (requester_id, created_at desc);
create index idx_payout_requests_supply     on payout_requests (supply_id) where supply_id is not null;

------------------------------------------------------------------------------
-- RLS: свою заявку видит и создаёт любой сотрудник org; решают руководители.
------------------------------------------------------------------------------

alter table payout_requests enable row level security;

create policy "payout_requests: read own org" on payout_requests
  for select using (org_id in (select auth_org_ids()));

create policy "payout_requests: create own" on payout_requests
  for insert with check (
    org_id in (select auth_org_ids()) and requester_id = auth.uid()
  );

create policy "payout_requests: managers manage" on payout_requests
  for all using (auth_role(org_id) in ('owner','admin','manager'))
  with check (auth_role(org_id) in ('owner','admin','manager'));

------------------------------------------------------------------------------
-- Статьи под выплаты людям (зарплата уже есть в 0024)
------------------------------------------------------------------------------

insert into expense_categories (org_id, name, direction, in_pnl, emoji, sort_order)
select o.id, c.name, c.direction, c.in_pnl, c.emoji, c.sort_order
from orgs o
cross join (values
  ('Подрядчики и услуги', 'out', true, '🧑‍💻', 25),
  ('Возмещение сотруднику', 'out', true, '🧾', 27)
) as c(name, direction, in_pnl, emoji, sort_order)
on conflict (org_id, name) do nothing;

------------------------------------------------------------------------------
-- Что WB должен перечислить по каждому отчёту о реализации.
--   Формула кабинета: к перечислению − логистика − хранение − штрафы −
--   платная приёмка − прочие удержания (+ возмещение логистики).
--   Возвраты уменьшают сумму, поэтому знак задаёт doc_type.
------------------------------------------------------------------------------

create or replace function agg_wb_payouts(p_store uuid, p_since date)
returns table(
  report_id bigint,
  period_start date,
  period_end date,
  currency text,
  payout numeric,
  rows_count bigint
)
language sql stable as $$
  select
    realizationreport_id,
    min(period_start),
    max(period_end),
    max(currency_name),
    coalesce(sum(
      case when doc_type = 'Возврат' then -coalesce(for_pay, 0) else coalesce(for_pay, 0) end
      - coalesce(logistics, 0) + coalesce(rebill_logistic, 0)
      - coalesce(storage_fee, 0) - coalesce(penalty, 0)
      - coalesce(acceptance, 0) - coalesce(deduction, 0)
    ), 0),
    count(*)
  from raw_finance_report
  where store_id = p_store
    and realizationreport_id is not null
    and coalesce(period_end, rr_dt) >= p_since
  group by 1
  having coalesce(sum(
      case when doc_type = 'Возврат' then -coalesce(for_pay, 0) else coalesce(for_pay, 0) end
      - coalesce(logistics, 0) + coalesce(rebill_logistic, 0)
      - coalesce(storage_fee, 0) - coalesce(penalty, 0)
      - coalesce(acceptance, 0) - coalesce(deduction, 0)
    ), 0) <> 0
  order by 2;
$$;
