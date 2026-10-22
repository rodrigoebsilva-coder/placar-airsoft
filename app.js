/**
 * TACTICAL COMMAND — PAINTBALL & AIRSOFT MATCH CONTROLLER (CLOUD V2.0)
 * Complete Offline-First PWA + Supabase Realtime Multiplayer Sessions,
 * Host vs Operator Mobile Self-K.I.A. HUD, Tactical Audio Synthesizer & Hall of Fame.
 */

const STORAGE_KEY = 'tactical_command_state_v2';
const CLOUD_META_KEY = 'tactical_command_cloud_meta_v2';

// Optional default Supabase credentials (can also be configured in the UI modal)
const DEFAULT_SUPABASE_URL = 'https://aaqgxsjgalaqozwifgin.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhcWd4c2pnYWxhcW96d2lmZ2luIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2NzY3NjIsImV4cCI6MjEwODI1Mjc2Mn0.XGGdAobbiPhUCMeCEdFi19mwVTLfiFUv4hhu_KtDDh8';

const TACTICAL_COLORS = [
  { id: 'blue', label: 'Azul', hex: '#3b82f6', textClass: 'text-blue-400' },
  { id: 'red', label: 'Vermelho', hex: '#ef4444', textClass: 'text-red-400' },
  { id: 'yellow', label: 'Amarelo', hex: '#eab308', textClass: 'text-yellow-400' },
  { id: 'green', label: 'Verde', hex: '#22c55e', textClass: 'text-green-400' },
  { id: 'orange', label: 'Laranja', hex: '#f97316', textClass: 'text-orange-400' },
  { id: 'purple', label: 'Roxo', hex: '#a855f7', textClass: 'text-purple-400' }
];

const SQL_SETUP_SCRIPT = `-- Execute no SQL Editor do Supabase:
create table if not exists public.tactical_sessions (
  code text primary key,
  host_id text not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.tactical_sessions enable row level security;
create policy "Acesso publico total MVP" on public.tactical_sessions for all using (true) with check (true);
alter publication supabase_realtime add table public.tactical_sessions;`;

function getDefaultState() {
  return {
    teams: {
      A: { name: 'ALPHA', color: 'blue', wins: 0, aliveCount: 0 },
      B: { name: 'BRAVO', color: 'red', wins: 0, aliveCount: 0 }
    },
    soldiers: [], // { id, name, team: 'A'|'B', alive: true, stats: { survived: 0, kia: 0, matches: 0 } }
    settings: {
      mode: 'TIME_LIMIT', // 'TIME_LIMIT' | 'ELIMINATION'
      timeLimitMinutes: 10,
      prepSeconds: 30,
      muted: false
    },
    stats: {
      totalMatches: 0,
      draws: 0,
      history: []
    },
    // Shared live chronometer state for Cloud synchronization
    liveTimer: {
      phase: 'IDLE', // 'IDLE' | 'PREP' | 'COMBAT' | 'PAUSED' | 'VERIFY'
      pausedFrom: null,
      phaseStartedAt: null, // Epoch ms when PREP or COMBAT started
      initialPrepSec: 30,
      initialCombatSec: 600,
      snapshotRemainingPrepSec: 30,
      snapshotCombatSec: 600
    }
  };
}

function getDefaultCloudMeta() {
  return {
    deviceId: 'dev_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36),
    supabaseUrl: DEFAULT_SUPABASE_URL,
    supabaseKey: DEFAULT_SUPABASE_ANON_KEY,
    sessionCode: null,
    role: 'LOCAL', // 'LOCAL' | 'HOST' | 'PLAYER'
    mySoldierId: null,
    joinSelectedTeam: 'A'
  };
}

let state = loadState();
let cloudMeta = loadCloudMeta();
let supabaseClient = null;
let realtimeChannel = null;
let isApplyingRemoteUpdate = false;

// Runtime Match State
let runtime = {
  phase: 'IDLE', // 'IDLE' | 'PREP' | 'COMBAT' | 'PAUSED' | 'VERIFY'
  pausedFrom: null,
  remainingPrepSec: state.settings.prepSeconds,
  combatSeconds: state.settings.mode === 'TIME_LIMIT' ? state.settings.timeLimitMinutes * 60 : 0,
  timerInterval: null,
  lastAnnouncedPhase: 'IDLE',
  verifyDraft: {
    reason: 'FIM DE COMBATE',
    eliminatedTeam: null,
    countA: 0,
    countB: 0,
    soldiersStatus: {}
  }
};

/* ==========================================================================
   PERSISTENCE (LOCALSTORAGE)
   ========================================================================== */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultState();
    const parsed = JSON.parse(raw);
    const def = getDefaultState();
    return {
      teams: {
        A: { ...def.teams.A, ...(parsed.teams?.A || {}) },
        B: { ...def.teams.B, ...(parsed.teams?.B || {}) }
      },
      soldiers: Array.isArray(parsed.soldiers) ? parsed.soldiers : [],
      settings: { ...def.settings, ...(parsed.settings || {}) },
      stats: { ...def.stats, ...(parsed.stats || {}) },
      liveTimer: { ...def.liveTimer, ...(parsed.liveTimer || {}) }
    };
  } catch (err) {
    return getDefaultState();
  }
}

function loadCloudMeta() {
  try {
    const raw = localStorage.getItem(CLOUD_META_KEY);
    const def = getDefaultCloudMeta();
    if (!raw) return def;
    const parsed = JSON.parse(raw);
    return {
      ...def,
      ...parsed,
      supabaseUrl: parsed.supabaseUrl || def.supabaseUrl,
      supabaseKey: parsed.supabaseKey || def.supabaseKey,
      deviceId: parsed.deviceId || def.deviceId
    };
  } catch (err) {
    return getDefaultCloudMeta();
  }
}

function saveCloudMeta() {
  try {
    localStorage.setItem(CLOUD_META_KEY, JSON.stringify(cloudMeta));
  } catch (err) {}
}

function saveState(skipCloudPush = false) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {}

  if (!skipCloudPush && !isApplyingRemoteUpdate && cloudMeta.sessionCode && supabaseClient) {
    pushStateToCloud();
  }
}

/* ==========================================================================
   TACTICAL AUDIO ENGINE (WEB AUDIO API + WEB SPEECH API)
   ========================================================================== */
class TacticalAudioEngine {
  constructor() {
    this.ctx = null;
    this.voices = [];
    if ('speechSynthesis' in window) {
      const loadVoices = () => {
        this.voices = window.speechSynthesis.getVoices();
      };
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }

  ensureContext() {
    if (state.settings.muted) return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  playTone(freq = 880, durationMs = 120, type = 'sine', gainVal = 0.25, delayMs = 0) {
    if (state.settings.muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const startTime = ctx.currentTime + delayMs / 1000;
    const endTime = startTime + durationMs / 1000;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(gainVal, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, endTime);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(startTime);
    osc.stop(endTime + 0.02);
  }

  playDoubleBeep() {
    this.playTone(920, 90, 'square', 0.22, 0);
    this.playTone(1120, 110, 'square', 0.25, 130);
  }

  playCountdownBeep(secondsLeft) {
    let freq = 780;
    let type = 'sawtooth';
    if (secondsLeft === 3) freq = 980;
    if (secondsLeft === 2) freq = 1180;
    if (secondsLeft === 1) freq = 1480;
    this.playTone(freq, 140, type, 0.28, 0);
  }

  playCombatStartImpact() {
    if (state.settings.muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;

    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(160, now);
    subOsc.frequency.exponentialRampToValueAtTime(38, now + 0.65);

    subGain.gain.setValueAtTime(0.5, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);

    subOsc.connect(subGain);
    subGain.connect(ctx.destination);
    subOsc.start(now);
    subOsc.stop(now + 0.72);

    const sirenOsc = ctx.createOscillator();
    const sirenGain = ctx.createGain();
    sirenOsc.type = 'sawtooth';
    sirenOsc.frequency.setValueAtTime(420, now);
    sirenOsc.frequency.linearRampToValueAtTime(760, now + 0.28);
    sirenOsc.frequency.linearRampToValueAtTime(520, now + 0.55);

    sirenGain.gain.setValueAtTime(0.22, now);
    sirenGain.gain.exponentialRampToValueAtTime(0.001, now + 0.58);

    sirenOsc.connect(sirenGain);
    sirenGain.connect(ctx.destination);
    sirenOsc.start(now);
    sirenOsc.stop(now + 0.6);
  }

  playGameOverSiren() {
    if (state.settings.muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(680, now);
    osc.frequency.linearRampToValueAtTime(320, now + 0.45);
    osc.frequency.linearRampToValueAtTime(640, now + 0.85);
    osc.frequency.linearRampToValueAtTime(240, now + 1.35);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.4);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 1.45);
  }

  speakCommand(phrase) {
    if (state.settings.muted || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(phrase);
      utter.lang = 'en-US';
      utter.pitch = 0.3;
      utter.rate = 0.85;
      utter.volume = 1.0;

      if (!this.voices.length) {
        this.voices = window.speechSynthesis.getVoices();
      }
      const enVoices = this.voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
      if (enVoices.length > 0) {
        const preferred =
          enVoices.find((v) => /david|mark|guy|daniel|google us english|male/i.test(v.name)) ||
          enVoices[0];
        utter.voice = preferred;
      }

      window.speechSynthesis.speak(utter);
    } catch (err) {}
  }

  announceCombatStart() {
    this.playCombatStartImpact();
    setTimeout(() => {
      this.speakCommand('Kill them all!');
    }, 220);
  }

  announceGameOver() {
    this.playGameOverSiren();
    setTimeout(() => {
      this.speakCommand('Game Over!');
    }, 350);
  }
}

const audioEngine = new TacticalAudioEngine();

/* ==========================================================================
   SCREEN WAKE LOCK API
   ========================================================================== */
let wakeLockSentinel = null;

async function requestWakeLock() {
  const dot = document.getElementById('wakeLockDot');
  const text = document.getElementById('wakeLockText');
  const badge = document.getElementById('wakeLockBadge');

  if (!('wakeLock' in navigator)) {
    text.textContent = 'TELA: PADRÃO';
    return;
  }

  try {
    if (!wakeLockSentinel) {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        wakeLockSentinel = null;
        updateWakeLockUI(false);
      });
    }
    updateWakeLockUI(true);
  } catch (err) {
    updateWakeLockUI(false);
  }

  function updateWakeLockUI(active) {
    if (active) {
      dot.className = 'w-2 h-2 rounded-full bg-lime-400 animate-ping';
      text.textContent = 'TELA ATIVA';
      badge.className =
        'inline-flex items-center gap-1.5 text-xs font-bold uppercase px-2.5 py-1 rounded-full bg-zinc-950 border border-lime-400/50 text-lime-400';
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-zinc-600';
      text.textContent = 'TELA: AUTO';
      badge.className =
        'inline-flex items-center gap-1.5 text-xs font-bold uppercase px-2.5 py-1 rounded-full bg-zinc-950 border border-zinc-800 text-zinc-400';
    }
  }
}

async function releaseWakeLock() {
  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
      wakeLockSentinel = null;
    } catch (e) {}
  }
  const dot = document.getElementById('wakeLockDot');
  const text = document.getElementById('wakeLockText');
  const badge = document.getElementById('wakeLockBadge');
  dot.className = 'w-2 h-2 rounded-full bg-zinc-600';
  text.textContent = 'TELA: AUTO';
  badge.className =
    'inline-flex items-center gap-1.5 text-xs font-bold uppercase px-2.5 py-1 rounded-full bg-zinc-950 border border-zinc-800 text-zinc-400';
}

document.addEventListener('visibilitychange', () => {
  if (
    document.visibilityState === 'visible' &&
    (runtime.phase === 'PREP' || runtime.phase === 'COMBAT')
  ) {
    requestWakeLock();
  }
});

/* ==========================================================================
   SUPABASE REALTIME CLOUD ENGINE (CREATE / JOIN / SYNC SESSIONS)
   ========================================================================== */
function initSupabaseClient() {
  const url = (cloudMeta.supabaseUrl || '').trim();
  const key = (cloudMeta.supabaseKey || '').trim();
  const statusBadge = document.getElementById('supabaseConfigStatusBadge');

  if (!url || !key || !window.supabase) {
    supabaseClient = null;
    if (statusBadge) {
      statusBadge.textContent = 'NÃO CONFIGURADO';
      statusBadge.className =
        'text-[11px] font-tactical-mono px-2 py-0.5 rounded bg-red-950/60 border border-red-700 text-red-300';
    }
    return false;
  }

  try {
    supabaseClient = window.supabase.createClient(url, key, {
      realtime: { params: { eventsPerSecond: 10 } }
    });
    if (statusBadge) {
      statusBadge.textContent = '🟢 PRONTO E CONECTADO';
      statusBadge.className =
        'text-[11px] font-tactical-mono px-2 py-0.5 rounded bg-lime-950/60 border border-lime-500 text-lime-300';
    }
    return true;
  } catch (err) {
    console.warn('Erro ao inicializar Supabase:', err);
    supabaseClient = null;
    return false;
  }
}

function generateRandomSessionCode() {
  const prefixes = ['ALPHA', 'BRAVO', 'DELTA', 'GHOST', 'VIPER', 'COBRA', 'SNIPER', 'TACTIC'];
  const p = prefixes[Math.floor(Math.random() * prefixes.length)];
  const num = Math.floor(10 + Math.random() * 90);
  return `${p}-${num}`;
}

function sanitizeSessionCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-_]/g, '')
    .slice(0, 16);
}

// Build serializable state payload for Supabase
function buildCloudStatePayload() {
  return {
    teams: state.teams,
    soldiers: state.soldiers,
    settings: {
      mode: state.settings.mode,
      timeLimitMinutes: state.settings.timeLimitMinutes,
      prepSeconds: state.settings.prepSeconds
    },
    stats: state.stats,
    liveTimer: state.liveTimer
  };
}

let pushDebounceTimer = null;
async function pushStateToCloud() {
  if (!supabaseClient || !cloudMeta.sessionCode) return;

  if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
  pushDebounceTimer = setTimeout(async () => {
    try {
      const payload = buildCloudStatePayload();
      await supabaseClient
        .from('tactical_sessions')
        .update({
          state: payload,
          updated_at: new Date().toISOString()
        })
        .eq('code', cloudMeta.sessionCode);
    } catch (err) {
      console.warn('Falha ao sincronizar estado com Supabase:', err);
    }
  }, 80);
}

// Create a new session (or overwrite if same host)
async function createCloudSession() {
  if (!initSupabaseClient()) {
    document.getElementById('supabaseConfigAccordion').open = true;
    showToast('⚙️', 'Configure a URL e Anon Key do Supabase abaixo primeiro!');
    return;
  }

  let inputCode = sanitizeSessionCode(document.getElementById('inputCreateSessionCode').value);
  if (!inputCode) {
    inputCode = generateRandomSessionCode();
    document.getElementById('inputCreateSessionCode').value = inputCode;
  }

  // Sync current timer state into liveTimer
  syncRuntimeToLiveTimer();

  try {
    const payload = buildCloudStatePayload();
    const { data: existing } = await supabaseClient
      .from('tactical_sessions')
      .select('code, host_id')
      .eq('code', inputCode)
      .maybeSingle();

    if (existing && existing.host_id !== cloudMeta.deviceId) {
      showToast('⚠️', `O código ${inputCode} já está em uso! Escolha outro ou clique em 🎲 GERAR.`);
      return;
    }

    const { error } = await supabaseClient.from('tactical_sessions').upsert(
      {
        code: inputCode,
        host_id: cloudMeta.deviceId,
        state: payload,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'code' }
    );

    if (error) {
      console.error(error);
      document.getElementById('supabaseConfigAccordion').open = true;
      showToast('⚠️', 'Erro ao criar sala no Supabase. Verifique se executou o script SQL!');
      return;
    }

    cloudMeta.sessionCode = inputCode;
    cloudMeta.role = 'HOST';
    saveCloudMeta();

    subscribeToCloudSession(inputCode);
    updateUrlRoomParam(inputCode);
    renderAll();
    renderCloudModal();
    showToast('🚀', `Sessão ${inputCode} criada na nuvem! Compartilhe o código.`);
  } catch (err) {
    console.error(err);
    showToast('⚠️', 'Erro de conexão com o Supabase.');
  }
}

// Join an existing session as Operator/Participant (or recover Host if creator)
async function joinCloudSession() {
  if (!initSupabaseClient()) {
    document.getElementById('supabaseConfigAccordion').open = true;
    showToast('⚙️', 'Configure a URL e Anon Key do Supabase abaixo primeiro!');
    return;
  }

  const code = sanitizeSessionCode(document.getElementById('inputJoinSessionCode').value);
  if (!code) {
    showToast('⚠️', 'Digite o código da sala para entrar!');
    return;
  }

  const operatorName = (document.getElementById('inputJoinOperatorName').value || '')
    .trim()
    .toUpperCase();
  const chosenTeam = cloudMeta.joinSelectedTeam === 'B' ? 'B' : 'A';

  try {
    const { data, error } = await supabaseClient
      .from('tactical_sessions')
      .select('*')
      .eq('code', code)
      .maybeSingle();

    if (error || !data) {
      showToast('❌', `Sessão "${code}" não encontrada! Verifique o código.`);
      return;
    }

    cloudMeta.sessionCode = code;
    cloudMeta.role = data.host_id === cloudMeta.deviceId ? 'HOST' : 'PLAYER';

    // Apply fetched room state
    applyRemoteCloudState(data.state);

    // Auto-enlist operator if name was entered
    if (operatorName) {
      let existingSoldier = state.soldiers.find(
        (s) => s.id === cloudMeta.mySoldierId || s.name.toUpperCase() === operatorName
      );

      if (existingSoldier) {
        existingSoldier.team = chosenTeam;
        cloudMeta.mySoldierId = existingSoldier.id;
      } else {
        const newSoldier = {
          id: 'op_' + cloudMeta.deviceId.slice(-6) + '_' + Date.now().toString(36),
          name: operatorName,
          team: chosenTeam,
          alive: true,
          stats: { survived: 0, kia: 0, matches: 0 }
        };
        state.soldiers.push(newSoldier);
        cloudMeta.mySoldierId = newSoldier.id;
      }

      syncAliveCountFromRoster('A');
      syncAliveCountFromRoster('B');
      saveState(false); // Pushes new operator to Supabase immediately
    }

    saveCloudMeta();
    subscribeToCloudSession(code);
    updateUrlRoomParam(code);
    renderAll();
    renderCloudModal();
    document.getElementById('modalCloudSession').classList.add('hidden');

    showToast(
      '📡',
      operatorName
        ? `Conectado à sala ${code} como ${operatorName}!`
        : `Conectado à sala ${code} em tempo real!`
    );
  } catch (err) {
    console.error(err);
    showToast('⚠️', 'Erro ao entrar na sessão.');
  }
}

function subscribeToCloudSession(code) {
  if (!supabaseClient || !code) return;

  if (realtimeChannel) {
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  realtimeChannel = supabaseClient
    .channel(`room_${code}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'tactical_sessions',
        filter: `code=eq.${code}`
      },
      (payload) => {
        if (payload.new && payload.new.state) {
          applyRemoteCloudState(payload.new.state);
        }
      }
    )
    .subscribe();
}

function applyRemoteCloudState(remoteState) {
  if (!remoteState) return;
  isApplyingRemoteUpdate = true;

  const prevMuted = state.settings.muted;
  const def = getDefaultState();

  state.teams = {
    A: { ...def.teams.A, ...(remoteState.teams?.A || {}) },
    B: { ...def.teams.B, ...(remoteState.teams?.B || {}) }
  };
  state.soldiers = Array.isArray(remoteState.soldiers) ? remoteState.soldiers : [];
  state.settings = {
    ...def.settings,
    ...(remoteState.settings || {}),
    muted: prevMuted
  };
  state.stats = { ...def.stats, ...(remoteState.stats || {}) };
  state.liveTimer = { ...def.liveTimer, ...(remoteState.liveTimer || {}) };

  // Synchronize local chronometer with shared liveTimer
  syncRuntimeFromRemoteLiveTimer();

  // If Host is in COMBAT and a player just marked themselves KIA causing team aliveCount === 0, trigger auto-elimination
  if (isHostOrLocal() && runtime.phase === 'COMBAT') {
    if (state.teams.A.aliveCount === 0 && getTeamSoldiers('A').length > 0) {
      isApplyingRemoteUpdate = false;
      finishMatchAndOpenVerification(`ELIMINAÇÃO TOTAL (${state.teams.A.name} ZERADO)`, 'A');
      return;
    }
    if (state.teams.B.aliveCount === 0 && getTeamSoldiers('B').length > 0) {
      isApplyingRemoteUpdate = false;
      finishMatchAndOpenVerification(`ELIMINAÇÃO TOTAL (${state.teams.B.name} ZERADO)`, 'B');
      return;
    }
  }

  saveState(true);
  renderAll();
  isApplyingRemoteUpdate = false;
}

function leaveCloudSession() {
  if (realtimeChannel && supabaseClient) {
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  cloudMeta.sessionCode = null;
  cloudMeta.role = 'LOCAL';
  saveCloudMeta();
  updateUrlRoomParam(null);
  renderAll();
  renderCloudModal();
  showToast('🚪', 'Você saiu da sessão na nuvem. Modo Local ativado.');
}

function updateUrlRoomParam(code) {
  try {
    const url = new URL(window.location.href);
    if (code) {
      url.searchParams.set('room', code);
    } else {
      url.searchParams.delete('room');
    }
    window.history.replaceState({}, '', url.toString());
  } catch (e) {}
}

function isHostOrLocal() {
  return cloudMeta.role === 'LOCAL' || cloudMeta.role === 'HOST';
}

/* ==========================================================================
   LIVE TIMER SYNCHRONIZATION BETWEEN HOST AND PARTICIPANT PHONES
   ========================================================================== */
function syncRuntimeToLiveTimer() {
  state.liveTimer = {
    phase: runtime.phase,
    pausedFrom: runtime.pausedFrom,
    phaseStartedAt:
      runtime.phase === 'PREP' || runtime.phase === 'COMBAT' ? Date.now() : null,
    initialPrepSec: runtime.remainingPrepSec,
    initialCombatSec: runtime.combatSeconds,
    snapshotRemainingPrepSec: runtime.remainingPrepSec,
    snapshotCombatSec: runtime.combatSeconds
  };
}

function syncRuntimeFromRemoteLiveTimer() {
  const lt = state.liveTimer;
  if (!lt) return;

  const oldPhase = runtime.phase;
  runtime.phase = lt.phase || 'IDLE';
  runtime.pausedFrom = lt.pausedFrom || null;

  // Trigger audio announcements on participant phones when phase transitions!
  if (oldPhase !== runtime.phase && runtime.lastAnnouncedPhase !== runtime.phase) {
    runtime.lastAnnouncedPhase = runtime.phase;
    if (runtime.phase === 'COMBAT') {
      audioEngine.announceCombatStart();
      requestWakeLock();
    } else if (runtime.phase === 'VERIFY') {
      audioEngine.announceGameOver();
      releaseWakeLock();
    } else if (runtime.phase === 'PREP') {
      audioEngine.playDoubleBeep();
      requestWakeLock();
    }
  }

  if (runtime.phase === 'PREP' && lt.phaseStartedAt) {
    const elapsed = Math.floor((Date.now() - lt.phaseStartedAt) / 1000);
    runtime.remainingPrepSec = Math.max(0, (lt.initialPrepSec || state.settings.prepSeconds) - elapsed);
    if (!isHostOrLocal()) {
      clearMatchInterval();
      runtime.timerInterval = setInterval(tickGuestChronometer, 1000);
    }
  } else if (runtime.phase === 'COMBAT' && lt.phaseStartedAt) {
    const elapsed = Math.floor((Date.now() - lt.phaseStartedAt) / 1000);
    if (state.settings.mode === 'TIME_LIMIT') {
      runtime.combatSeconds = Math.max(
        0,
        (lt.initialCombatSec ?? state.settings.timeLimitMinutes * 60) - elapsed
      );
    } else {
      runtime.combatSeconds = (lt.initialCombatSec || 0) + elapsed;
    }
    if (!isHostOrLocal()) {
      clearMatchInterval();
      runtime.timerInterval = setInterval(tickGuestChronometer, 1000);
    }
  } else {
    clearMatchInterval();
    runtime.remainingPrepSec = lt.snapshotRemainingPrepSec ?? state.settings.prepSeconds;
    runtime.combatSeconds =
      lt.snapshotCombatSec ??
      (state.settings.mode === 'TIME_LIMIT' ? state.settings.timeLimitMinutes * 60 : 0);
  }
}

function tickGuestChronometer() {
  const lt = state.liveTimer;
  if (!lt || !lt.phaseStartedAt) return;

  const elapsed = Math.floor((Date.now() - lt.phaseStartedAt) / 1000);
  if (runtime.phase === 'PREP') {
    runtime.remainingPrepSec = Math.max(0, (lt.initialPrepSec || state.settings.prepSeconds) - elapsed);
    if (runtime.remainingPrepSec <= 10 && runtime.remainingPrepSec >= 1) {
      audioEngine.playCountdownBeep(runtime.remainingPrepSec);
    }
  } else if (runtime.phase === 'COMBAT') {
    if (state.settings.mode === 'TIME_LIMIT') {
      runtime.combatSeconds = Math.max(
        0,
        (lt.initialCombatSec ?? state.settings.timeLimitMinutes * 60) - elapsed
      );
      if (runtime.combatSeconds <= 10 && runtime.combatSeconds >= 1) {
        audioEngine.playCountdownBeep(runtime.combatSeconds);
      }
    } else {
      runtime.combatSeconds = (lt.initialCombatSec || 0) + elapsed;
    }
  }
  renderChronometer();
}

/* ==========================================================================
   SOLDIER & TEAM SYNCHRONIZATION HELPERS
   ========================================================================== */
function getTeamSoldiers(teamKey) {
  return state.soldiers.filter((s) => s.team === teamKey);
}

function syncAliveCountFromRoster(teamKey) {
  const teamSoldiers = getTeamSoldiers(teamKey);
  if (teamSoldiers.length > 0) {
    const aliveSoldiers = teamSoldiers.filter((s) => s.alive).length;
    state.teams[teamKey].aliveCount = aliveSoldiers;
  }
}

function resetAllSoldiersToAlive() {
  state.soldiers.forEach((s) => {
    s.alive = true;
  });
  const teamASoldiers = getTeamSoldiers('A');
  const teamBSoldiers = getTeamSoldiers('B');
  if (teamASoldiers.length > 0) {
    state.teams.A.aliveCount = teamASoldiers.length;
  }
  if (teamBSoldiers.length > 0) {
    state.teams.B.aliveCount = teamBSoldiers.length;
  }
}

function adjustTeamAliveCount(teamKey, delta) {
  if (!isHostOrLocal()) {
    showToast('🔒', 'Apenas o Juiz pode alterar o contador geral. Toque no seu nome ou botão acima!');
    return;
  }

  const current = state.teams[teamKey].aliveCount;
  const next = Math.max(0, current + delta);
  if (next === current) return;

  state.teams[teamKey].aliveCount = next;

  const teamSoldiers = getTeamSoldiers(teamKey);
  if (teamSoldiers.length > 0) {
    if (delta < 0) {
      const aliveList = teamSoldiers.filter((s) => s.alive);
      if (aliveList.length > next) {
        aliveList[aliveList.length - 1].alive = false;
      }
    } else if (delta > 0) {
      const kiaList = teamSoldiers.filter((s) => !s.alive);
      if (kiaList.length > 0 && teamSoldiers.filter((s) => s.alive).length < next) {
        kiaList[0].alive = true;
      }
    }
  }

  audioEngine.playTone(delta > 0 ? 880 : 340, 70, 'triangle', 0.18);
  saveState();
  renderAll();
  checkAutoEliminationTrigger(teamKey);
}

function toggleSoldierAliveInField(soldierId) {
  const soldier = state.soldiers.find((s) => s.id === soldierId);
  if (!soldier) return;

  // In PLAYER mode, participants can toggle their own soldier (or any soldier if not bound)
  if (
    cloudMeta.role === 'PLAYER' &&
    cloudMeta.mySoldierId &&
    soldier.id !== cloudMeta.mySoldierId
  ) {
    showToast('🪖', 'Você só pode alterar o status do seu próprio operador!');
    return;
  }

  soldier.alive = !soldier.alive;
  syncAliveCountFromRoster(soldier.team);

  audioEngine.playTone(soldier.alive ? 920 : 310, 80, 'triangle', 0.2);
  saveState();
  renderAll();
  checkAutoEliminationTrigger(soldier.team);
}

function checkAutoEliminationTrigger(teamKey) {
  if (!isHostOrLocal()) return;
  if (runtime.phase !== 'COMBAT') return;

  if (state.teams[teamKey].aliveCount === 0) {
    const teamName = state.teams[teamKey].name;
    finishMatchAndOpenVerification(`ELIMINAÇÃO TOTAL (${teamName} ZERADO)`, teamKey);
  }
}

/* ==========================================================================
   CHRONOMETER & MATCH STATE MACHINE (HOST AUTHORITY)
   ========================================================================== */
function formatMMSS(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function clearMatchInterval() {
  if (runtime.timerInterval) {
    clearInterval(runtime.timerInterval);
    runtime.timerInterval = null;
  }
}

function startMatchSequence() {
  if (!isHostOrLocal()) return;
  audioEngine.ensureContext();

  if (runtime.phase === 'IDLE') {
    const soldiersA = getTeamSoldiers('A');
    const soldiersB = getTeamSoldiers('B');
    if (soldiersA.length > 0 && state.teams.A.aliveCount === 0) {
      resetAllSoldiersToAlive();
    } else if (soldiersB.length > 0 && state.teams.B.aliveCount === 0) {
      resetAllSoldiersToAlive();
    }
  }

  requestWakeLock();

  if (state.settings.prepSeconds > 0) {
    runtime.phase = 'PREP';
    runtime.lastAnnouncedPhase = 'PREP';
    runtime.remainingPrepSec = state.settings.prepSeconds;
    syncRuntimeToLiveTimer();
    audioEngine.playDoubleBeep();
    saveState();
    renderAll();
    clearMatchInterval();
    runtime.timerInterval = setInterval(tickPrep, 1000);
  } else {
    enterCombatPhase();
  }
}

function tickPrep() {
  if (runtime.phase !== 'PREP') return;

  runtime.remainingPrepSec -= 1;

  if (runtime.remainingPrepSec <= 0) {
    enterCombatPhase();
    return;
  }

  if (runtime.remainingPrepSec > 10) {
    if (runtime.remainingPrepSec % 15 === 0) {
      audioEngine.playDoubleBeep();
    }
  } else if (runtime.remainingPrepSec >= 1 && runtime.remainingPrepSec <= 10) {
    audioEngine.playCountdownBeep(runtime.remainingPrepSec);
  }

  renderChronometer();
}

function enterCombatPhase() {
  if (!isHostOrLocal()) return;
  clearMatchInterval();
  runtime.phase = 'COMBAT';
  runtime.lastAnnouncedPhase = 'COMBAT';
  runtime.combatSeconds =
    state.settings.mode === 'TIME_LIMIT' ? state.settings.timeLimitMinutes * 60 : 0;

  syncRuntimeToLiveTimer();
  audioEngine.announceCombatStart();
  requestWakeLock();
  saveState();
  renderAll();

  runtime.timerInterval = setInterval(tickCombat, 1000);
}

function tickCombat() {
  if (runtime.phase !== 'COMBAT') return;

  if (state.settings.mode === 'TIME_LIMIT') {
    runtime.combatSeconds -= 1;

    if (runtime.combatSeconds <= 0) {
      runtime.combatSeconds = 0;
      renderChronometer();
      finishMatchAndOpenVerification('TEMPO ESGOTADO (00:00)', null);
      return;
    }

    if (runtime.combatSeconds <= 10 && runtime.combatSeconds >= 1) {
      audioEngine.playCountdownBeep(runtime.combatSeconds);
    }
  } else {
    runtime.combatSeconds += 1;
  }

  renderChronometer();
}

function togglePauseResumeMatch() {
  if (!isHostOrLocal()) return;

  if (runtime.phase === 'PREP' || runtime.phase === 'COMBAT') {
    runtime.pausedFrom = runtime.phase;
    runtime.phase = 'PAUSED';
    runtime.lastAnnouncedPhase = 'PAUSED';
    clearMatchInterval();
    releaseWakeLock();
    syncRuntimeToLiveTimer();
    audioEngine.playTone(440, 120, 'sine', 0.2);
    saveState();
    renderAll();
  } else if (runtime.phase === 'PAUSED') {
    runtime.phase = runtime.pausedFrom || 'COMBAT';
    runtime.lastAnnouncedPhase = runtime.phase;
    requestWakeLock();
    syncRuntimeToLiveTimer();
    audioEngine.playTone(660, 120, 'sine', 0.2);
    clearMatchInterval();
    if (runtime.phase === 'PREP') {
      runtime.timerInterval = setInterval(tickPrep, 1000);
    } else {
      runtime.timerInterval = setInterval(tickCombat, 1000);
    }
    saveState();
    renderAll();
  }
}

function resetChronometerToIdle() {
  if (!isHostOrLocal()) return;
  clearMatchInterval();
  runtime.phase = 'IDLE';
  runtime.lastAnnouncedPhase = 'IDLE';
  runtime.pausedFrom = null;
  runtime.remainingPrepSec = state.settings.prepSeconds;
  runtime.combatSeconds =
    state.settings.mode === 'TIME_LIMIT' ? state.settings.timeLimitMinutes * 60 : 0;
  releaseWakeLock();
  resetAllSoldiersToAlive();
  syncRuntimeToLiveTimer();
  saveState();
  renderAll();
}

/* ==========================================================================
   POST-MATCH VERIFICATION MODAL & WINNER CALCULATION
   ========================================================================== */
function finishMatchAndOpenVerification(
  reasonText = 'ENCERRAMENTO MANUAL PELO ÁRBITRO',
  eliminatedTeamKey = null
) {
  if (!isHostOrLocal()) return;

  clearMatchInterval();
  if (runtime.phase === 'PREP' || runtime.phase === 'COMBAT') {
    runtime.pausedFrom = runtime.phase;
  }
  runtime.phase = 'VERIFY';
  runtime.lastAnnouncedPhase = 'VERIFY';
  releaseWakeLock();
  syncRuntimeToLiveTimer();
  saveState();

  audioEngine.announceGameOver();

  const draftStatus = {};
  state.soldiers.forEach((s) => {
    if (eliminatedTeamKey && s.team === eliminatedTeamKey) {
      draftStatus[s.id] = false;
    } else if (state.teams[s.team].aliveCount === 0) {
      draftStatus[s.id] = false;
    } else {
      draftStatus[s.id] = Boolean(s.alive);
    }
  });

  const soldiersA = getTeamSoldiers('A');
  const soldiersB = getTeamSoldiers('B');

  let countA = eliminatedTeamKey === 'A' ? 0 : state.teams.A.aliveCount;
  let countB = eliminatedTeamKey === 'B' ? 0 : state.teams.B.aliveCount;

  if (soldiersA.length > 0) {
    countA = soldiersA.filter((s) => draftStatus[s.id]).length;
  }
  if (soldiersB.length > 0) {
    countB = soldiersB.filter((s) => draftStatus[s.id]).length;
  }

  runtime.verifyDraft = {
    reason: reasonText,
    eliminatedTeam: eliminatedTeamKey,
    countA,
    countB,
    soldiersStatus: draftStatus
  };

  renderVerificationModal();
  document.getElementById('modalVerification').classList.remove('hidden');
  renderAll();
}

function toggleVerifySoldier(soldierId) {
  const soldier = state.soldiers.find((s) => s.id === soldierId);
  if (!soldier) return;

  runtime.verifyDraft.soldiersStatus[soldierId] = !runtime.verifyDraft.soldiersStatus[soldierId];

  const teamSoldiers = getTeamSoldiers(soldier.team);
  const aliveCount = teamSoldiers.filter((s) => runtime.verifyDraft.soldiersStatus[s.id]).length;

  if (soldier.team === 'A') {
    runtime.verifyDraft.countA = aliveCount;
  } else {
    runtime.verifyDraft.countB = aliveCount;
  }

  audioEngine.playTone(
    runtime.verifyDraft.soldiersStatus[soldierId] ? 900 : 320,
    60,
    'triangle',
    0.18
  );
  renderVerificationModal();
}

function adjustVerifyTeamCount(teamKey, delta) {
  const prop = teamKey === 'A' ? 'countA' : 'countB';
  const next = Math.max(0, runtime.verifyDraft[prop] + delta);
  runtime.verifyDraft[prop] = next;

  const teamSoldiers = getTeamSoldiers(teamKey);
  if (teamSoldiers.length > 0) {
    if (delta < 0) {
      const aliveIds = teamSoldiers
        .filter((s) => runtime.verifyDraft.soldiersStatus[s.id])
        .map((s) => s.id);
      if (aliveIds.length > next) {
        runtime.verifyDraft.soldiersStatus[aliveIds[aliveIds.length - 1]] = false;
      }
    } else if (delta > 0) {
      const deadIds = teamSoldiers
        .filter((s) => !runtime.verifyDraft.soldiersStatus[s.id])
        .map((s) => s.id);
      const currentAlive = teamSoldiers.filter((s) => runtime.verifyDraft.soldiersStatus[s.id])
        .length;
      if (deadIds.length > 0 && currentAlive < next) {
        runtime.verifyDraft.soldiersStatus[deadIds[0]] = true;
      }
    }
  }

  renderVerificationModal();
}

function setVerifyTeamAll(teamKey, allAlive) {
  const teamSoldiers = getTeamSoldiers(teamKey);
  teamSoldiers.forEach((s) => {
    runtime.verifyDraft.soldiersStatus[s.id] = allAlive;
  });

  if (teamKey === 'A') {
    runtime.verifyDraft.countA = allAlive
      ? Math.max(teamSoldiers.length, state.teams.A.aliveCount || 1)
      : 0;
    if (teamSoldiers.length > 0 && allAlive) runtime.verifyDraft.countA = teamSoldiers.length;
  } else {
    runtime.verifyDraft.countB = allAlive
      ? Math.max(teamSoldiers.length, state.teams.B.aliveCount || 1)
      : 0;
    if (teamSoldiers.length > 0 && allAlive) runtime.verifyDraft.countB = teamSoldiers.length;
  }

  audioEngine.playTone(allAlive ? 960 : 280, 90, 'sawtooth', 0.2);
  renderVerificationModal();
}

function confirmMatchResultAndScore() {
  const { countA, countB, soldiersStatus } = runtime.verifyDraft;

  let winner = 'DRAW';
  if (countA > countB) {
    winner = 'A';
    state.teams.A.wins += 1;
  } else if (countB > countA) {
    winner = 'B';
    state.teams.B.wins += 1;
  } else {
    state.stats.draws += 1;
  }

  state.stats.totalMatches += 1;

  state.soldiers.forEach((s) => {
    if (!s.stats) {
      s.stats = { survived: 0, kia: 0, matches: 0 };
    }
    const survivedRound = Boolean(soldiersStatus[s.id]);
    s.stats.matches += 1;
    if (survivedRound) {
      s.stats.survived += 1;
    } else {
      s.stats.kia += 1;
    }
  });

  state.stats.history.push({
    round: state.stats.totalMatches,
    timestamp: new Date().toISOString(),
    winner,
    countA,
    countB
  });

  document.getElementById('modalVerification').classList.add('hidden');
  resetChronometerToIdle();

  const msg =
    winner === 'A'
      ? `Vitória de ${state.teams.A.name} confirmada (+1 Ponto)!`
      : winner === 'B'
      ? `Vitória de ${state.teams.B.name} confirmada (+1 Ponto)!`
      : 'Empate Tático registrado! Pronto para o próximo round.';
  showToast('🏆', msg);
}

/* ==========================================================================
   ROSTER MANAGEMENT (ALISTAMENTO & EQUILIBRAR TIMES)
   ========================================================================== */
function addSoldier(nameRaw, teamKey, bindToCurrentDevice = false) {
  const name = (nameRaw || '').trim().toUpperCase();
  if (!name) return;

  const newSoldier = {
    id: 'op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name,
    team: teamKey === 'B' ? 'B' : 'A',
    alive: true,
    stats: {
      survived: 0,
      kia: 0,
      matches: 0
    }
  };

  state.soldiers.push(newSoldier);
  if (bindToCurrentDevice || (cloudMeta.role === 'PLAYER' && !cloudMeta.mySoldierId)) {
    cloudMeta.mySoldierId = newSoldier.id;
    saveCloudMeta();
  }

  syncAliveCountFromRoster(newSoldier.team);
  saveState();
  renderAll();
  renderRosterModal();

  const input = document.getElementById('inputSoldierName');
  if (input) {
    input.value = '';
    input.focus();
  }
}

function switchSoldierTeam(soldierId) {
  const soldier = state.soldiers.find((s) => s.id === soldierId);
  if (!soldier) return;

  soldier.team = soldier.team === 'A' ? 'B' : 'A';
  soldier.alive = true;

  syncAliveCountFromRoster('A');
  syncAliveCountFromRoster('B');
  saveState();
  renderAll();
  renderRosterModal();
}

function deleteSoldier(soldierId) {
  const soldier = state.soldiers.find((s) => s.id === soldierId);
  if (!soldier) return;
  const oldTeam = soldier.team;

  state.soldiers = state.soldiers.filter((s) => s.id !== soldierId);
  if (cloudMeta.mySoldierId === soldierId) {
    cloudMeta.mySoldierId = null;
    saveCloudMeta();
  }

  const remainingInTeam = getTeamSoldiers(oldTeam);
  state.teams[oldTeam].aliveCount = remainingInTeam.filter((s) => s.alive).length;

  saveState();
  renderAll();
  renderRosterModal();
}

function shuffleAndBalanceTeams() {
  if (!isHostOrLocal()) {
    showToast('🔒', 'Apenas o Juiz pode sortear os times da sessão!');
    return;
  }
  if (state.soldiers.length < 2) {
    showToast('⚠️', 'Cadastre pelo menos 2 soldados para sortear os times!');
    return;
  }

  const shuffled = [...state.soldiers];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  shuffled.forEach((s, idx) => {
    s.team = idx % 2 === 0 ? 'A' : 'B';
    s.alive = true;
  });

  state.soldiers = shuffled;
  syncAliveCountFromRoster('A');
  syncAliveCountFromRoster('B');
  saveState();
  renderAll();
  renderRosterModal();
  audioEngine.playDoubleBeep();
  showToast('🎲', 'Times sorteados e equilibrados automaticamente!');
}

/* ==========================================================================
   HALL OF FAME & WHATSAPP REPORT GENERATOR
   ========================================================================== */
function getSortedSoldiersForRanking() {
  return [...state.soldiers].sort((a, b) => {
    const survA = a.stats?.survived || 0;
    const survB = b.stats?.survived || 0;
    if (survB !== survA) return survB - survA;

    const rateA = (a.stats?.matches || 0) > 0 ? survA / a.stats.matches : 0;
    const rateB = (b.stats?.matches || 0) > 0 ? survB / b.stats.matches : 0;
    if (rateB !== rateA) return rateB - rateA;

    const kiaA = a.stats?.kia || 0;
    const kiaB = b.stats?.kia || 0;
    return kiaA - kiaB;
  });
}

function copyWhatsappReport() {
  const dateStr = new Date().toLocaleDateString('pt-BR');
  const teamA = state.teams.A;
  const teamB = state.teams.B;
  const ranked = getSortedSoldiersForRanking();

  let lines = [];
  lines.push(`🎯 *RELATÓRIO TÁTICO DE COMBATE* (${dateStr})`);
  if (cloudMeta.sessionCode) {
    lines.push(`☁️ *Sessão:* #${cloudMeta.sessionCode}`);
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`📊 *Partidas Realizadas:* ${state.stats.totalMatches}`);
  lines.push(`🏆 *PLACAR DE ESQUADRÕES:*`);
  lines.push(`🔹 *${teamA.name}:* ${teamA.wins} vitórias`);
  lines.push(`🔸 *${teamB.name}:* ${teamB.wins} vitórias`);
  if (state.stats.draws > 0) {
    lines.push(`⚖️ *Empates Táticos:* ${state.stats.draws}`);
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🎖️ *HALL OF FAME — SOBREVIVÊNCIA:*`);

  if (ranked.length === 0) {
    lines.push(`_(Nenhum operador nominal cadastrado)_`);
  } else {
    ranked.forEach((s, idx) => {
      const surv = s.stats?.survived || 0;
      const kia = s.stats?.kia || 0;
      const matches = s.stats?.matches || 0;
      const rate = matches > 0 ? Math.round((surv / matches) * 100) : 0;
      const tName = s.team === 'A' ? teamA.name : teamB.name;
      const medal =
        idx === 0 && surv > 0 ? '🥇 [IMORTAL]' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}º`;
      lines.push(
        `${medal} *${s.name}* (${tName}) — 🛡️ ${surv}x Vivo | 💀 ${kia} KIA | 📈 ${rate}% (${matches}j)`
      );
    });
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`⚡ _Gerado via Tactical Command PWA_`);

  const text = lines.join('\n');
  navigator.clipboard
    .writeText(text)
    .then(() => {
      showToast('📋', 'Relatório copiado! Pronto para colar no WhatsApp.');
    })
    .catch(() => {
      showToast('⚠️', 'Não foi possível copiar automaticamente.');
    });
}

/* ==========================================================================
   UI RENDERING FUNCTIONS
   ========================================================================== */
function renderCloudStatusAndPlayerHud() {
  const pill = document.getElementById('activeSessionPill');
  const pillCode = document.getElementById('activeSessionCodeText');
  const pillRole = document.getElementById('activeSessionRoleBadge');
  const headerCloudStatus = document.getElementById('headerCloudStatus');
  const playerHud = document.getElementById('playerHudBanner');
  const hostChronoControls = document.getElementById('hostChronoControls');
  const guestChronoNotice = document.getElementById('guestChronoNotice');
  const timerConfigPanel = document.getElementById('timerConfigPanel');
  const modeSelectorBox = document.getElementById('modeSelectorBox');

  if (cloudMeta.sessionCode) {
    pill.classList.remove('hidden');
    pill.classList.add('inline-flex');
    pillCode.textContent = `SALA: ${cloudMeta.sessionCode}`;
    pillRole.textContent = cloudMeta.role === 'HOST' ? 'JUIZ' : 'OPERADOR';
    headerCloudStatus.textContent = cloudMeta.sessionCode;
    headerCloudStatus.className =
      'px-1.5 py-0.5 text-[10px] font-tactical-mono rounded bg-lime-400 text-zinc-950 font-black';
  } else {
    pill.classList.add('hidden');
    pill.classList.remove('inline-flex');
    headerCloudStatus.textContent = 'LOCAL';
    headerCloudStatus.className =
      'px-1.5 py-0.5 text-[10px] font-tactical-mono rounded bg-zinc-950 text-sky-300 border border-sky-500/40';
  }

  // Toggle Host vs Participant UI privileges
  if (isHostOrLocal()) {
    hostChronoControls.classList.remove('hidden');
    guestChronoNotice.classList.add('hidden');
    modeSelectorBox.classList.remove('pointer-events-none', 'opacity-70');
    document.getElementById('controlsAliveTeamA').classList.remove('opacity-50');
    document.getElementById('controlsAliveTeamB').classList.remove('opacity-50');
  } else {
    hostChronoControls.classList.add('hidden');
    guestChronoNotice.classList.remove('hidden');
    timerConfigPanel.classList.add('opacity-50', 'pointer-events-none');
    modeSelectorBox.classList.add('pointer-events-none', 'opacity-70');
    document.getElementById('controlsAliveTeamA').classList.add('opacity-50');
    document.getElementById('controlsAliveTeamB').classList.add('opacity-50');
  }

  // Render Operator Self-Control HUD when soldier is bound
  const mySoldier = state.soldiers.find((s) => s.id === cloudMeta.mySoldierId);
  if (mySoldier && cloudMeta.sessionCode) {
    playerHud.classList.remove('hidden');
    document.getElementById('playerHudSessionCode').textContent = `#${cloudMeta.sessionCode}`;
    document.getElementById('playerHudName').textContent = mySoldier.name;

    const teamObj = state.teams[mySoldier.team];
    const teamBadge = document.getElementById('playerHudTeamBadge');
    teamBadge.textContent = `ESQUADRÃO ${teamObj.name}`;
    teamBadge.className = `text-[11px] font-tactical-mono font-black uppercase px-2 py-0.5 rounded text-white ${
      mySoldier.team === 'A' ? 'bg-blue-600' : 'bg-red-600'
    }`;

    const avatar = document.getElementById('playerHudAvatar');
    const statusLbl = document.getElementById('playerHudStatusLabel');
    const toggleBtn = document.getElementById('btnPlayerSelfToggleStatus');

    if (mySoldier.alive) {
      avatar.textContent = '🛡️';
      avatar.className =
        'w-14 h-14 rounded-2xl bg-lime-500/20 border-2 border-lime-400 flex items-center justify-center text-3xl shrink-0';
      statusLbl.textContent = 'STATUS ATUAL: EM COMBATE (VIVO)';
      statusLbl.className = 'text-xs sm:text-sm font-extrabold uppercase tracking-wider text-lime-400';
      toggleBtn.innerHTML = '💀 FUI ATINGIDO! (MARCAR K.I.A.)';
      toggleBtn.className =
        'btn-tactical min-h-[68px] px-6 sm:px-8 bg-red-600 hover:bg-red-500 text-white text-base sm:text-xl font-black shadow-[0_0_25px_rgba(220,38,38,0.5)]';
    } else {
      avatar.textContent = '💀';
      avatar.className =
        'w-14 h-14 rounded-2xl bg-red-500/20 border-2 border-red-500 flex items-center justify-center text-3xl shrink-0';
      statusLbl.textContent = 'STATUS ATUAL: FORA DE COMBATE (K.I.A. / MORTO)';
      statusLbl.className = 'text-xs sm:text-sm font-extrabold uppercase tracking-wider text-red-400';
      toggleBtn.innerHTML = '🛡️ VOLTAR AO COMBATE (MARCAR VIVO)';
      toggleBtn.className =
        'btn-tactical min-h-[68px] px-6 sm:px-8 bg-lime-500 hover:bg-lime-400 text-zinc-950 text-base sm:text-xl font-black shadow-[0_0_25px_rgba(163,230,53,0.4)]';
    }
  } else {
    playerHud.classList.add('hidden');
  }
}

function renderCloudModal() {
  const activeBox = document.getElementById('cloudActiveRoomBox');
  const joinCreateGrid = document.getElementById('cloudJoinCreateGrid');

  document.getElementById('inputSupabaseUrl').value = cloudMeta.supabaseUrl || '';
  document.getElementById('inputSupabaseKey').value = cloudMeta.supabaseKey || '';

  // Update team button labels in Join card
  const btnJoinA = document.getElementById('btnSelectJoinTeamA');
  const btnJoinB = document.getElementById('btnSelectJoinTeamB');
  btnJoinA.textContent = `🛡️ TIME A (${state.teams.A.name})`;
  btnJoinB.textContent = `⚔️ TIME B (${state.teams.B.name})`;

  if (cloudMeta.joinSelectedTeam === 'B') {
    btnJoinB.className =
      'min-h-[46px] rounded-xl border-2 border-red-500 bg-red-600/25 text-white font-black text-xs uppercase tracking-wider';
    btnJoinA.className =
      'min-h-[46px] rounded-xl border-2 border-zinc-700 bg-zinc-900 text-zinc-400 font-black text-xs uppercase tracking-wider';
  } else {
    btnJoinA.className =
      'min-h-[46px] rounded-xl border-2 border-blue-500 bg-blue-600/25 text-white font-black text-xs uppercase tracking-wider';
    btnJoinB.className =
      'min-h-[46px] rounded-xl border-2 border-zinc-700 bg-zinc-900 text-zinc-400 font-black text-xs uppercase tracking-wider';
  }

  if (cloudMeta.sessionCode) {
    activeBox.classList.remove('hidden');
    document.getElementById('cloudModalRoomCode').textContent = cloudMeta.sessionCode;
    document.getElementById('cloudModalRoleBadge').textContent =
      cloudMeta.role === 'HOST' ? '👑 JUIZ (ANFITRIÃO)' : '🪖 OPERADOR CONECTADO';
  } else {
    activeBox.classList.add('hidden');
  }

  initSupabaseClient();
}

function renderColorPickers() {
  ['A', 'B'].forEach((teamKey) => {
    const container = document.getElementById(`colorPickerTeam${teamKey}`);
    const activeColor = state.teams[teamKey].color;
    container.innerHTML = '';

    TACTICAL_COLORS.forEach((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `color-dot ${activeColor === c.id ? 'active' : ''}`;
      btn.style.backgroundColor = c.hex;
      btn.style.color = c.hex;
      btn.title = `Cor ${c.label}`;
      btn.addEventListener('click', () => {
        if (!isHostOrLocal()) return;
        state.teams[teamKey].color = c.id;
        saveState();
        renderAll();
      });
      container.appendChild(btn);
    });
  });
}

function renderTeamPanels() {
  ['A', 'B'].forEach((teamKey) => {
    const team = state.teams[teamKey];
    const panel = document.getElementById(`panelTeam${teamKey}`);

    TACTICAL_COLORS.forEach((c) => panel.classList.remove(`theme-${c.id}`));
    panel.classList.add(`theme-${team.color}`);

    const nameInput = document.getElementById(`inputTeam${teamKey}Name`);
    nameInput.readOnly = !isHostOrLocal();
    if (document.activeElement !== nameInput) {
      nameInput.value = team.name;
    }
    document.getElementById(`scoreTeam${teamKey}`).textContent = team.wins;
    document.getElementById(`aliveCountTeam${teamKey}`).textContent = team.aliveCount;

    const teamSoldiers = getTeamSoldiers(teamKey);
    const aliveInRoster = teamSoldiers.filter((s) => s.alive).length;
    document.getElementById(`rosterSummaryTeam${teamKey}`).textContent =
      `(${aliveInRoster}/${teamSoldiers.length} VIVOS)`;

    const badgesContainer = document.getElementById(`soldierBadgesTeam${teamKey}`);
    badgesContainer.innerHTML = '';

    if (teamSoldiers.length === 0) {
      badgesContainer.innerHTML = `
        <div class="w-full py-3 px-3 rounded-xl border border-dashed border-zinc-800 text-zinc-500 text-xs font-semibold text-center">
          Nenhum operador alistado no ${escapeHtml(team.name)}. Use os botões (-) e (+) acima ou cadastre operadores em 🪖 ALISTAMENTO.
        </div>
      `;
    } else {
      teamSoldiers.forEach((s) => {
        const isMe = s.id === cloudMeta.mySoldierId;
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = `soldier-badge ${s.alive ? 'soldier-alive' : 'soldier-kia'} ${
          isMe ? 'ring-2 ring-sky-400' : ''
        }`;
        badge.innerHTML = `
          <span>${s.alive ? '🛡️' : '💀'}</span>
          <span>${escapeHtml(s.name)}${isMe ? ' (VOCÊ)' : ''}</span>
          <span class="text-[10px] font-tactical-mono uppercase px-1.5 py-0.5 rounded bg-black/40">
            ${s.alive ? 'VIVO' : 'K.I.A.'}
          </span>
        `;
        badge.addEventListener('click', () => toggleSoldierAliveInField(s.id));
        badgesContainer.appendChild(badge);
      });
    }
  });

  document.getElementById('headerRosterCount').textContent = state.soldiers.length;
  document.getElementById('headerMatchesCount').textContent = state.stats.totalMatches;
  document.getElementById('matchRoundBadge').textContent = `ROUND #${state.stats.totalMatches + 1}`;
}

function renderChronometer() {
  const modeBtnTime = document.getElementById('btnModeTimeLimit');
  const modeBtnElim = document.getElementById('btnModeElimination');
  const durationConfigBox = document.getElementById('durationConfigBox');

  if (state.settings.mode === 'TIME_LIMIT') {
    modeBtnTime.className =
      'min-h-[52px] rounded-lg font-black text-xs sm:text-sm uppercase tracking-wider px-3 py-2 transition flex flex-col items-center justify-center gap-0.5 bg-lime-400 text-zinc-950 shadow';
    modeBtnElim.className =
      'min-h-[52px] rounded-lg font-black text-xs sm:text-sm uppercase tracking-wider px-3 py-2 transition flex flex-col items-center justify-center gap-0.5 bg-zinc-900 text-zinc-300 hover:text-white';
    durationConfigBox.classList.remove('opacity-40', 'pointer-events-none');
  } else {
    modeBtnElim.className =
      'min-h-[52px] rounded-lg font-black text-xs sm:text-sm uppercase tracking-wider px-3 py-2 transition flex flex-col items-center justify-center gap-0.5 bg-amber-500 text-zinc-950 shadow';
    modeBtnTime.className =
      'min-h-[52px] rounded-lg font-black text-xs sm:text-sm uppercase tracking-wider px-3 py-2 transition flex flex-col items-center justify-center gap-0.5 bg-zinc-900 text-zinc-300 hover:text-white';
    durationConfigBox.classList.add('opacity-40', 'pointer-events-none');
  }

  document.getElementById('lblConfigMinutes').textContent = `${state.settings.timeLimitMinutes} MIN`;
  document.getElementById('lblConfigPrep').textContent =
    state.settings.prepSeconds === 0 ? 'OFF (0s)' : `${state.settings.prepSeconds}s`;

  const chronoBox = document.getElementById('chronoDisplayBox');
  const stateBanner = document.getElementById('combatStateBanner');
  const stateDot = document.getElementById('combatStateDot');
  const stateText = document.getElementById('combatStateText');
  const prepAlertBanner = document.getElementById('prepAlertBanner');
  const mainDigits = document.getElementById('mainTimerDigits');
  const subLabel = document.getElementById('timerSubLabel');
  const btnSkipPrep = document.getElementById('btnSkipPrep');
  const btnStart = document.getElementById('btnStartMatch');
  const btnPauseResume = document.getElementById('btnPauseResumeMatch');
  const configPanel = document.getElementById('timerConfigPanel');

  chronoBox.classList.remove('timer-panel-prep', 'timer-panel-combat', 'timer-panel-danger');
  prepAlertBanner.classList.add('hidden');
  btnSkipPrep.classList.add('hidden');

  if (runtime.phase === 'IDLE') {
    if (isHostOrLocal()) {
      configPanel.classList.remove('opacity-50', 'pointer-events-none');
    }
    btnStart.classList.remove('hidden');
    btnPauseResume.classList.add('hidden');

    stateBanner.className =
      'inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-zinc-900 border border-zinc-700 text-zinc-300 text-xs sm:text-sm font-black uppercase tracking-widest mb-2';
    stateDot.className = 'w-2.5 h-2.5 rounded-full bg-lime-400';
    stateText.textContent = 'PRONTO PARA INICIAR';

    const displaySec =
      state.settings.mode === 'TIME_LIMIT' ? state.settings.timeLimitMinutes * 60 : 0;
    mainDigits.textContent = formatMMSS(displaySec);
    mainDigits.className =
      'text-6xl sm:text-7xl xl:text-8xl font-tactical-mono font-black tracking-tight text-lime-400 my-1 leading-none select-none';

    subLabel.textContent =
      state.settings.mode === 'TIME_LIMIT'
        ? `MODO TEMPO LIMITE (${state.settings.timeLimitMinutes} MIN) • PREPARAÇÃO: ${state.settings.prepSeconds}S`
        : `MODO ELIMINATION (PROGRESSIVO) • PREPARAÇÃO: ${state.settings.prepSeconds}S`;
  } else if (runtime.phase === 'PREP') {
    configPanel.classList.add('opacity-50', 'pointer-events-none');
    btnStart.classList.add('hidden');
    btnPauseResume.classList.remove('hidden');
    btnPauseResume.innerHTML = '⏸️ PAUSAR PREPARAÇÃO';

    chronoBox.classList.add('timer-panel-prep');
    prepAlertBanner.classList.remove('hidden');
    if (isHostOrLocal()) {
      btnSkipPrep.classList.remove('hidden');
    }

    stateBanner.className =
      'inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-amber-500/20 border border-amber-400 text-amber-300 text-xs sm:text-sm font-black uppercase tracking-widest mb-2';
    stateDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping';
    stateText.textContent = 'FASE DE POSICIONAMENTO';

    mainDigits.textContent = formatMMSS(runtime.remainingPrepSec);
    mainDigits.className =
      'text-6xl sm:text-7xl xl:text-8xl font-tactical-mono font-black tracking-tight text-amber-400 my-1 leading-none select-none';
    subLabel.textContent = 'CONTAGEM REGRESSIVA PARA INÍCIO DO COMBATE';
  } else if (runtime.phase === 'COMBAT') {
    configPanel.classList.add('opacity-50', 'pointer-events-none');
    btnStart.classList.add('hidden');
    btnPauseResume.classList.remove('hidden');
    btnPauseResume.innerHTML = '⏸️ PAUSAR COMBATE';

    const isFinalTen = state.settings.mode === 'TIME_LIMIT' && runtime.combatSeconds <= 10;

    if (isFinalTen) {
      chronoBox.classList.add('timer-panel-danger');
      mainDigits.className =
        'text-6xl sm:text-7xl xl:text-8xl font-tactical-mono font-black tracking-tight text-red-400 my-1 leading-none select-none';
    } else {
      chronoBox.classList.add('timer-panel-combat');
      mainDigits.className =
        'text-6xl sm:text-7xl xl:text-8xl font-tactical-mono font-black tracking-tight text-lime-400 my-1 leading-none select-none';
    }

    stateBanner.className =
      'inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-lime-500/20 border border-lime-400 text-lime-300 text-xs sm:text-sm font-black uppercase tracking-widest mb-2';
    stateDot.className = 'w-2.5 h-2.5 rounded-full bg-lime-400 animate-ping';
    stateText.textContent = '🔥 EM COMBATE ATIVO 🔥';

    mainDigits.textContent = formatMMSS(runtime.combatSeconds);
    subLabel.textContent =
      state.settings.mode === 'TIME_LIMIT'
        ? 'TEMPO RESTANTE DE OPERAÇÃO'
        : 'TEMPO DECORRIDO DE OPERAÇÃO (MATA-MATA)';
  } else if (runtime.phase === 'PAUSED' || runtime.phase === 'VERIFY') {
    configPanel.classList.add('opacity-50', 'pointer-events-none');
    btnStart.classList.add('hidden');
    btnPauseResume.classList.remove('hidden');
    btnPauseResume.innerHTML = '▶️ RETOMAR OPERAÇÃO';

    stateBanner.className =
      'inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-amber-500/20 border border-amber-400 text-amber-300 text-xs sm:text-sm font-black uppercase tracking-widest mb-2';
    stateDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400';
    stateText.textContent =
      runtime.phase === 'VERIFY' ? '📋 EM CONFERÊNCIA DE FIM DE JOGO' : '⏸️ PARTIDA PAUSADA';

    const sec =
      runtime.pausedFrom === 'PREP' ? runtime.remainingPrepSec : runtime.combatSeconds;
    mainDigits.textContent = formatMMSS(sec);
    mainDigits.className =
      'text-6xl sm:text-7xl xl:text-8xl font-tactical-mono font-black tracking-tight text-amber-300 my-1 leading-none select-none';
    subLabel.textContent = 'CRONÔMETRO CONGELADO PELO JUIZ';
  }
}

function renderAudioButton() {
  const icon = document.getElementById('muteIcon');
  const label = document.getElementById('muteLabel');
  const btn = document.getElementById('btnToggleMute');

  if (state.settings.muted) {
    icon.textContent = '🔇';
    label.textContent = 'MUDO';
    btn.className =
      'px-3 py-2.5 min-h-[46px] rounded-xl bg-red-950/60 hover:bg-red-900/60 active:scale-95 border border-red-700 text-red-300 font-bold text-xs sm:text-sm uppercase tracking-wider flex items-center justify-center gap-1.5 transition';
  } else {
    icon.textContent = '🔊';
    label.textContent = 'SOM ON';
    btn.className =
      'px-3 py-2.5 min-h-[46px] rounded-xl bg-zinc-950 hover:bg-zinc-800 active:scale-95 border border-zinc-700 text-lime-400 font-bold text-xs sm:text-sm uppercase tracking-wider flex items-center justify-center gap-1.5 transition';
  }
}

function renderRosterModal() {
  document.getElementById('lblRosterBtnTeamA').textContent = state.teams.A.name;
  document.getElementById('lblRosterBtnTeamB').textContent = state.teams.B.name;
  document.getElementById('rosterHeaderTeamA').textContent = state.teams.A.name;
  document.getElementById('rosterHeaderTeamB').textContent = state.teams.B.name;
  document.getElementById('rosterTotalCount').textContent = state.soldiers.length;

  ['A', 'B'].forEach((teamKey) => {
    const listEl = document.getElementById(`rosterListTeam${teamKey}`);
    const countEl = document.getElementById(`rosterCountTeam${teamKey}`);
    const soldiers = getTeamSoldiers(teamKey);

    countEl.textContent = `${soldiers.length} SOLDADO${soldiers.length === 1 ? '' : 'S'}`;
    listEl.innerHTML = '';

    if (soldiers.length === 0) {
      listEl.innerHTML = `
        <div class="py-6 text-center text-xs text-zinc-500 border border-dashed border-zinc-800 rounded-xl">
          Nenhum operador cadastrado neste time.
        </div>
      `;
      return;
    }

    soldiers.forEach((s) => {
      const isMe = s.id === cloudMeta.mySoldierId;
      const canModify = isHostOrLocal() || isMe;
      const row = document.createElement('div');
      row.className =
        'flex items-center justify-between gap-2 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2';
      row.innerHTML = `
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-base">🪖</span>
          <span class="font-bold text-sm text-white truncate">${escapeHtml(s.name)}${
        isMe ? ' <span class="text-sky-400 text-xs">(VOCÊ)</span>' : ''
      }</span>
        </div>
        <div class="flex items-center gap-1.5 shrink-0 ${canModify ? '' : 'opacity-40 pointer-events-none'}">
          <button
            type="button"
            data-switch-id="${s.id}"
            title="Transferir para outro time"
            class="min-h-[42px] px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-amber-300 font-black text-xs uppercase flex items-center gap-1"
          >
            ⇄ TROCAR
          </button>
          <button
            type="button"
            data-delete-id="${s.id}"
            title="Excluir operador"
            class="min-h-[42px] min-w-[42px] rounded-lg bg-red-950/60 hover:bg-red-900 border border-red-800 text-red-300 font-black text-sm flex items-center justify-center"
          >
            ✕
          </button>
        </div>
      `;
      row.querySelector('[data-switch-id]').addEventListener('click', () => switchSoldierTeam(s.id));
      row.querySelector('[data-delete-id]').addEventListener('click', () => deleteSoldier(s.id));
      listEl.appendChild(row);
    });
  });
}

function renderVerificationModal() {
  const { reason, countA, countB, soldiersStatus } = runtime.verifyDraft;
  const teamA = state.teams.A;
  const teamB = state.teams.B;

  document.getElementById('verifyReasonBadge').textContent = reason;
  document.getElementById('verifyNameTeamA').textContent = teamA.name;
  document.getElementById('verifyNameTeamB').textContent = teamB.name;
  document.getElementById('verifyCountTeamA').textContent = countA;
  document.getElementById('verifyCountTeamB').textContent = countB;

  const banner = document.getElementById('verifyWinnerBanner');
  const title = document.getElementById('verifyWinnerTitle');
  const subtitle = document.getElementById('verifyWinnerSubtitle');

  if (countA > countB) {
    banner.className = 'bg-zinc-950 border-2 border-lime-400 rounded-2xl p-4 text-center shadow-lg';
    title.className = 'text-2xl sm:text-4xl font-black uppercase tracking-wider text-lime-400 mt-1';
    title.textContent = `🏆 VITÓRIA: ${teamA.name}`;
    subtitle.textContent = `${countA} sobrevivente(s) contra ${countB} de ${teamB.name}`;
  } else if (countB > countA) {
    banner.className = 'bg-zinc-950 border-2 border-lime-400 rounded-2xl p-4 text-center shadow-lg';
    title.className = 'text-2xl sm:text-4xl font-black uppercase tracking-wider text-lime-400 mt-1';
    title.textContent = `🏆 VITÓRIA: ${teamB.name}`;
    subtitle.textContent = `${countB} sobrevivente(s) contra ${countA} de ${teamA.name}`;
  } else {
    banner.className = 'bg-zinc-950 border-2 border-amber-400 rounded-2xl p-4 text-center shadow-lg';
    title.className = 'text-2xl sm:text-4xl font-black uppercase tracking-wider text-amber-400 mt-1';
    title.textContent = '⚖️ EMPATE TÁTICO';
    subtitle.textContent = `Ambos os esquadrões terminaram com ${countA} sobrevivente(s)`;
  }

  ['A', 'B'].forEach((teamKey) => {
    const container = document.getElementById(`verifySoldiersTeam${teamKey}`);
    const soldiers = getTeamSoldiers(teamKey);
    container.innerHTML = '';

    if (soldiers.length === 0) {
      container.innerHTML = `
        <div class="py-4 px-3 rounded-xl border border-dashed border-zinc-800 text-center text-xs text-zinc-500">
          Sem soldados nominais alistados neste time. Utilize os controles numéricos (+) e (−) acima.
        </div>
      `;
      return;
    }

    soldiers.forEach((s) => {
      const survived = Boolean(soldiersStatus[s.id]);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `w-full min-h-[54px] px-4 py-2.5 rounded-xl border-2 flex items-center justify-between font-bold text-sm transition ${
        survived
          ? 'bg-lime-500/15 border-lime-400 text-white'
          : 'bg-red-950/40 border-red-700/80 text-red-300 opacity-85'
      }`;
      btn.innerHTML = `
        <span class="truncate font-extrabold uppercase">${escapeHtml(s.name)}</span>
        <span class="px-2.5 py-1 rounded-lg font-tactical-mono text-xs font-black ${
          survived ? 'bg-lime-400 text-zinc-950' : 'bg-red-600 text-white'
        }">
          ${survived ? '🛡️ SOBREVIVEU' : '💀 MORREU (K.I.A.)'}
        </span>
      `;
      btn.addEventListener('click', () => toggleVerifySoldier(s.id));
      container.appendChild(btn);
    });
  });
}

function renderReportModal() {
  document.getElementById('reportTotalMatches').textContent = state.stats.totalMatches;
  document.getElementById('reportTeamALabel').textContent = `VITÓRIAS ${state.teams.A.name}`;
  document.getElementById('reportTeamBLabel').textContent = `VITÓRIAS ${state.teams.B.name}`;
  document.getElementById('reportTeamAWins').textContent = state.teams.A.wins;
  document.getElementById('reportTeamBWins').textContent = state.teams.B.wins;

  const tbody = document.getElementById('reportRankingBody');
  tbody.innerHTML = '';

  const ranked = getSortedSoldiersForRanking();

  if (ranked.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="py-8 text-center text-zinc-500 font-semibold">
          Nenhum soldado alistado ainda. Cadastre operadores em 🪖 ALISTAMENTO para rastrear o Hall of Fame!
        </td>
      </tr>
    `;
    return;
  }

  ranked.forEach((s, index) => {
    const survived = s.stats?.survived || 0;
    const kia = s.stats?.kia || 0;
    const matches = s.stats?.matches || 0;
    const rate = matches > 0 ? Math.round((survived / matches) * 100) : 0;
    const isImmortal = index === 0 && survived > 0;
    const teamName = s.team === 'A' ? state.teams.A.name : state.teams.B.name;

    const tr = document.createElement('tr');
    tr.className = isImmortal
      ? 'bg-amber-500/10 border-l-4 border-l-amber-400'
      : 'hover:bg-zinc-900/50';

    let posBadge = `<span class="font-tactical-mono font-bold text-zinc-400">#${index + 1}</span>`;
    if (isImmortal) {
      posBadge = `
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-400 text-zinc-950 font-black text-xs uppercase shadow">
          🥇 IMORTAL
        </span>
      `;
    } else if (index === 1 && survived > 0) {
      posBadge = `<span class="font-bold text-zinc-200">🥈 #2</span>`;
    } else if (index === 2 && survived > 0) {
      posBadge = `<span class="font-bold text-amber-600">🥉 #3</span>`;
    }

    tr.innerHTML = `
      <td class="py-3.5 px-3 sm:px-4 whitespace-nowrap">${posBadge}</td>
      <td class="py-3.5 px-3 sm:px-4 font-black uppercase text-white">${escapeHtml(s.name)}</td>
      <td class="py-3.5 px-3 sm:px-4 font-bold text-xs uppercase text-zinc-300">${escapeHtml(teamName)}</td>
      <td class="py-3.5 px-3 sm:px-4 text-center font-tactical-mono font-black text-lime-400 text-base">${survived}</td>
      <td class="py-3.5 px-3 sm:px-4 text-center font-tactical-mono font-bold text-red-400">${kia}</td>
      <td class="py-3.5 px-3 sm:px-4 text-center font-tactical-mono text-zinc-300">${matches}</td>
      <td class="py-3.5 px-3 sm:px-4">
        <div class="flex items-center gap-2">
          <div class="flex-1 h-2.5 bg-zinc-800 rounded-full overflow-hidden">
            <div class="h-full ${isImmortal ? 'bg-amber-400' : 'bg-lime-400'}" style="width: ${rate}%"></div>
          </div>
          <span class="font-tactical-mono font-bold text-xs w-10 text-right text-zinc-200">${rate}%</span>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderAll() {
  renderCloudStatusAndPlayerHud();
  renderColorPickers();
  renderTeamPanels();
  renderChronometer();
  renderAudioButton();
}

/* ==========================================================================
   UTILITIES & TOAST
   ========================================================================== */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let toastTimeout = null;
function showToast(icon, message) {
  const toast = document.getElementById('tacticalToast');
  document.getElementById('toastIcon').textContent = icon;
  document.getElementById('toastMessage').textContent = message;
  toast.classList.remove('hidden');

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3400);
}

/* ==========================================================================
   PWA SERVICE WORKER & BEFOREINSTALLPROMPT
   ========================================================================== */
let deferredInstallPrompt = null;

function initPWA() {
  const pwaBadge = document.getElementById('pwaStatusBadge');
  const btnInstall = document.getElementById('btnInstallPwa');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('./sw.js')
        .then(() => {
          pwaBadge.innerHTML = '🟢 PRONTO OFFLINE';
        })
        .catch(() => {
          pwaBadge.innerHTML = '🟢 MODO LOCAL ATIVO';
        });
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    btnInstall.classList.remove('hidden');
    pwaBadge.innerHTML = '📲 INSTALAR APP';
  });

  btnInstall.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      btnInstall.classList.add('hidden');
      pwaBadge.innerHTML = '🟢 APP INSTALADO';
      showToast('📲', 'Aplicativo Tático instalado com sucesso!');
    }
    deferredInstallPrompt = null;
  });

  window.addEventListener('appinstalled', () => {
    btnInstall.classList.add('hidden');
    pwaBadge.innerHTML = '🟢 PRONTO OFFLINE';
  });
}

/* ==========================================================================
   EVENT LISTENERS INITIALIZATION
   ========================================================================== */
function bindEvents() {
  // Team Name Inputs
  ['A', 'B'].forEach((teamKey) => {
    const input = document.getElementById(`inputTeam${teamKey}Name`);
    input.addEventListener('input', (e) => {
      if (!isHostOrLocal()) return;
      state.teams[teamKey].name =
        e.target.value.toUpperCase() || (teamKey === 'A' ? 'ALPHA' : 'BRAVO');
      saveState();
      renderTeamPanels();
    });
  });

  // Alive Counter (+) and (-) Buttons
  document.getElementById('btnDecAliveA').addEventListener('click', () => adjustTeamAliveCount('A', -1));
  document.getElementById('btnIncAliveA').addEventListener('click', () => adjustTeamAliveCount('A', 1));
  document.getElementById('btnDecAliveB').addEventListener('click', () => adjustTeamAliveCount('B', -1));
  document.getElementById('btnIncAliveB').addEventListener('click', () => adjustTeamAliveCount('B', 1));

  // Player Self-Control HUD Buttons (Mobile Participant)
  document.getElementById('btnPlayerSelfToggleStatus').addEventListener('click', () => {
    if (!cloudMeta.mySoldierId) return;
    toggleSoldierAliveInField(cloudMeta.mySoldierId);
  });

  document.getElementById('btnPlayerSwitchTeam').addEventListener('click', () => {
    if (!cloudMeta.mySoldierId) return;
    switchSoldierTeam(cloudMeta.mySoldierId);
    showToast('⇄', 'Você mudou de esquadrão!');
  });

  // Game Mode Buttons
  document.getElementById('btnModeTimeLimit').addEventListener('click', () => {
    if (!isHostOrLocal() || runtime.phase !== 'IDLE') return;
    state.settings.mode = 'TIME_LIMIT';
    runtime.combatSeconds = state.settings.timeLimitMinutes * 60;
    syncRuntimeToLiveTimer();
    saveState();
    renderChronometer();
  });

  document.getElementById('btnModeElimination').addEventListener('click', () => {
    if (!isHostOrLocal() || runtime.phase !== 'IDLE') return;
    state.settings.mode = 'ELIMINATION';
    runtime.combatSeconds = 0;
    syncRuntimeToLiveTimer();
    saveState();
    renderChronometer();
  });

  // Duration & Prep Config Buttons
  document.getElementById('btnMinusMin').addEventListener('click', () => {
    if (!isHostOrLocal() || runtime.phase !== 'IDLE') return;
    state.settings.timeLimitMinutes = Math.max(1, state.settings.timeLimitMinutes - 1);
    runtime.combatSeconds = state.settings.timeLimitMinutes * 60;
    syncRuntimeToLiveTimer();
    saveState();
    renderChronometer();
  });

  document.getElementById('btnPlusMin').addEventListener('click', () => {
    if (!isHostOrLocal() || runtime.phase !== 'IDLE') return;
    state.settings.timeLimitMinutes = Math.min(180, state.settings.timeLimitMinutes + 1);
    runtime.combatSeconds = state.settings.timeLimitMinutes * 60;
    syncRuntimeToLiveTimer();
    saveState();
    renderChronometer();
  });

  document.getElementById('btnMinusPrep').addEventListener('click', () => {
    if (!isHostOrLocal() || runtime.phase !== 'IDLE') return;
    state.settings.prepSeconds = Math.max(0, state.settings.prepSeconds - 15);
    runtime.remainingPrepSec = state.settings.prepSeconds;
    syncRuntimeToLiveTimer();
    saveState();
    renderChronometer();
  });

  document.getElementById('btnZeroPrep').addEventListener('click', () => {
    if (!isHostOrLocal() || runtime.phase !== 'IDLE') return;
    state.settings.prepSeconds = 0;
    runtime.remainingPrepSec = 0;
    syncRuntimeToLiveTimer();
    saveState();
    renderChronometer();
  });

  document.getElementById('btnPlusPrep').addEventListener('click', () => {
    if (!isHostOrLocal() || runtime.phase !== 'IDLE') return;
    state.settings.prepSeconds = Math.min(300, state.settings.prepSeconds + 15);
    runtime.remainingPrepSec = state.settings.prepSeconds;
    syncRuntimeToLiveTimer();
    saveState();
    renderChronometer();
  });

  // Main Timer Controls
  document.getElementById('btnStartMatch').addEventListener('click', startMatchSequence);
  document.getElementById('btnSkipPrep').addEventListener('click', enterCombatPhase);
  document.getElementById('btnPauseResumeMatch').addEventListener('click', togglePauseResumeMatch);
  document.getElementById('btnFinishMatch').addEventListener('click', () => {
    finishMatchAndOpenVerification('ENCERRAMENTO MANUAL / CONFERÊNCIA', null);
  });
  document.getElementById('btnResetTimer').addEventListener('click', () => {
    resetChronometerToIdle();
    showToast('🔄', 'Cronômetro e tropa resetados para o início do round.');
  });

  // Header Audio & Test Voice Controls
  document.getElementById('btnToggleMute').addEventListener('click', () => {
    state.settings.muted = !state.settings.muted;
    saveState(true);
    renderAudioButton();
    if (!state.settings.muted) {
      audioEngine.playTone(880, 90, 'sine', 0.2);
    }
  });

  document.getElementById('btnTestVoice').addEventListener('click', () => {
    if (state.settings.muted) {
      state.settings.muted = false;
      saveState(true);
      renderAudioButton();
    }
    audioEngine.announceCombatStart();
    showToast('🎙️', 'Locutor Tático: "Kill them all!"');
  });

  // Reset Full Session Button
  document.getElementById('btnResetSession').addEventListener('click', () => {
    if (!isHostOrLocal()) {
      showToast('🔒', 'Apenas o Juiz pode zerar a sessão da sala!');
      return;
    }
    const confirmed = window.confirm(
      'ATENÇÃO COMANDANTE:\nDeseja realmente ZERAR A SESSÃO?\n\nIsso apagará o placar de vitórias, histórico do relatório e operadores cadastrados.'
    );
    if (!confirmed) return;

    clearMatchInterval();
    state = getDefaultState();
    saveState();
    resetChronometerToIdle();
    showToast('🗑️', 'Sessão zerada! Novo jogo pronto.');
  });

  // CLOUD SESSION MODAL EVENTS
  const openCloudModal = () => {
    if (!document.getElementById('inputCreateSessionCode').value) {
      document.getElementById('inputCreateSessionCode').value = generateRandomSessionCode();
    }
    renderCloudModal();
    document.getElementById('modalCloudSession').classList.remove('hidden');
  };
  const closeCloudModal = () => {
    document.getElementById('modalCloudSession').classList.add('hidden');
  };

  document.getElementById('btnOpenCloudSession').addEventListener('click', openCloudModal);
  document.getElementById('activeSessionPill').addEventListener('click', openCloudModal);
  document.getElementById('btnCloseCloudSession').addEventListener('click', closeCloudModal);

  document.getElementById('btnGenerateRandomCode').addEventListener('click', () => {
    document.getElementById('inputCreateSessionCode').value = generateRandomSessionCode();
  });

  document.getElementById('btnSelectJoinTeamA').addEventListener('click', () => {
    cloudMeta.joinSelectedTeam = 'A';
    saveCloudMeta();
    renderCloudModal();
  });

  document.getElementById('btnSelectJoinTeamB').addEventListener('click', () => {
    cloudMeta.joinSelectedTeam = 'B';
    saveCloudMeta();
    renderCloudModal();
  });

  document.getElementById('btnCreateCloudSession').addEventListener('click', createCloudSession);
  document.getElementById('btnJoinCloudSession').addEventListener('click', joinCloudSession);
  document.getElementById('btnLeaveCloudSession').addEventListener('click', leaveCloudSession);

  document.getElementById('btnCopySessionLink').addEventListener('click', () => {
    if (!cloudMeta.sessionCode) return;
    const url = new URL(window.location.href);
    url.searchParams.set('room', cloudMeta.sessionCode);
    navigator.clipboard.writeText(url.toString()).then(() => {
      showToast('🔗', `Link da sala #${cloudMeta.sessionCode} copiado!`);
    });
  });

  document.getElementById('btnSaveSupabaseConfig').addEventListener('click', () => {
    cloudMeta.supabaseUrl = document.getElementById('inputSupabaseUrl').value.trim();
    cloudMeta.supabaseKey = document.getElementById('inputSupabaseKey').value.trim();
    saveCloudMeta();
    if (initSupabaseClient()) {
      showToast('💾', 'Supabase conectado com sucesso! Agora você pode Criar ou Entrar em sessões.');
    } else {
      showToast('⚠️', 'Verifique se a URL e a Anon Key estão corretas.');
    }
  });

  document.getElementById('btnCopySqlSchema').addEventListener('click', () => {
    navigator.clipboard.writeText(SQL_SETUP_SCRIPT).then(() => {
      showToast('📋', 'Script SQL copiado! Cole no SQL Editor do Supabase e clique em Run.');
    });
  });

  // Roster Modal Open / Close / Actions
  const openRoster = () => {
    renderRosterModal();
    document.getElementById('modalRoster').classList.remove('hidden');
    setTimeout(() => document.getElementById('inputSoldierName').focus(), 80);
  };
  const closeRoster = () => {
    document.getElementById('modalRoster').classList.add('hidden');
  };

  document.getElementById('btnOpenRoster').addEventListener('click', openRoster);
  document.querySelectorAll('[data-open-roster]').forEach((btn) => {
    btn.addEventListener('click', openRoster);
  });
  document.getElementById('btnCloseRoster').addEventListener('click', closeRoster);
  document.getElementById('btnDoneRoster').addEventListener('click', closeRoster);

  document.getElementById('formAddSoldier').addEventListener('submit', (e) => {
    e.preventDefault();
    addSoldier(document.getElementById('inputSoldierName').value, 'A');
  });
  document.getElementById('btnAddToTeamA').addEventListener('click', () => {
    addSoldier(document.getElementById('inputSoldierName').value, 'A');
  });
  document.getElementById('btnAddToTeamB').addEventListener('click', () => {
    addSoldier(document.getElementById('inputSoldierName').value, 'B');
  });
  document.getElementById('btnShuffleTeams').addEventListener('click', shuffleAndBalanceTeams);

  // Post-Match Verification Modal Controls
  document.getElementById('btnCancelVerification').addEventListener('click', () => {
    document.getElementById('modalVerification').classList.add('hidden');
    runtime.phase = 'PAUSED';
    syncRuntimeToLiveTimer();
    saveState();
    renderAll();
  });

  document.getElementById('btnVerifyDecA').addEventListener('click', () => adjustVerifyTeamCount('A', -1));
  document.getElementById('btnVerifyIncA').addEventListener('click', () => adjustVerifyTeamCount('A', 1));
  document.getElementById('btnVerifyDecB').addEventListener('click', () => adjustVerifyTeamCount('B', -1));
  document.getElementById('btnVerifyIncB').addEventListener('click', () => adjustVerifyTeamCount('B', 1));

  document.getElementById('btnVerifyAllDeadA').addEventListener('click', () => setVerifyTeamAll('A', false));
  document.getElementById('btnVerifyAllAliveA').addEventListener('click', () => setVerifyTeamAll('A', true));
  document.getElementById('btnVerifyAllDeadB').addEventListener('click', () => setVerifyTeamAll('B', false));
  document.getElementById('btnVerifyAllAliveB').addEventListener('click', () => setVerifyTeamAll('B', true));

  document.getElementById('btnConfirmMatchResult').addEventListener('click', confirmMatchResultAndScore);

  // Report Modal Controls
  const openReport = () => {
    renderReportModal();
    document.getElementById('modalReport').classList.remove('hidden');
  };
  const closeReport = () => {
    document.getElementById('modalReport').classList.add('hidden');
  };

  document.getElementById('btnOpenReport').addEventListener('click', openReport);
  document.getElementById('btnCloseReport').addEventListener('click', closeReport);
  document.getElementById('btnDoneReport').addEventListener('click', closeReport);
  document.getElementById('btnCopyWhatsapp').addEventListener('click', copyWhatsappReport);
}

// Reconnect to active session or URL ?room=CODE parameter on boot
async function checkInitialCloudSession() {
  initSupabaseClient();

  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = sanitizeSessionCode(urlParams.get('room'));

  if (roomFromUrl) {
    document.getElementById('inputJoinSessionCode').value = roomFromUrl;
    if (cloudMeta.sessionCode !== roomFromUrl) {
      // Open Cloud Modal directly so the player can type their Codinome and Join
      renderCloudModal();
      document.getElementById('modalCloudSession').classList.remove('hidden');
      setTimeout(() => document.getElementById('inputJoinOperatorName').focus(), 100);
      return;
    }
  }

  if (cloudMeta.sessionCode && supabaseClient) {
    try {
      const { data } = await supabaseClient
        .from('tactical_sessions')
        .select('*')
        .eq('code', cloudMeta.sessionCode)
        .maybeSingle();

      if (data && data.state) {
        cloudMeta.role = data.host_id === cloudMeta.deviceId ? 'HOST' : 'PLAYER';
        saveCloudMeta();
        applyRemoteCloudState(data.state);
        subscribeToCloudSession(cloudMeta.sessionCode);
      }
    } catch (e) {}
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (state.soldiers.length > 0) {
    syncAliveCountFromRoster('A');
    syncAliveCountFromRoster('B');
  }
  bindEvents();
  renderAll();
  initPWA();
  checkInitialCloudSession();
});
