-- ─────────────────────────────────────────────────────────────────────────────
-- 0017: Регламент сотрудников (из документов «Вопросы и отзывы» + «Контент»).
--   duty_templates   — справочник обязанностей: кому (роль или конкретный
--                      сотрудник), как часто (ежедневно/еженедельно), дедлайн
--                      в течение дня и сколько часов даётся на выполнение.
--   duty_assignments — экземпляры «задача на день» (генерируются каждый день).
--   duty_reports     — отчёты о выполнении (видят директор и ст. менеджер).
-- ─────────────────────────────────────────────────────────────────────────────

create table duty_templates (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  code              text not null,               -- стабильный ключ (идемпотентный сид)
  title             text not null,
  description       text,                        -- выжимка регламента / чеклист
  role              text not null,               -- member_role: кому по умолчанию
  assignee_user_id  uuid references profiles(id) on delete set null, -- конкретный сотрудник (приоритетнее роли)
  frequency         text not null default 'daily' check (frequency in ('daily','weekly')),
  weekday           smallint,                    -- 1=пн … 7=вс (для weekly)
  due_time          time not null default '18:00', -- дедлайн в течение дня
  hours_to_complete smallint not null default 3, -- сколько часов даётся
  requires_report   boolean not null default true,
  sort_order        integer not null default 100,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (org_id, code)
);

create table duty_assignments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  template_id  uuid not null references duty_templates(id) on delete cascade,
  assignee_id  uuid not null references profiles(id) on delete cascade,
  task_date    date not null,
  due_at       timestamptz not null,
  status       text not null default 'pending' check (status in ('pending','done','missed')),
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (template_id, assignee_id, task_date)
);

create table duty_reports (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  assignment_id uuid not null references duty_assignments(id) on delete cascade,
  user_id       uuid not null references profiles(id) on delete cascade,
  content       text not null,                  -- текст отчёта менеджера
  on_time       boolean not null default true,  -- сдан до дедлайна
  created_at    timestamptz not null default now(),
  unique (assignment_id)
);

create index idx_duty_assignments_day on duty_assignments (org_id, task_date desc, status);
create index idx_duty_assignments_user on duty_assignments (assignee_id, task_date desc);
create index idx_duty_reports_day on duty_reports (org_id, created_at desc);

-- RLS по паттерну 0009: чтение — участники организации, запись — owner/admin/manager
alter table duty_templates enable row level security;
alter table duty_assignments enable row level security;
alter table duty_reports enable row level security;

create policy duty_templates_read on duty_templates
  for select using (org_id in (select auth_org_ids()));
create policy duty_templates_write on duty_templates
  for all using (auth_role(org_id) in ('owner','admin'));

create policy duty_assignments_read on duty_assignments
  for select using (org_id in (select auth_org_ids()));
create policy duty_assignments_write on duty_assignments
  for all using (auth_role(org_id) in ('owner','admin','manager'));

create policy duty_reports_read on duty_reports
  for select using (org_id in (select auth_org_ids()));
create policy duty_reports_write on duty_reports
  for all using (auth_role(org_id) in ('owner','admin','manager'));
