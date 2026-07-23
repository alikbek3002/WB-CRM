-- WB CRM · Миграция 0001: расширения Postgres
-- Применяется на Supabase (Postgres 15+). pgcrypto — для gen_random_uuid().
-- pg_cron / pgmq / supabase_vault доступны в Supabase Cloud; на локальном
-- Postgres их может не быть, поэтому создание обёрнуто в guard-блоки.

create extension if not exists pgcrypto;

do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron недоступен в этом окружении, пропускаем (нужен для расписания синка, раздел 8 плана)';
end $$;

do $$
begin
  create extension if not exists pgmq;
exception when others then
  raise notice 'pgmq недоступен в этом окружении, пропускаем (нужен для очередей синка, раздел 8 плана)';
end $$;

do $$
begin
  create extension if not exists supabase_vault;
exception when others then
  raise notice 'supabase_vault недоступен в этом окружении, пропускаем (шифрование секретов, раздел 13 плана)';
end $$;
