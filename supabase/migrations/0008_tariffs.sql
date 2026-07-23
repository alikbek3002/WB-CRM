-- WB CRM · Миграция 0008: тарифы SaaS (раздел 12 плана)

create table tariffs (
  code              text primary key,        -- 'trial'|'start'|'pro'|'business'
  name              text not null,
  price_month       numeric(10,2) not null,
  max_stores        integer not null,
  max_products      integer,
  ai_tokens_month   integer,                 -- лимит токенов Claude
  sync_interval_min integer,                 -- минимальная частота синка
  features          jsonb                    -- флаги фич
);

insert into tariffs (code, name, price_month, max_stores, max_products, ai_tokens_month, sync_interval_min, features) values
  ('trial',    'Пробный', 0,     1,  50,   100000,  60, '{"ai": true, "telegram": false, "excel_export": false}'),
  ('start',    'Старт',   1990,  1,  200,  500000,  60, '{"ai": true, "telegram": true,  "excel_export": true}'),
  ('pro',      'Про',     4990,  3,  1000, 2000000, 30, '{"ai": true, "telegram": true,  "excel_export": true}'),
  ('business', 'Бизнес',  9990,  10, null, 5000000, 15, '{"ai": true, "telegram": true,  "excel_export": true, "priority_support": true}');

-- Теперь, когда справочник заполнен, привязываем организации к тарифам
alter table orgs
  add constraint orgs_plan_code_fkey
  foreign key (plan_code) references tariffs(code);
