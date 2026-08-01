-- ─────────────────────────────────────────────────────────────────────────────
-- 0030: Выплаты людям получают адресата.
--
--   Раньше «зарплата 50 000» была обычной строкой расхода: статья «Зарплата»,
--   комментарий «Азизу». Кому и сколько ушло за месяц — считалось глазами по
--   комментариям, а по менеджеру разрез не собрать вообще.
--
--   Теперь у операции кассы есть person_id — сотрудник, которому эти деньги.
--   Заявка на выплату хранит того же адресата (payee_user_id) и переносит его
--   в кассу при оплате, поэтому «выплачено Азизу» одинаково видно и в вебе,
--   и в боте, и у ИИ — считается из одной книги cash_tx, без второго учёта.
-- ─────────────────────────────────────────────────────────────────────────────

------------------------------------------------------------------------------
-- Кому эти деньги. on delete set null — увольнение сотрудника не должно
-- стирать историю расходов компании.
------------------------------------------------------------------------------

alter table cash_tx add column if not exists person_id uuid references profiles(id) on delete set null;

create index if not exists idx_cash_tx_person
  on cash_tx (org_id, person_id, occurred_on desc)
  where person_id is not null;

alter table payout_requests add column if not exists payee_user_id uuid references profiles(id) on delete set null;

create index if not exists idx_payout_requests_payee
  on payout_requests (payee_user_id)
  where payee_user_id is not null;

------------------------------------------------------------------------------
-- Какие статьи — «про людей». Формы показывают выбор сотрудника только для них,
-- иначе в каждой аренде и рекламе висело бы лишнее поле.
------------------------------------------------------------------------------

alter table expense_categories add column if not exists is_payroll boolean not null default false;

insert into expense_categories (org_id, name, direction, in_pnl, emoji, sort_order)
select o.id, c.name, c.direction, c.in_pnl, c.emoji, c.sort_order
from orgs o
cross join (values
  ('Премии и бонусы', 'out', true, '🏅', 26)
) as c(name, direction, in_pnl, emoji, sort_order)
on conflict (org_id, name) do nothing;

update expense_categories
   set is_payroll = true
 where direction = 'out'
   and name in ('Зарплата', 'Премии и бонусы', 'Подрядчики и услуги', 'Возмещение сотруднику');

------------------------------------------------------------------------------
-- Кому сколько выплачено за период. Роль берём из org_members — в отчёте видно
-- не только имя, но и кто это в команде.
------------------------------------------------------------------------------

create or replace function agg_payroll_by_person(p_org uuid, p_from date, p_to date)
returns table(
  person_id  uuid,
  full_name  text,
  role       text,
  amount_rub numeric,
  tx_count   bigint,
  last_paid  date
)
language sql stable as $$
  select
    t.person_id,
    coalesce(p.full_name, '—'),
    m.role::text,
    coalesce(sum(t.amount_rub), 0),
    count(t.id),
    max(t.occurred_on)
  from cash_tx t
  join profiles p on p.id = t.person_id
  left join org_members m on m.user_id = t.person_id and m.org_id = t.org_id
  where t.org_id = p_org
    and t.kind = 'out'
    and t.person_id is not null
    and t.occurred_on between p_from and p_to
  group by t.person_id, p.full_name, m.role
  order by 4 desc;
$$;

-- Разрез «сотрудник × статья»: из чего сложилась сумма (оклад, премия, возмещение)
create or replace function agg_payroll_by_person_category(p_org uuid, p_from date, p_to date)
returns table(
  person_id  uuid,
  category_id uuid,
  name       text,
  emoji      text,
  amount_rub numeric,
  tx_count   bigint
)
language sql stable as $$
  select
    t.person_id,
    c.id,
    coalesce(c.name, 'Без статьи'),
    c.emoji,
    coalesce(sum(t.amount_rub), 0),
    count(t.id)
  from cash_tx t
  left join expense_categories c on c.id = t.category_id
  where t.org_id = p_org
    and t.kind = 'out'
    and t.person_id is not null
    and t.occurred_on between p_from and p_to
  group by t.person_id, c.id, c.name, c.emoji
  order by 5 desc;
$$;

-- Помесячно по сотруднику — для графика «сколько платим человеку»
create or replace function agg_payroll_monthly(p_org uuid, p_since date)
returns table(month date, person_id uuid, amount_rub numeric)
language sql stable as $$
  select
    date_trunc('month', t.occurred_on)::date,
    t.person_id,
    coalesce(sum(t.amount_rub), 0)
  from cash_tx t
  where t.org_id = p_org
    and t.kind = 'out'
    and t.person_id is not null
    and t.occurred_on >= p_since
  group by 1, 2
  order by 1;
$$;
