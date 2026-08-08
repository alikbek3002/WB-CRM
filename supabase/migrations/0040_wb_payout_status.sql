-- 0040: статусы выплат WB — «в обработке» и «поступили на счёт».
--
-- Зачем: еженедельный отчёт WB мы сразу заводим приходом в кассу, но фактически
-- деньги доходят до расчётного счёта с задержкой (вывод с баланса кабинета +
-- до 7 рабочих дней банка). Всё это время касса показывала деньги, которых на
-- счёте ещё нет. Теперь выплата рождается «в обработке» (processing) и не
-- участвует в остатках и ДДС, пока руководитель не подтвердит поступление
-- кнопкой в кассе. Момент фактического зачисления WB API не отдаёт (проверено
-- по спеке 2026-08: только баланс кабинета и отчёты реализации, ни платёжных
-- поручений, ни истории выплат) — поэтому подтверждение ручное.
--
-- status: received   — деньги на счёте (все ручные операции и вся история);
--         processing — WB отправил, на счёт ещё не поступило (заводит только
--                      синк wb-payouts, source = 'wb_payout').

alter table cash_tx
  add column if not exists status text not null default 'received';

do $$ begin
  alter table cash_tx
    add constraint cash_tx_status_check check (status in ('processing', 'received'));
exception when duplicate_object then null; end $$;

-- Кто и когда подтвердил поступление — для разбора «а деньги точно дошли?»
alter table cash_tx
  add column if not exists received_at timestamptz,
  add column if not exists received_by uuid references profiles(id) on delete set null;

-- Бэкфилл: выплаты WB последних двух недель почти наверняка ещё в пути —
-- помечаем «в обработке», фактическое поступление подтвердят кнопкой.
-- Более старые давно дошли и остаются received (значение по умолчанию).
update cash_tx
   set status = 'processing'
 where source = 'wb_payout'
   and occurred_on >= current_date - 14;

-- Остатки по счетам: «в обработке» — ещё не деньги. Не входит в остаток,
-- не двигает счётчик операций и дату последней операции.
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
   and t.status <> 'processing'
  where a.org_id = p_org and not a.archived
  group by a.id, a.name, a.kind, a.currency, a.opening_balance, a.sort_order
  order by a.sort_order, a.name;
$$;

-- ДДС по месяцам: приход относится к месяцу фактического поступления денег
-- (при подтверждении occurred_on переставляется на дату зачисления),
-- «в обработке» не считается вовсе.
create or replace function agg_cash_flow_monthly(p_org uuid, p_since date)
returns table(month date, in_rub numeric, out_rub numeric)
language sql stable as $$
  select
    date_trunc('month', occurred_on)::date,
    coalesce(sum(amount_rub) filter (where kind = 'in'), 0),
    coalesce(sum(amount_rub) filter (where kind = 'out'), 0)
  from cash_tx
  where org_id = p_org and occurred_on >= p_since
    and kind <> 'transfer' and status <> 'processing'
  group by 1 order by 1;
$$;
