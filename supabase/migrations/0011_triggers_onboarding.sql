-- WB CRM · Миграция 0011: триггеры и онбординг (Фаза 1 плана)

------------------------------------------------------------------------------
-- updated_at
------------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_tasks_updated_at
  before update on tasks
  for each row execute function set_updated_at();

create trigger trg_rnp_plans_updated_at
  before update on rnp_plans
  for each row execute function set_updated_at();

create trigger trg_benchmarks_updated_at
  before update on competitor_benchmarks
  for each row execute function set_updated_at();

------------------------------------------------------------------------------
-- Автосоздание профиля при регистрации пользователя Supabase Auth
------------------------------------------------------------------------------

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

------------------------------------------------------------------------------
-- Онбординг: при первом входе создаётся организация + роль owner (Директор).
-- Security definer, т.к. RLS не позволяет вставить org до появления членства.
------------------------------------------------------------------------------

create or replace function create_org_with_owner(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into orgs (name) values (p_name) returning id into v_org;
  insert into org_members (org_id, user_id, role) values (v_org, auth.uid(), 'owner');

  insert into audit_log (org_id, actor_id, action, target)
  values (v_org, auth.uid(), 'org.create', v_org::text);

  return v_org;
end;
$$;

------------------------------------------------------------------------------
-- Принятие приглашения по токену (экран «Команда», Фаза 1)
------------------------------------------------------------------------------

create or replace function accept_invite(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_invite invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_invite
  from invites
  where token = p_token and accepted_at is null and expires_at > now();

  if not found then
    raise exception 'invite not found or expired';
  end if;

  insert into org_members (org_id, user_id, role)
  values (v_invite.org_id, auth.uid(), v_invite.role)
  on conflict (org_id, user_id) do update set role = excluded.role;

  update invites set accepted_at = now() where id = v_invite.id;

  insert into audit_log (org_id, actor_id, action, target, meta)
  values (v_invite.org_id, auth.uid(), 'invite.accept', v_invite.email,
          jsonb_build_object('role', v_invite.role));

  return v_invite.org_id;
end;
$$;
