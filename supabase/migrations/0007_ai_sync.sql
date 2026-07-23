-- WB CRM · Миграция 0007: AI-инсайты и журнал синхронизаций (раздел 4.6 плана)

-- Результаты AI-аналитики (кэш ответов Claude)
create table ai_insights (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  scope        text not null,            -- 'dashboard' | 'rnp_sku' | 'funnel' ...
  scope_ref    text,                     -- напр. nm_id или период
  model        text not null,            -- claude-sonnet-5 / claude-opus-4-8
  prompt_hash  text,                     -- для дедупликации/кэша
  content      jsonb not null,           -- структурированный вывод (summary/problems/recommendations)
  tokens_in    integer,
  tokens_out   integer,
  created_at   timestamptz not null default now()
);

-- Журнал синхронизаций (что, когда, статус)
create table sync_runs (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references stores(id) on delete cascade,
  source        text not null check (source in ('orders','sales','stocks','cards','funnel','advert','finance')),
  status        text not null default 'running' check (status in ('running','success','error')),
  from_date     date,
  to_date       date,
  rows_upserted integer default 0,
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

-- Журнал аудита (раздел 13 плана: доступ к секретам, смена ролей)
create table audit_log (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid references orgs(id) on delete cascade,
  actor_id   uuid references profiles(id) on delete set null,
  action     text not null,              -- 'secret.read' | 'role.change' | 'invite.create' ...
  target     text,                       -- на что направлено действие
  meta       jsonb,
  created_at timestamptz not null default now()
);
