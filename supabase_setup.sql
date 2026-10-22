-- =============================================================================
-- TACTICAL COMMAND — SUPABASE REALTIME SCHEMA (PAINTBALL & AIRSOFT)
-- Execute este script no "SQL Editor" do seu painel no Supabase (supabase.com)
-- =============================================================================

-- 1. Criação da tabela de Sessões Táticas (Salas em Tempo Real)
create table if not exists public.tactical_sessions (
  code text primary key,
  host_id text not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- 2. Índice para buscas rápidas por código
create index if not exists idx_tactical_sessions_code on public.tactical_sessions (code);

-- 3. Habilitar Row Level Security (RLS) com acesso público para o MVP (Anon Key)
alter table public.tactical_sessions enable row level security;

drop policy if exists "Permitir leitura publica de sessoes" on public.tactical_sessions;
create policy "Permitir leitura publica de sessoes"
  on public.tactical_sessions for select
  using (true);

drop policy if exists "Permitir criacao publica de sessoes" on public.tactical_sessions;
create policy "Permitir criacao publica de sessoes"
  on public.tactical_sessions for insert
  with check (true);

drop policy if exists "Permitir atualizacao publica de sessoes" on public.tactical_sessions;
create policy "Permitir atualizacao publica de sessoes"
  on public.tactical_sessions for update
  using (true)
  with check (true);

-- 4. Habilitar Realtime (WebSockets) para sincronização instantânea entre celulares
alter publication supabase_realtime add table public.tactical_sessions;
