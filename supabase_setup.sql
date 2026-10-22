-- =============================================================================
-- TACTICAL COMMAND — SUPABASE REALTIME & AUTH SCHEMA (V3.0)
-- Execute este script no "SQL Editor" do seu painel no Supabase (supabase.com)
-- =============================================================================

-- 1. Criação / Atualização da tabela de Sessões Táticas (Salas em Tempo Real)
create table if not exists public.tactical_sessions (
  code text primary key,
  host_id text not null,
  owner_email text,
  owner_name text,
  is_online boolean not null default true,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Caso a tabela já tenha sido criada na versão anterior, garante as colunas novas:
alter table public.tactical_sessions add column if not exists owner_email text;
alter table public.tactical_sessions add column if not exists owner_name text;
alter table public.tactical_sessions add column if not exists is_online boolean not null default true;

-- 2. Índices para buscas rápidas por código e por criador
create index if not exists idx_tactical_sessions_code on public.tactical_sessions (code);
create index if not exists idx_tactical_sessions_owner_email on public.tactical_sessions (owner_email);

-- 3. Habilitar Row Level Security (RLS) com políticas para uso no app
alter table public.tactical_sessions enable row level security;

drop policy if exists "Permitir leitura publica de sessoes" on public.tactical_sessions;
drop policy if exists "Permitir criacao publica de sessoes" on public.tactical_sessions;
drop policy if exists "Permitir atualizacao publica de sessoes" on public.tactical_sessions;
drop policy if exists "Acesso publico total MVP" on public.tactical_sessions;

create policy "Acesso publico total MVP"
  on public.tactical_sessions for all
  using (true)
  with check (true);

-- 4. Habilitar Realtime (WebSockets) para sincronização instantânea entre celulares
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tactical_sessions'
  ) then
    alter publication supabase_realtime add table public.tactical_sessions;
  end if;
end $$;
