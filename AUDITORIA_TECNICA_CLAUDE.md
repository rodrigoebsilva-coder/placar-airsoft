# 🛡️ Especificação Técnica e Mapeamento de Funções para Auditoria de Código (Claude Audit Brief)

**Projeto:** Tactical Command — Paintball & Airsoft Match Controller (`v2.6.0`)  
**Desenvolvedor / Marca:** SOLia Labs (`@soliaoficial`)  
**Repositório Produção:** `https://github.com/rodrigoebsilva-coder/placar-airsoft`  
**URLs de Produção:**  
- Vercel: `https://placar-airsoft.vercel.app/`  
- GitHub Pages: `https://rodrigoebsilva-coder.github.io/placar-airsoft/`  

---

## 1. Visão Geral da Arquitetura (Stack & Padrões)

O sistema é uma **Single-Page Application (SPA) / Progressive Web App (PWA) Offline-First** escrita em **Vanilla JavaScript (ES2022)**, **HTML5 Semântico** e **Tailwind CSS (via CDN + CSS customizado)**, com sincronização multiplayer em tempo real via **Supabase (`@supabase/supabase-js@2` — Postgres REST + Realtime WebSockets)**.

### 1.1 Estrutura de Arquivos
| Arquivo | Linhas Aprox. | Responsabilidade Técnica |
| :--- | :--- | :--- |
| `index.html` | ~1.950 | Estrutura DOM da SPA: Header Tático, HUD de Auto-Controle do Soldado, Grid de Batalha 3 Colunas (Time A, Cronômetro Central, Time B) e 6 Modais (`#modalCloudSession`, `#modalRoster`, `#modalVerification`, `#modalReport`, `#modalHelp`, `#modalAuth`, `#modalLogs`). |
| `app.js` | ~4.270 | Motor completo da aplicação: Persistência `localStorage`, Logger de Erros (`TacticalLogger`), Sintetizador Web Audio API + DSP de Locutor FPS (`TacticalAudioEngine`), Autenticação/Papéis, Sincronização Supabase Realtime com controle de autoridade (`HOST` vs `PLAYER`), Máquina de Estados do Cronômetro e Renderização Reativa. |
| `styles.css` | ~220 | Grid adaptativo (`Portrait` vs `Landscape`/`lg`), temas táticos de cores por esquadrão (`blue`, `red`, `yellow`, `green`, `orange`, `purple`), animações de alerta (`PREP`, `COMBAT`, `DANGER`) e botões *glove-friendly* (`min-h-[56px]`). |
| `sw.js` | ~110 | Service Worker (`CACHE_NAME = 'tactical-cmd-v2.6.0'`): Cache offline de assets estáticos e áudios MP3, estratégia *Network-First* para navegação HTML e sanitização de respostas redirecionadas (`cleanRedirectedResponse`) para evitar `ERR_FAILED` no WebAPK Android/Vercel. |
| `manifest.json` | ~47 | Manifesto PWA com `"start_url": "./"`, `"display": "standalone"`, ícones `192x192`, `512x512` (`any` e `maskable`) e `icon.svg`. |
| `supabase/migrations/` | SQL | Schema da tabela `public.tactical_sessions` com `code text primary key`, `host_id text`, `state jsonb`, RLS pública para MVP e publicação em `supabase_realtime`. |

---

## 2. Modelo de Dados e Persistência (`localStorage` + `Supabase JSONB`)

### 2.1 Chaves de Armazenamento Local (`localStorage`)
1. **`tactical_command_state_v2` (`STORAGE_KEY`):** Estado principal da partida/sessão (`state`).
2. **`tactical_command_cloud_meta_v2` (`CLOUD_META_KEY`):** Metadados do dispositivo, sessão conectada e usuário logado (`cloudMeta`).
3. **`tactical_command_users_v2` (`LOCAL_USERS_KEY`):** Banco local de fallback para usuários auto-cadastrados.
4. **`tactical_command_logs_v2` (`LOGS_STORAGE_KEY`):** Buffer circular com os últimos 150 eventos/erros registrados pelo `TacticalLogger`.

### 2.2 Estrutura do Objeto `state` (Sincronizado na coluna `state JSONB` do Supabase)
```json
{
  "teams": {
    "A": { "name": "ALPHA", "color": "blue", "wins": 0, "aliveCount": 0 },
    "B": { "name": "BRAVO", "color": "red", "wins": 0, "aliveCount": 0 }
  },
  "soldiers": [
    {
      "id": "op_...",
      "name": "GHOST",
      "team": "A",
      "rank": "EXPERIENTE",
      "alive": true,
      "stats": { "survived": 0, "kia": 0, "matches": 0 }
    }
  ],
  "settings": {
    "mode": "TIME_LIMIT",
    "timeLimitMinutes": 10,
    "prepSeconds": 30,
    "muted": false
  },
  "stats": {
    "totalMatches": 0,
    "draws": 0,
    "history": [
      { "round": 1, "timestamp": "2026-10-25T...", "winner": "A", "countA": 3, "countB": 0 }
    ]
  },
  "liveTimer": {
    "phase": "IDLE",
    "pausedFrom": null,
    "phaseStartedAt": null,
    "initialPrepSec": 30,
    "initialCombatSec": 600,
    "snapshotRemainingPrepSec": 30,
    "snapshotCombatSec": 600
  },
  "roomMeta": {
    "ownerEmail": "rodrigoebsilva@gmail.com",
    "ownerName": "RODRIGO (COMANDANTE ADM)",
    "ownerDeviceId": "dev_...",
    "isOnline": true
  },
  "lastMutationBy": "dev_...",
  "lastMutationRole": "HOST",
  "updatedAtMs": 1792695000000
}
```

### 2.3 Estrutura do Objeto `cloudMeta` (Exclusivo do Aparelho Local)
```json
{
  "deviceId": "dev_...",
  "supabaseUrl": "https://aaqgxsjgalaqozwifgin.supabase.co",
  "supabaseKey": "eyJ...",
  "sessionCode": "ALPHA-42",
  "role": "HOST",
  "mySoldierId": "op_...",
  "joinSelectedTeam": "A",
  "selectedSoldierRank": "EXPERIENTE",
  "authUser": {
    "id": "admin_master_rodrigo",
    "email": "rodrigoebsilva@gmail.com",
    "name": "RODRIGO (COMANDANTE ADM)",
    "isAdmin": true
  },
  "myCreatedRooms": []
}
```

---

## 3. Detalhamento Completo de Módulos e Funções (`app.js`)

### 3.1 Módulo de Logs e Diagnóstico (`TacticalLogger`)
- **`class TacticalLogger` (linhas 140–248):**
  - `loadLogs()` / `saveLogs()`: Carrega e persiste até 150 logs no `localStorage`.
  - `log(level, category, message, details)`: Registra entradas tipadas (`INFO`, `WARN`, `ERROR`) com categoria (`SYSTEM`, `CLOUD`, `AUTH`, `TIMER`), papel atual (`HOST`/`PLAYER`/`LOCAL`) e sala ativa.
  - `setupGlobalHandlers()`: Intercepta erros não tratados via `window.addEventListener('error')` e `window.addEventListener('unhandledrejection')`.
  - `updateHeaderBadge()`: Atualiza o badge vermelho `#headerErrorCountBadge` no botão `🐞 LOGS`.
- **`renderLogsModal()` (linhas 3460–3557):** Renderiza telemetria ao vivo (Papel, Sala, Status WebSocket Realtime, Total de Erros) e lista filtrável de logs.
- **`runCloudConnectionDiagnostic()` (linhas 3559–3594):** Executa query de ping na tabela `tactical_sessions` medindo a latência em `ms`.

### 3.2 Módulo de Áudio Tático e DSP de Locutor FPS (`TacticalAudioEngine`)
- **`class TacticalAudioEngine` (linhas 320–565):**
  - `preloadFpsVoiceClips()`: Faz fetch assíncrono em memória (`ArrayBuffer`) de `./sfx-kill-them-all.mp3` e `./sfx-game-over.mp3`.
  - `playFpsAnnouncerClip(clipKey, fallbackPhrase)`: Decodifica o MP3 via `AudioContext.decodeAudioData` e processa em tempo real por uma cadeia DSP de locutor de arena FPS:
    1. `mainSource` (`playbackRate = 0.87`) + `subSource` sub-oitava (`playbackRate = 0.70`, filtro passa-baixa em `360Hz`).
    2. `BiquadFilterNode` (`lowshelf` `+9.5dB` em `140Hz` + `peaking` `+4.5dB` em `2400Hz`).
    3. `WaveShaperNode` (`makeDistortionCurve(22)`) para saturação harmônica.
    4. `DelayNode` (`110ms` com feedback `0.24`) para eco de arena.
    5. `DynamicsCompressorNode` + `GainNode` (`1.65x`).
    6. Fallback automático para `<audio>` HTML5 com `preservesPitch = false` ou `window.speechSynthesis`.
  - `playTone()`, `playDoubleBeep()`, `playCountdownBeep()`, `playCombatStartImpact()`, `playGameOverSiren()`: Efeitos sonoros sintetizados matematicamente via osciladores (`sine`, `square`, `sawtooth`, `triangle`).

### 3.3 Módulo de Autenticação, Auto-Cadastro e Controle de Acesso
- **`seedMasterAdminUser()` (linhas 605–627):** Garante que o Administrador Master (`rodrigoebsilva@gmail.com`) esteja sempre disponível.
- **`handleLogin(emailRaw, password)` (linhas 629–720):** Autentica o Administrador Master ou usuários comuns (via Supabase Auth `signInWithPassword` com fallback local), liberando a criação e gestão de salas.
- **`handleSelfRegister(nameRaw, emailRaw, password)` (linhas 721–787):** Fluxo de auto-cadastro de novos criadores de sala.
- **`handleLogout()` (linhas 789–801):** Encerra sessão autenticada.

### 3.4 Módulo de Sincronização em Nuvem e Autoridade (`Supabase Realtime Engine`)
- **`initSupabaseClient()` (linhas 806–838):** Inicializa `window.supabase.createClient` com taxa de 10 eventos/s.
- **`buildCloudStatePayload(isOnlineOverride, existingRoomMeta)` (linhas 973–1012):**
  - Constrói o payload JSONB garantindo que `roomMeta.ownerEmail`, `ownerName` e `ownerDeviceId` **nunca sejam sobrescritos por `null` ou pelo `deviceId` de um jogador convidado (`PLAYER`)**.
  - Carimba `lastMutationBy`, `lastMutationRole` e `updatedAtMs`.
- **`pushStateToCloud()` (linhas 1014–1109):**
  - Debounce de `90ms`.
  - **Regra Crítica de Segurança de Estado (`role === 'PLAYER'`):** Quando o aparelho é de um Soldado (`PLAYER`), faz `SELECT state` atualizado do banco e altera **exclusivamente** o registro daquele soldado em `soldiers` e recalcula `aliveCount`, **preservando 100% intocados** os campos `settings` (tempo/modo), `stats` (relatórios/histórico), `teams.wins`, `liveTimer` e `roomMeta` do Juiz (`HOST`).
  - **Regra de Autoridade (`role === 'HOST'`):** Atualiza o estado completo da sala.
- **`applyRemoteCloudState(remoteState, options)` (linhas 1486–1580):**
  - **Filtro Anti-Eco:** Ignora eventos Realtime cujo `remoteState.lastMutationBy === cloudMeta.deviceId` (quando `!options.forceFullSync`), evitando que cliques rápidos em `-1 MIN` / `+1 MIN` no Host voltem para trás.
  - **Blindagem do Host contra Eventos de Players:** Se `cloudMeta.role === 'HOST'` e `remoteState.lastMutationRole === 'PLAYER'`, o Host atualiza **apenas** `state.soldiers` (preservando o maior `stats.matches` de cada soldado) e `aliveCount`, sem jamais permitir que um evento de soldado resete o cronômetro, configurações de tempo ou relatórios do Juiz.
- **`fetchOpenOnlineRooms()` & `renderOpenRoomsQuickChips()` (linhas 1111–1184):**
  - Lista salas com `isOnline !== false` em chips clicáveis para que soldados entrem com 1 toque sem precisar digitar o código manualmente.
- **`fetchMyCreatedRooms()` (linhas 1187–1236):**
  - Filtra salas pertencentes ao criador logado (`ownerEmail === userEmail` ou `host_id === deviceId` ou salas órfãs para `isAdmin`) e renderiza tanto no modal de nuvem quanto na tela principal logada (`#authQuickMyRoomsList`).
- **`toggleMyRoomOnlineStatus(roomCode)` & `deleteMyCreatedRoom(roomCode)` (linhas 1239–1356):**
  - Ações exclusivas do criador da sala para alternar `roomMeta.isOnline` (`true`/`false`) ou executar `DELETE` no Supabase.
- **`createCloudSession()` (linhas 1359–1460):**
  - Restrito a usuários autenticados (`cloudMeta.authUser`).
  - **Proteção contra Reset Acidental:** Se o código informado já existir para o mesmo criador e possuir partidas ou soldados (`hasExistingData`), **retoma a sala existente** em vez de sobrescrevê-la com estado vazio.
- **`joinCloudSession(customCodeOverride)` (linhas 1463–1605):**
  - Faz busca exata por `code` e, se não encontrar, executa **busca fuzzy normalizada** ignorando hífens/espaços (`ALPHA42` encontra `ALPHA-42`).
  - Identifica automaticamente se quem está entrando é o criador (`isCreator -> HOST`) ou soldado (`PLAYER`).
  - Alista automaticamente o operador com o nível escolhido (`RECRUTA`, `EXPERIENTE`, `MATADOR`) e retorna `boolean` indicando sucesso.

### 3.5 Máquina de Estados do Cronômetro e Partida
- **Fases (`runtime.phase`):** `'IDLE'` $\rightarrow$ `'PREP'` $\rightarrow$ `'COMBAT'` $\leftrightarrow$ `'PAUSED'` $\rightarrow$ `'VERIFY'`.
- **`syncRuntimeToLiveTimer()` & `syncRuntimeFromRemoteLiveTimer()` (linhas 1626–1690):**
  - Calcula o tempo decorrido via timestamp absoluto (`Date.now() - lt.phaseStartedAt`), garantindo que todos os celulares da sessão mostrem exatamente o mesmo segundo no cronômetro mesmo se entrarem no meio da partida.
- **`adjustTeamAliveCount(teamKey, delta)` & `toggleSoldierAliveInField(soldierId)` (linhas 1715–1768):**
  - Atualiza baixas em tempo real. No modo `PLAYER`, restringe o toque apenas ao próprio soldado (`soldier.id === cloudMeta.mySoldierId`), enquanto o `HOST` pode marcar baixas de qualquer soldado dos dois times (inclusive jogadores sem celular).
  - Dispara `checkAutoEliminationTrigger(teamKey)` se `aliveCount === 0` durante `COMBAT`.
- **`finishMatchAndOpenVerification()` & `confirmMatchResultAndScore()` (linhas 1938–2365):**
  - Abre conferência pós-partida, pré-marca como `K.I.A.` todo o time que sofreu eliminação total, soma vitórias/empates e atualiza estatísticas individuais de sobrevivência (`survived`, `kia`, `matches`).

### 3.6 Alistamento, Patentes e Equilíbrio de Times
- **`SOLDIER_RANKS` (`RECRUTA` peso 1, `EXPERIENTE` peso 2, `MATADOR` peso 3):**
  - `addSoldier()`, `cycleSoldierRank()`, `switchSoldierTeam()`, `deleteSoldier()`.
  - `shuffleAndBalanceTeams()` (linhas 2405–2442): Embaralha aleatoriamente (Fisher-Yates), ordena por peso de patente (`weight` decrescente) e distribui alternadamente entre Time A e Time B para equilibrar tanto a quantidade de jogadores quanto o nível técnico dos esquadrões.

---

## 4. Prompt Pronto para Enviar ao Claude (Copie e Cole)

Abaixo está o prompt estruturado que você pode copiar e colar diretamente no Claude junto com os arquivos `app.js`, `index.html` e `sw.js`:

```markdown
Atue como um Engenheiro de Software Sênior especialista em Arquitetura Front-End, PWAs Offline-First e Sistemas Distribuídos em Tempo Real (Supabase Realtime / WebSockets).

Estou enviando o código-fonte do projeto **Tactical Command — Paintball & Airsoft Match Controller (v2.6.0)** (`index.html`, `app.js`, `sw.js`, `manifest.json`) juntamente com o documento de especificação técnica (`AUDITORIA_TECNICA_CLAUDE.md`).

Por favor, realize uma **Auditoria Técnica Profunda de Código, Segurança e Sincronização em Tempo Real** focando nos seguintes pontos críticos:

1. **Concorrência e Consistência de Estado no Supabase (`pushStateToCloud` vs `applyRemoteCloudState`):**
   - Verifique se existe alguma condição de corrida (*race condition*) quando múltiplos soldados (`PLAYER`) marcam `K.I.A.` simultaneamente ou entram na sala ao mesmo tempo.
   - Avalie se a blindagem atual do `HOST` garante 100% que configurações de tempo (`state.settings`), relatórios (`state.stats`) e vitórias (`teams.A.wins` / `teams.B.wins`) jamais sejam zerados ou sobrescritos por dispositivos convidados ou reconexões de rede.
   - Sugira se devemos migrar o `update` da coluna JSONB para uma função RPC atômica no PostgreSQL (`jsonb_set`) e forneça o código SQL + JS caso recomende.

2. **Sincronização do Cronômetro (`liveTimer` e `runtime`):**
   - Analise `syncRuntimeToLiveTimer()`, `syncRuntimeFromRemoteLiveTimer()` e `tickGuestChronometer()` quanto a possíveis desvios de relógio (*clock skew* entre o relógio do celular do Juiz e o relógio dos celulares dos Soldados) e proponha melhorias.

3. **Fluxo de Entrada em Salas Abertas e Reconexão (`joinCloudSession`, `createCloudSession`, `checkInitialCloudSession`):**
   - Verifique se há algum cenário de borda (*edge case*) na reconexão automática após queda de 4G/5G no campo ou ao reabrir o PWA instalado na tela inicial.

4. **Segurança e Permissões (`Auth`, `roomMeta` e RLS do Supabase):**
   - Avalie o modelo atual de propriedade de sala (`roomMeta.ownerEmail`, `host_id`) e sugira políticas RLS (*Row Level Security*) ou validações adicionais sem prejudicar a entrada rápida de soldados sem login.

5. **Performance Mobile, Web Audio API (`TacticalAudioEngine`) e Service Worker (`sw.js`):**
   - Verifique se há vazamentos de memória (*memory leaks* em `AudioContext`, `setInterval` ou canais Realtime) e se a estratégia de cache do `sw.js` está ideal para atualizações rápidas em produção na Vercel.

Para cada ponto encontrado, classifique a severidade (**Crítica**, **Média**, **Baixa** / **Melhoria**) e forneça o trecho exato de código refatorado pronto para aplicação.
```
