-- =============================================================================
-- TACTICAL COMMAND — 002_rls_hardening.sql
-- Fase 2: dono de sala REAL (auth.uid()), RLS fechada, e-mail fora do estado público.
-- Mantém a "entrada rápida" de soldados: eles usam LOGIN ANÔNIMO do Supabase
-- (supabase.auth.signInAnonymously()) — zero formulário, mas cada aparelho ganha um
-- auth.uid() estável, que é a base de toda a autorização abaixo.
--
-- PRÉ-REQUISITOS
--   1. Painel Supabase > Authentication > Sign In / Providers > "Allow anonymous sign-ins" = ON
--      (recomendado: ativar também CAPTCHA/Turnstile para limitar abuso de logins anônimos)
--   2. Rodar ANTES o 001_rpc_atomico.sql
--   3. Publicar o app novo (que usa as RPCs e o login anônimo) ANTES de rodar este arquivo:
--      depois dele, escrita direta na tabela deixa de existir e versões antigas do PWA
--      ficam somente-leitura.
--   4. Promover o administrador (UMA vez, no SQL Editor — nunca pelo front-end):
--        insert into public.app_admins(uid, note)
--        select id, 'admin master' from auth.users where email = 'SEU_EMAIL_AQUI'
--        on conflict do nothing;
--
-- Idempotente.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Tabelas privadas (RLS ligada e SEM policy = invisíveis para o cliente)
-- ---------------------------------------------------------------------------
create table if not exists public.tactical_session_owners (
  code        text primary key references public.tactical_sessions(code) on delete cascade,
  owner_uid   uuid,                       -- null = sala legada ainda não reivindicada
  owner_email text,
  owner_name  text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_tso_owner_uid on public.tactical_session_owners (owner_uid);
alter table public.tactical_session_owners enable row level security;

create table if not exists public.app_admins (
  uid  uuid primary key,
  note text
);
alter table public.app_admins enable row level security;

-- ---------------------------------------------------------------------------
-- 2) Backfill dos donos a partir dos dados legados e REMOÇÃO do e-mail do estado
-- ---------------------------------------------------------------------------
insert into public.tactical_session_owners (code, owner_uid, owner_email, owner_name)
select s.code,
       u.id,
       coalesce(s.owner_email, s.state #>> '{roomMeta,ownerEmail}'),
       coalesce(s.owner_name,  s.state #>> '{roomMeta,ownerName}')
  from public.tactical_sessions s
  left join auth.users u
    on lower(u.email) = lower(coalesce(s.owner_email, s.state #>> '{roomMeta,ownerEmail}'))
on conflict (code) do nothing;

update public.tactical_sessions
   set owner_email = null,
       state = state #- '{roomMeta,ownerEmail}'
 where owner_email is not null or state #> '{roomMeta,ownerEmail}' is not null;

-- ---------------------------------------------------------------------------
-- 3) Ganchos de autorização reais (substituem os permissivos do 001)
-- ---------------------------------------------------------------------------
create or replace function public._current_uid()
returns text language sql stable as $$ select (select auth.uid())::text $$;

create or replace function public._is_owner(p_code text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select auth.uid()) is not null
    and (
      exists (select 1 from public.tactical_session_owners o
               where o.code = p_code and o.owner_uid = (select auth.uid()))
      or exists (select 1 from public.app_admins a where a.uid = (select auth.uid()))
    ), false)
$$;

create or replace function public._can_host_write(p_code text, p_device_id text)
returns boolean language sql stable as $$ select public._is_owner(p_code) $$;

-- Juiz/Admin mexe em qualquer soldado; Player só no PRÓPRIO (ownerUid == auth.uid()).
-- Soldado legado sem ownerUid fica livre até o dono reentrar (rpc_enlist_soldier carimba).
create or replace function public._can_write_soldier(p_code text, p_role text, p_soldier jsonb)
returns boolean
language sql stable
as $$
  select public._is_owner(p_code)
      or (p_role = 'PLAYER'
          and (p_soldier->>'ownerUid' is null
               or p_soldier->>'ownerUid' = (select auth.uid())::text))
$$;

-- ---------------------------------------------------------------------------
-- 4) Ciclo de vida da sala (só usuário LOGADO de verdade, não anônimo)
-- ---------------------------------------------------------------------------
create or replace function public.rpc_create_room(
  p_code text,
  p_state jsonb,
  p_device_id text default null,
  p_owner_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_anon boolean := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_name text := left(coalesce(nullif(btrim(p_owner_name), ''), 'COMANDANTE'), 40);
  v_state jsonb;
begin
  if v_uid is null or v_anon then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if v_code !~ '^[A-Z0-9_-]{3,16}$' then
    raise exception 'invalid_code' using errcode = '22023';
  end if;
  if not exists (select 1 from public.app_admins where uid = v_uid)
     and (select count(*) from public.tactical_session_owners where owner_uid = v_uid) >= 20 then
    raise exception 'too_many_rooms' using errcode = '53400';
  end if;

  v_state := (coalesce(p_state, '{}'::jsonb) - 'roomMeta' - 'lastMutationBy' - 'lastMutationRole')
             || jsonb_build_object(
                  'roomMeta', jsonb_build_object(
                    'ownerName', v_name, 'ownerDeviceId', p_device_id, 'isOnline', true),
                  'lastMutationBy', p_device_id,
                  'lastMutationRole', 'HOST',
                  'updatedAtMs', public._now_ms());

  begin
    insert into public.tactical_sessions (code, host_id, is_online, state)
    values (v_code, coalesce(p_device_id, '?'), true, v_state);
  exception when unique_violation then
    raise exception 'code_taken' using errcode = '23505';
  end;

  insert into public.tactical_session_owners (code, owner_uid, owner_email, owner_name)
  values (v_code, v_uid, auth.jwt() ->> 'email', v_name);

  return v_state;
end $$;

create or replace function public.rpc_delete_room(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public._is_owner(p_code) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.tactical_sessions where code = p_code;
  return found;
end $$;

-- Reivindica sala legada: o e-mail confirmado do JWT precisa bater com o e-mail guardado
create or replace function public.rpc_claim_legacy_room(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_anon boolean := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
begin
  if v_uid is null or v_anon then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  update public.tactical_session_owners
     set owner_uid = v_uid
   where code = p_code
     and owner_uid is null
     and lower(owner_email) = lower(auth.jwt() ->> 'email');
  return found;
end $$;

create or replace function public.rpc_my_rooms()
returns table (code text, is_online boolean, soldiers_count int, matches_count int, updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select s.code,
         s.is_online,
         jsonb_array_length(coalesce(s.state->'soldiers', '[]'::jsonb)),
         coalesce((s.state #>> '{stats,totalMatches}')::int, 0),
         s.updated_at
    from public.tactical_sessions s
   where (select auth.uid()) is not null
     and (exists (select 1 from public.tactical_session_owners o
                   where o.code = s.code and o.owner_uid = (select auth.uid()))
          or exists (select 1 from public.app_admins a where a.uid = (select auth.uid())))
   order by s.updated_at desc
$$;

-- Lista leve das salas abertas (substitui baixar 20 estados completos no boot)
create or replace function public.rpc_open_rooms()
returns table (code text, owner_name text, soldiers_count int, matches_count int)
language sql
stable
security definer
set search_path = public
as $$
  select s.code,
         coalesce(s.state #>> '{roomMeta,ownerName}', 'COMANDANTE'),
         jsonb_array_length(coalesce(s.state->'soldiers', '[]'::jsonb)),
         coalesce((s.state #>> '{stats,totalMatches}')::int, 0)
    from public.tactical_sessions s
   where s.is_online
   order by s.updated_at desc
   limit 20
$$;

-- Quem sou eu? (o front usa só para EXIBIR a UI de admin; a autorização real é sempre no servidor)
create or replace function public.rpc_whoami()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'uid', (select auth.uid()),
    'is_anonymous', coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false),
    'email', auth.jwt() ->> 'email',
    'is_admin', exists (select 1 from public.app_admins a where a.uid = (select auth.uid()))
  )
$$;

-- ---------------------------------------------------------------------------
-- 5) RLS: leitura só para quem tem sessão (inclui anônimos), nenhuma escrita direta
-- ---------------------------------------------------------------------------
drop policy if exists "Acesso publico total MVP" on public.tactical_sessions;
drop policy if exists "Permitir leitura publica de sessoes" on public.tactical_sessions;
drop policy if exists "Permitir criacao publica de sessoes" on public.tactical_sessions;
drop policy if exists "Permitir atualizacao publica de sessoes" on public.tactical_sessions;
drop policy if exists sessions_read_authenticated on public.tactical_sessions;

create policy sessions_read_authenticated
  on public.tactical_sessions for select to authenticated using (true);

revoke all on public.tactical_sessions from anon;
revoke insert, update, delete, truncate, references, trigger on public.tactical_sessions from authenticated;
grant select on public.tactical_sessions to authenticated;

revoke all on public.tactical_session_owners from anon, authenticated;
revoke all on public.app_admins from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) Execução das RPCs: só "authenticated" (login anônimo conta). anon = nada.
-- ---------------------------------------------------------------------------
revoke all on function public.rpc_set_soldier_alive(text, text, boolean, text, text) from public, anon;
revoke all on function public.rpc_enlist_soldier(text, jsonb, text) from public, anon;
revoke all on function public.rpc_host_patch(text, jsonb, text, boolean) from public, anon;
revoke all on function public.rpc_host_sync_roster(text, jsonb, jsonb, boolean, text) from public, anon;
revoke all on function public.server_now_ms() from public, anon;
revoke all on function public.rpc_create_room(text, jsonb, text, text) from public, anon;
revoke all on function public.rpc_delete_room(text) from public, anon;
revoke all on function public.rpc_claim_legacy_room(text) from public, anon;
revoke all on function public.rpc_my_rooms() from public, anon;
revoke all on function public.rpc_open_rooms() from public, anon;
revoke all on function public.rpc_whoami() from public, anon;
revoke all on function public._is_owner(text) from public, anon, authenticated;
revoke all on function public._can_host_write(text, text) from public, anon, authenticated;
revoke all on function public._can_write_soldier(text, text, jsonb) from public, anon, authenticated;
revoke all on function public._current_uid() from public, anon, authenticated;
revoke all on function public._recount_alive(jsonb) from public, anon, authenticated;
revoke all on function public._now_ms() from public, anon, authenticated;

grant execute on function public.rpc_set_soldier_alive(text, text, boolean, text, text) to authenticated;
grant execute on function public.rpc_enlist_soldier(text, jsonb, text) to authenticated;
grant execute on function public.rpc_host_patch(text, jsonb, text, boolean) to authenticated;
grant execute on function public.rpc_host_sync_roster(text, jsonb, jsonb, boolean, text) to authenticated;
grant execute on function public.server_now_ms() to authenticated;
grant execute on function public.rpc_create_room(text, jsonb, text, text) to authenticated;
grant execute on function public.rpc_delete_room(text) to authenticated;
grant execute on function public.rpc_claim_legacy_room(text) to authenticated;
grant execute on function public.rpc_my_rooms() to authenticated;
grant execute on function public.rpc_open_rooms() to authenticated;
grant execute on function public.rpc_whoami() to authenticated;
