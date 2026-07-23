-- WB CRM · Миграция 0012: email в профиле (для экрана «Команда»)
-- profiles не хранил email (он в auth.users, недоступной через API). Добавляем
-- колонку и заполняем из auth.users; триггер handle_new_user тоже пишет email.

alter table profiles add column if not exists email text;

-- Бэкфилл для уже существующих профилей
update profiles p
set email = u.email
from auth.users u
where u.id = p.id and p.email is null;

-- Обновлённый триггер: при регистрации сохраняем и email, и имя
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    new.email
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(profiles.full_name, excluded.full_name);
  return new;
end;
$$;
