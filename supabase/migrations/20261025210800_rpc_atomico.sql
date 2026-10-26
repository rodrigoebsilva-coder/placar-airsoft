-- =============================================================================
-- TACTICAL COMMAND — 001_rpc_atomico.sql
-- Escritas ATÔMICAS no estado da sala (corrige lost-update / race de K.I.A.)
--
-- Princípio: cada escrita mexe só no que é "dono" daquele papel e roda dentro de
-- uma transação com SELECT ... FOR UPDATE (lock de linha). Dois soldados marcando
-- K.I.A. ao mesmo tempo são SERIALIZADOS pelo Postgres: nenhum sobrescreve o outro,
-- e nenhum sobrescreve cronômetro/configurações/relatórios do Juiz.
--
--   rpc_set_soldier_alive  -> altera 1 campo de 1 soldado (Player ou Host)
--   rpc_enlist_soldier     -> alista/atualiza 1 soldado (entrada na sala)
--   rpc_host_patch         -> campos do Juiz: teams(name/color/wins), settings,
--                             stats, liveTimer, roomMeta.isOnline  (NUNCA soldiers)
--   rpc_host_sync_roster   -> cadastro de soldados feito pelo Juiz (upsert + remoção
--                             explícita; "alive" só muda em reset/troca de time)
--   server_now_ms          -> relógio do servidor (corrige clock skew do cronômetro)
--
-- Fase 1 (este arquivo): consistência. A autorização fica nos "ganchos"
-- _can_host_write/_can_write_soldier, permissivos aqui. O arquivo
-- 002_rls_hardening.sql troca os ganchos por checagem real (auth.uid()).
-- Idempotente: pode rodar mais de uma vez.
-- =============================================================================

alter table public.tactical_sessions add column if not exists rev bigint not null default 0;

-- Limite anti-bloat do estado (só vale para escritas novas)
alter table public.tactical_sessions drop constraint if exists tactical_sessions_state_size;
alter table public.tactical_sessions
  add constraint tactical_sessions_state_size check (octet_length(state::text) < 262144) not valid;

-- ---------------------------------------------------------------------------
-- Contador de revisão: sobe em QUALQUER update de state/is_online (inclusive de
-- clientes antigos durante a transição). O cliente usa para descartar evento velho
-- e para detectar evento perdido após queda de rede (heartbeat/resync).
-- ---------------------------------------------------------------------------
create or replace function public._bump_rev()
returns trigger
language plpgsql
as $$
begin
  new.rev := coalesce(old.rev, 0) + 1;
  return new;
end $$;

drop trigger if exists trg_tactical_sessions_bump_rev on public.tactical_sessions;
create trigger trg_tactical_sessions_bump_rev
  before update of state, is_online on public.tactical_sessions
  for each row execute function public._bump_rev();

-- ---------------------------------------------------------------------------
-- Relógio do servidor (epoch ms)
-- ---------------------------------------------------------------------------
create or replace function public.server_now_ms()
returns bigint
language sql volatile
as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

create or replace function public._now_ms()
returns bigint
language sql volatile
as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

-- ---------------------------------------------------------------------------
-- Ganchos de autorização (Fase 1 = permissivo; Fase 2 substitui)
-- ---------------------------------------------------------------------------
create or replace function public._current_uid()
returns text language sql stable as $$ select null::text $$;

create or replace function public._can_host_write(p_code text, p_device_id text)
returns boolean language sql stable as $$ select true $$;

create or replace function public._can_write_soldier(p_code text, p_role text, p_soldier jsonb)
returns boolean language sql stable as $$ select true $$;

-- ---------------------------------------------------------------------------
-- Recalcula teams.X.aliveCount a partir do array de soldados
-- (time sem soldados mantém o contador manual do Juiz)
-- ---------------------------------------------------------------------------
create or replace function public._recount_alive(p_state jsonb)
returns jsonb
language plpgsql
as $$
declare
  ta int; tb int; aa int; ab int;
begin
  select count(*) filter (where e->>'team' = 'A'),
         count(*) filter (where e->>'team' = 'B'),
         count(*) filter (where e->>'team' = 'A' and coalesce((e->>'alive')::boolean, false)),
         count(*) filter (where e->>'team' = 'B' and coalesce((e->>'alive')::boolean, false))
    into ta, tb, aa, ab
    from jsonb_array_elements(coalesce(p_state->'soldiers', '[]'::jsonb)) as e;

  if ta > 0 then p_state := jsonb_set(p_state, '{teams,A,aliveCount}', to_jsonb(aa), true); end if;
  if tb > 0 then p_state := jsonb_set(p_state, '{teams,B,aliveCount}', to_jsonb(ab), true); end if;
  return p_state;
end $$;

-- ---------------------------------------------------------------------------
-- 1) K.I.A. / voltar vivo — altera SOMENTE o campo alive de UM soldado
-- ---------------------------------------------------------------------------
create or replace function public.rpc_set_soldier_alive(
  p_code text,
  p_soldier_id text,
  p_alive boolean,
  p_device_id text default null,
  p_role text default 'PLAYER'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state jsonb;
  v_soldier jsonb;
  v_soldiers jsonb;
begin
  if p_role not in ('HOST', 'PLAYER') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;

  select state into v_state from public.tactical_sessions where code = p_code for update;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  select e into v_soldier
    from jsonb_array_elements(coalesce(v_state->'soldiers', '[]'::jsonb)) as e
   where e->>'id' = p_soldier_id
   limit 1;
  if v_soldier is null then
    raise exception 'soldier_not_found' using errcode = 'P0002';
  end if;

  if not public._can_write_soldier(p_code, p_role, v_soldier) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- idempotente: sem mudança, sem escrita, sem evento Realtime
  if coalesce((v_soldier->>'alive')::boolean, true) = p_alive then
    return v_state;
  end if;

  select jsonb_agg(
           case when e->>'id' = p_soldier_id
                then e || jsonb_build_object('alive', p_alive)
                else e end
           order by ord)
    into v_soldiers
    from jsonb_array_elements(v_state->'soldiers') with ordinality as t(e, ord);

  v_state := jsonb_set(v_state, '{soldiers}', v_soldiers);
  v_state := public._recount_alive(v_state);
  v_state := v_state || jsonb_build_object(
    'lastMutationBy', p_device_id,
    'lastMutationRole', p_role,
    'updatedAtMs', public._now_ms());

  update public.tactical_sessions
     set state = v_state, updated_at = now()
   where code = p_code;

  return v_state;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Alistar / atualizar o próprio soldado (entrada na sala)
--    Sanitiza no servidor (nome, time, patente) e impede "sequestro" por nome.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_enlist_soldier(
  p_code text,
  p_soldier jsonb,
  p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state jsonb;
  v_id text;
  v_name text;
  v_team text;
  v_rank text;
  v_uid text := public._current_uid();
  v_existing jsonb;
  v_new jsonb;
  v_soldiers jsonb;
  v_dups int;
begin
  v_id   := nullif(left(btrim(coalesce(p_soldier->>'id', '')), 64), '');
  v_name := nullif(left(upper(btrim(coalesce(p_soldier->>'name', ''))), 24), '');
  v_team := case when p_soldier->>'team' = 'B' then 'B' else 'A' end;
  v_rank := case when p_soldier->>'rank' in ('RECRUTA', 'EXPERIENTE', 'MATADOR')
                 then p_soldier->>'rank' else 'EXPERIENTE' end;
  if v_id is null or v_name is null then
    raise exception 'invalid_soldier' using errcode = '22023';
  end if;

  select state into v_state from public.tactical_sessions where code = p_code for update;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  if coalesce(v_state #>> '{roomMeta,isOnline}', 'true') = 'false'
     and not public._can_host_write(p_code, p_device_id) then
    raise exception 'room_offline' using errcode = '42501';
  end if;

  select e into v_existing
    from jsonb_array_elements(coalesce(v_state->'soldiers', '[]'::jsonb)) as e
   where e->>'id' = v_id
   limit 1;

  if v_existing is not null then
    -- soldado já tem dono (outro usuário) e quem chama não é o Juiz -> bloqueia
    if v_existing->>'ownerUid' is not null
       and v_existing->>'ownerUid' is distinct from v_uid
       and not public._can_host_write(p_code, p_device_id) then
      raise exception 'forbidden' using errcode = '42501';
    end if;

    v_new := v_existing || jsonb_build_object('name', v_name, 'team', v_team, 'rank', v_rank);
    if v_existing->>'ownerUid' is null and v_uid is not null then
      v_new := v_new || jsonb_build_object('ownerUid', v_uid);
    end if;
    if v_existing->>'team' is distinct from v_team then
      v_new := v_new || jsonb_build_object('alive', true);   -- trocou de time: volta vivo
    end if;

    select jsonb_agg(case when e->>'id' = v_id then v_new else e end order by ord)
      into v_soldiers
      from jsonb_array_elements(v_state->'soldiers') with ordinality as t(e, ord);
  else
    if jsonb_array_length(coalesce(v_state->'soldiers', '[]'::jsonb)) >= 80 then
      raise exception 'room_full' using errcode = '53400';
    end if;

    -- nome repetido de OUTRO aparelho ganha sufixo (evita dois jogadores no mesmo soldado)
    select count(*) into v_dups
      from jsonb_array_elements(coalesce(v_state->'soldiers', '[]'::jsonb)) as e
     where e->>'name' = v_name or e->>'name' like v_name || ' (%)';
    if v_dups > 0 then
      v_name := left(v_name, 19) || ' (' || (v_dups + 1) || ')';
    end if;

    v_new := jsonb_build_object(
      'id', v_id, 'name', v_name, 'team', v_team, 'rank', v_rank, 'alive', true,
      'stats', jsonb_build_object('survived', 0, 'kia', 0, 'matches', 0),
      'ownerDevice', p_device_id);
    if v_uid is not null then
      v_new := v_new || jsonb_build_object('ownerUid', v_uid);
    end if;
    v_soldiers := coalesce(v_state->'soldiers', '[]'::jsonb) || jsonb_build_array(v_new);
  end if;

  v_state := jsonb_set(v_state, '{soldiers}', v_soldiers);
  v_state := public._recount_alive(v_state);
  v_state := v_state || jsonb_build_object(
    'lastMutationBy', p_device_id,
    'lastMutationRole', 'PLAYER',
    'updatedAtMs', public._now_ms());

  update public.tactical_sessions
     set state = v_state, updated_at = now()
   where code = p_code;

  return v_state;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Campos do Juiz — NUNCA toca em "soldiers"
--    Proteção monotônica: relatório/vitórias não regridem (aparelho velho do Juiz
--    reconectando não zera nada) a menos que p_force = true (botão "ZERAR SESSÃO").
-- ---------------------------------------------------------------------------
create or replace function public.rpc_host_patch(
  p_code text,
  p_patch jsonb,
  p_device_id text default null,
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state jsonb;
  v_team text;
  v_t jsonb;
  v_alive jsonb;
  v_has_soldiers boolean;
  v_set jsonb;
  v_cur_matches int;
  v_new_matches int;
begin
  select state into v_state from public.tactical_sessions where code = p_code for update;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;
  if not public._can_host_write(p_code, p_device_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- teams: name / color / wins (aliveCount só para time SEM soldados cadastrados)
  v_state := jsonb_set(v_state, '{teams}', coalesce(v_state->'teams', '{}'::jsonb), true);
  foreach v_team in array array['A', 'B'] loop
    v_t := p_patch #> array['teams', v_team];
    if v_t is not null and jsonb_typeof(v_t) = 'object' then
      v_has_soldiers := exists (
        select 1 from jsonb_array_elements(coalesce(v_state->'soldiers', '[]'::jsonb)) as e
         where e->>'team' = v_team);
      v_alive := v_t->'aliveCount';
      v_t := v_t - 'aliveCount';
      if not v_has_soldiers and v_alive is not null and jsonb_typeof(v_alive) = 'number' then
        v_t := v_t || jsonb_build_object('aliveCount', greatest(0, (v_alive #>> '{}')::int));
      end if;
      if v_t ? 'name' then
        v_t := v_t || jsonb_build_object('name', left(coalesce(v_t->>'name', ''), 24));
      end if;
      if v_t ? 'color'
         and (v_t->>'color') not in ('blue', 'red', 'yellow', 'green', 'orange', 'purple') then
        v_t := v_t - 'color';
      end if;
      if v_t ? 'wins' then
        if jsonb_typeof(v_t->'wins') <> 'number' then
          v_t := v_t - 'wins';
        elsif not p_force
              and (v_t->>'wins')::int < coalesce((v_state #>> array['teams', v_team, 'wins'])::int, 0) then
          v_t := v_t - 'wins';           -- vitória nunca regride sem force
        end if;
      end if;
      v_state := jsonb_set(
        v_state, array['teams', v_team],
        coalesce(v_state #> array['teams', v_team], '{}'::jsonb) || v_t, true);
    end if;
  end loop;

  -- settings (sem "muted": preferência local de áudio, nunca vai para a nuvem)
  if jsonb_typeof(p_patch->'settings') = 'object' then
    v_set := (p_patch->'settings') - 'muted';
    if v_set ? 'timeLimitMinutes' then
      v_set := v_set || jsonb_build_object('timeLimitMinutes',
        least(180, greatest(1, coalesce((v_set->>'timeLimitMinutes')::int, 10))));
    end if;
    if v_set ? 'prepSeconds' then
      v_set := v_set || jsonb_build_object('prepSeconds',
        least(300, greatest(0, coalesce((v_set->>'prepSeconds')::int, 30))));
    end if;
    if v_set ? 'mode' and (v_set->>'mode') not in ('TIME_LIMIT', 'ELIMINATION') then
      v_set := v_set - 'mode';
    end if;
    v_state := jsonb_set(v_state, '{settings}',
      coalesce(v_state->'settings', '{}'::jsonb) || v_set, true);
  end if;

  -- stats (relatório): só avança, salvo p_force
  if jsonb_typeof(p_patch->'stats') = 'object' then
    v_cur_matches := coalesce((v_state #>> '{stats,totalMatches}')::int, 0);
    v_new_matches := coalesce((p_patch #>> '{stats,totalMatches}')::int, 0);
    if p_force or v_new_matches >= v_cur_matches then
      v_state := jsonb_set(v_state, '{stats}', p_patch->'stats', true);
    end if;
  end if;

  -- liveTimer (cronômetro compartilhado)
  if jsonb_typeof(p_patch->'liveTimer') = 'object'
     and (p_patch #>> '{liveTimer,phase}') in ('IDLE', 'PREP', 'COMBAT', 'PAUSED', 'VERIFY') then
    v_state := jsonb_set(v_state, '{liveTimer}', p_patch->'liveTimer', true);
  end if;

  -- roomMeta: SÓ isOnline (dono/e-mail nunca mudam por patch)
  if (p_patch #>> '{roomMeta,isOnline}') in ('true', 'false') then
    v_state := jsonb_set(v_state, '{roomMeta}', coalesce(v_state->'roomMeta', '{}'::jsonb), true);
    v_state := jsonb_set(v_state, '{roomMeta,isOnline}',
      to_jsonb((p_patch #>> '{roomMeta,isOnline}')::boolean), true);
  end if;

  v_state := public._recount_alive(v_state);
  v_state := v_state || jsonb_build_object(
    'lastMutationBy', p_device_id,
    'lastMutationRole', 'HOST',
    'updatedAtMs', public._now_ms());

  update public.tactical_sessions
     set state = v_state,
         updated_at = now(),
         is_online = coalesce((v_state #>> '{roomMeta,isOnline}')::boolean, is_online)
   where code = p_code;

  return v_state;
end $$;

-- ---------------------------------------------------------------------------
-- 4) Cadastro de soldados pelo Juiz: upsert + remoção EXPLÍCITA.
--    - nunca apaga soldado desconhecido (um Player que entrou agora não some);
--    - "alive" só muda em reset de round (p_reset_alive) ou troca de time;
--    - stats só avançam (matches maior vence).
-- ---------------------------------------------------------------------------
create or replace function public.rpc_host_sync_roster(
  p_code text,
  p_soldiers jsonb,
  p_removed_ids jsonb default '[]'::jsonb,
  p_reset_alive boolean default false,
  p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state jsonb;
  v_soldiers jsonb;
  v_removed text[];
begin
  select state into v_state from public.tactical_sessions where code = p_code for update;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;
  if not public._can_host_write(p_code, p_device_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_removed := array(select jsonb_array_elements_text(coalesce(p_removed_ids, '[]'::jsonb)));

  with srv as (
    select e, e->>'id' as id, ord
      from jsonb_array_elements(coalesce(v_state->'soldiers', '[]'::jsonb)) with ordinality as t(e, ord)
  ),
  inp as (
    select jsonb_build_object(
             'id',   left(e->>'id', 64),
             'name', left(upper(btrim(coalesce(e->>'name', ''))), 24),
             'team', case when e->>'team' = 'B' then 'B' else 'A' end,
             'rank', case when e->>'rank' in ('RECRUTA', 'EXPERIENTE', 'MATADOR')
                          then e->>'rank' else 'EXPERIENTE' end,
             'alive', coalesce((e->>'alive')::boolean, true),
             'stats', jsonb_build_object(
                        'survived', greatest(0, coalesce((e #>> '{stats,survived}')::int, 0)),
                        'kia',      greatest(0, coalesce((e #>> '{stats,kia}')::int, 0)),
                        'matches',  greatest(0, coalesce((e #>> '{stats,matches}')::int, 0)))
           ) as e,
           e->>'id' as id, ord
      from jsonb_array_elements(coalesce(p_soldiers, '[]'::jsonb)) with ordinality as t(e, ord)
     where coalesce(e->>'id', '') <> '' and coalesce(btrim(e->>'name'), '') <> ''
  ),
  merged as (
    select coalesce(srv.ord, 100000 + inp.ord) as sort_ord,
           case
             when srv.id is null then inp.e
             when inp.id is null then srv.e      -- só existe no servidor (ex.: Player novo): preserva
             else srv.e
                  || jsonb_build_object(
                       'name', inp.e->'name', 'team', inp.e->'team', 'rank', inp.e->'rank',
                       'stats', case when (inp.e #>> '{stats,matches}')::int >= coalesce((srv.e #>> '{stats,matches}')::int, 0)
                                     then inp.e->'stats' else coalesce(srv.e->'stats', inp.e->'stats') end,
                       'alive', case when p_reset_alive then true
                                     when srv.e->>'team' is distinct from inp.e->>'team' then true
                                     else coalesce((srv.e->>'alive')::boolean, true) end)
           end as e
      from srv full join inp on srv.id = inp.id
     where coalesce(srv.id, inp.id) <> all (v_removed)
  )
  select coalesce(jsonb_agg(e order by sort_ord), '[]'::jsonb) into v_soldiers from merged;

  -- reset de round também revive quem só existia no servidor (Players)
  if p_reset_alive then
    select coalesce(jsonb_agg(e || jsonb_build_object('alive', true) order by ord), '[]'::jsonb)
      into v_soldiers
      from jsonb_array_elements(v_soldiers) with ordinality as t(e, ord);
  end if;

  if jsonb_array_length(v_soldiers) > 80 then
    raise exception 'room_full' using errcode = '53400';
  end if;

  v_state := jsonb_set(v_state, '{soldiers}', v_soldiers);
  v_state := public._recount_alive(v_state);
  v_state := v_state || jsonb_build_object(
    'lastMutationBy', p_device_id,
    'lastMutationRole', 'HOST',
    'updatedAtMs', public._now_ms());

  update public.tactical_sessions
     set state = v_state, updated_at = now()
   where code = p_code;

  return v_state;
end $$;

-- ---------------------------------------------------------------------------
-- Permissões de execução (chamável com a anon key na Fase 1)
-- ---------------------------------------------------------------------------
revoke all on function public.rpc_set_soldier_alive(text, text, boolean, text, text) from public;
revoke all on function public.rpc_enlist_soldier(text, jsonb, text) from public;
revoke all on function public.rpc_host_patch(text, jsonb, text, boolean) from public;
revoke all on function public.rpc_host_sync_roster(text, jsonb, jsonb, boolean, text) from public;
revoke all on function public.server_now_ms() from public;

grant execute on function public.rpc_set_soldier_alive(text, text, boolean, text, text) to anon, authenticated;
grant execute on function public.rpc_enlist_soldier(text, jsonb, text) to anon, authenticated;
grant execute on function public.rpc_host_patch(text, jsonb, text, boolean) to anon, authenticated;
grant execute on function public.rpc_host_sync_roster(text, jsonb, jsonb, boolean, text) to anon, authenticated;
grant execute on function public.server_now_ms() to anon, authenticated;
