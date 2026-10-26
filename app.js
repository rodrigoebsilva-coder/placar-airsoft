/**
 * TACTICAL COMMAND — PAINTBALL & AIRSOFT MATCH CONTROLLER (CLOUD V2.0)
 * Complete Offline-First PWA + Supabase Realtime Multiplayer Sessions,
 * Host vs Operator Mobile Self-K.I.A. HUD, Tactical Audio Synthesizer & Hall of Fame.
 */

const STORAGE_KEY = 'tactical_command_state_v2';
const CLOUD_META_KEY = 'tactical_command_cloud_meta_v2';
const LOCAL_USERS_KEY = 'tactical_command_users_v2';
const LOGS_STORAGE_KEY = 'tactical_command_logs_v2';
const MAX_LOGS_COUNT = 150;


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
  owner_email text,
  owner_name text,
  is_online boolean not null default true,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.tactical_sessions add column if not exists owner_email text;
alter table public.tactical_sessions add column if not exists owner_name text;
alter table public.tactical_sessions add column if not exists is_online boolean not null default true;
alter table public.tactical_sessions enable row level security;
-- Depois deste script, rode 001_rpc_atomico.sql e 002_rls_hardening.sql (RPCs atômicas e RLS fechada).
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
    joinSelectedTeam: 'A',
    selectedSoldierRank: 'EXPERIENTE', // 'RECRUTA' | 'EXPERIENTE' | 'MATADOR'
    authUser: null, // { id, email, name, isAdmin }
    myCreatedRooms: [] // [{ code, is_online, created_at, updated_at }]
  };
}

const SOLDIER_RANKS = {
  RECRUTA: {
    id: 'RECRUTA',
    label: 'RECRUTA',
    icon: '🔰',
    weight: 1,
    badgeClass: 'bg-sky-500/20 text-sky-300 border border-sky-400/40',
    btnActiveClass:
      'rounded-xl border-2 border-sky-400 bg-sky-500/20 text-sky-300 font-black uppercase tracking-wider transition'
  },
  EXPERIENTE: {
    id: 'EXPERIENTE',
    label: 'EXPERIENTE',
    icon: '🎖️',
    weight: 2,
    badgeClass: 'bg-amber-500/20 text-amber-300 border border-amber-400/40',
    btnActiveClass:
      'rounded-xl border-2 border-amber-400 bg-amber-500/20 text-amber-300 font-black uppercase tracking-wider transition'
  },
  MATADOR: {
    id: 'MATADOR',
    label: 'MATADOR',
    icon: '💀',
    weight: 3,
    badgeClass: 'bg-red-500/20 text-red-300 border border-red-400/40',
    btnActiveClass:
      'rounded-xl border-2 border-red-500 bg-red-600/25 text-red-300 font-black uppercase tracking-wider transition'
  }
};

function getSoldierRankInfo(rankId) {
  return SOLDIER_RANKS[rankId] || SOLDIER_RANKS.EXPERIENTE;
}

let state = loadState();
let cloudMeta = loadCloudMeta();
let supabaseClient = null;
let realtimeChannel = null;
let realtimeConnectionStatus = 'STANDBY';
let isApplyingRemoteUpdate = false;
let currentLogFilter = 'ALL';
let openOnlineRoomsCache = [];

/* ==========================================================================
   TACTICAL ERROR & DIAGNOSTIC LOGGER
   ========================================================================== */
class TacticalLogger {
  constructor() {
    this.logs = this.loadLogs();
    this.setupGlobalHandlers();
  }

  loadLogs() {
    try {
      const raw = localStorage.getItem(LOGS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(0, MAX_LOGS_COUNT) : [];
    } catch (e) {
      return [];
    }
  }

  saveLogs() {
    try {
      localStorage.setItem(LOGS_STORAGE_KEY, JSON.stringify(this.logs.slice(0, MAX_LOGS_COUNT)));
    } catch (e) {}
  }

  log(level, category, message, details = null) {
    const entry = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      level: level || 'INFO', // 'INFO' | 'WARN' | 'ERROR'
      category: category || 'SYSTEM', // 'SYSTEM' | 'CLOUD' | 'AUTH' | 'TIMER'
      role: typeof cloudMeta !== 'undefined' ? cloudMeta.role : 'LOCAL',
      room: typeof cloudMeta !== 'undefined' ? cloudMeta.sessionCode : null,
      message: String(message || ''),
      details: details
        ? typeof details === 'string'
          ? details
          : JSON.stringify(details)
        : null
    };

    this.logs.unshift(entry);
    if (this.logs.length > MAX_LOGS_COUNT) {
      this.logs.length = MAX_LOGS_COUNT;
    }
    this.saveLogs();
    this.updateHeaderBadge();

    if (level === 'ERROR') {
      console.error(`[TacticalLog][${category}] ${message}`, details || '');
    } else if (level === 'WARN') {
      console.warn(`[TacticalLog][${category}] ${message}`, details || '');
    }
  }

  info(category, message, details = null) {
    this.log('INFO', category, message, details);
  }

  warn(category, message, details = null) {
    this.log('WARN', category, message, details);
  }

  error(category, message, details = null) {
    this.log('ERROR', category, message, details);
  }

  getErrorCount() {
    return this.logs.filter((l) => l.level === 'ERROR' || l.level === 'WARN').length;
  }

  clear() {
    this.logs = [];
    this.saveLogs();
    this.updateHeaderBadge();
  }

  updateHeaderBadge() {
    const badge = document.getElementById('headerErrorCountBadge');
    if (!badge) return;
    const errCount = this.getErrorCount();
    if (errCount > 0) {
      badge.textContent = errCount > 99 ? '99+' : String(errCount);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  setupGlobalHandlers() {
    window.addEventListener('error', (event) => {
      this.error('SYSTEM', `Erro JS: ${event.message || 'Falha inesperada'}`, {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      });
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason?.message || String(event.reason || 'Promise rejeitada');
      this.error('SYSTEM', `Promise não tratada: ${reason}`);
    });
  }
}

const tacticalLogger = new TacticalLogger();

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
      liveTimer: { ...def.liveTimer, ...(parsed.liveTimer || {}) },
      roomMeta: parsed.roomMeta || null,
      lastMutationBy: parsed.lastMutationBy || null,
      lastMutationRole: parsed.lastMutationRole || null,
      updatedAtMs: parsed.updatedAtMs || 0
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
    this.rawClipData = {
      KILL_THEM_ALL: null,
      GAME_OVER: null
    };
    this.decodedBuffers = {
      KILL_THEM_ALL: null,
      GAME_OVER: null
    };
    this.preloadFpsVoiceClips();

    if ('speechSynthesis' in window) {
      const loadVoices = () => {
        this.voices = window.speechSynthesis.getVoices();
      };
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }

  async preloadFpsVoiceClips() {
    const files = {
      KILL_THEM_ALL: './sfx-kill-them-all.mp3',
      GAME_OVER: './sfx-game-over.mp3'
    };

    for (const [key, url] of Object.entries(files)) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          this.rawClipData[key] = await res.arrayBuffer();
        }
      } catch (e) {}
    }
  }

  makeDistortionCurve(amount = 28) {
    const k = typeof amount === 'number' ? amount : 28;
    const nSamples = 44100;
    const curve = new Float32Array(nSamples);
    const deg = Math.PI / 180;
    for (let i = 0; i < nSamples; ++i) {
      const x = (i * 2) / nSamples - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  async playFpsAnnouncerClip(clipKey, fallbackPhrase) {
    if (state.settings.muted) return;
    const ctx = this.ensureContext();

    if (ctx) {
      try {
        if (!this.decodedBuffers[clipKey] && this.rawClipData[clipKey]) {
          const copyBuffer = this.rawClipData[clipKey].slice(0);
          this.decodedBuffers[clipKey] = await ctx.decodeAudioData(copyBuffer);
        }

        const audioBuffer = this.decodedBuffers[clipKey];
        if (audioBuffer) {
          const now = ctx.currentTime;

          // 1. Primary Deep FPS Announcer Layer (Grave / Gruff Commander)
          const mainSource = ctx.createBufferSource();
          mainSource.buffer = audioBuffer;
          mainSource.playbackRate.setValueAtTime(0.87, now);

          // 2. Sub-Harmonic Demon/Arena Layer (Quake / Unreal Tournament Chest Resonance)
          const subSource = ctx.createBufferSource();
          subSource.buffer = audioBuffer;
          subSource.playbackRate.setValueAtTime(0.70, now);

          const subFilter = ctx.createBiquadFilter();
          subFilter.type = 'lowpass';
          subFilter.frequency.setValueAtTime(360, now);

          const subLayerGain = ctx.createGain();
          subLayerGain.gain.setValueAtTime(0.42, now);

          subSource.connect(subFilter);
          subFilter.connect(subLayerGain);

          // 3. EQ: Deep Sub-Bass Boost + Aggressive Mid-High Presence
          const bassBoost = ctx.createBiquadFilter();
          bassBoost.type = 'lowshelf';
          bassBoost.frequency.setValueAtTime(140, now);
          bassBoost.gain.setValueAtTime(9.5, now);

          const presenceBoost = ctx.createBiquadFilter();
          presenceBoost.type = 'peaking';
          presenceBoost.frequency.setValueAtTime(2400, now);
          presenceBoost.Q.setValueAtTime(1.1, now);
          presenceBoost.gain.setValueAtTime(4.5, now);

          // 4. Warm Grit Saturation
          const shaper = ctx.createWaveShaper();
          shaper.curve = this.makeDistortionCurve(22);
          shaper.oversample = '2x';

          // 5. Arena Slapback Echo (Stadium / FPS Announcer Reverb)
          const delay = ctx.createDelay();
          delay.delayTime.setValueAtTime(0.11, now);
          const feedback = ctx.createGain();
          feedback.gain.setValueAtTime(0.24, now);
          const wetGain = ctx.createGain();
          wetGain.gain.setValueAtTime(0.26, now);

          delay.connect(feedback);
          feedback.connect(delay);
          delay.connect(wetGain);

          // 6. Heavy Broadcast Compressor + Master Output Boost
          const compressor = ctx.createDynamicsCompressor();
          compressor.threshold.setValueAtTime(-20, now);
          compressor.knee.setValueAtTime(12, now);
          compressor.ratio.setValueAtTime(8, now);
          compressor.attack.setValueAtTime(0.003, now);
          compressor.release.setValueAtTime(0.18, now);

          const masterGain = ctx.createGain();
          masterGain.gain.setValueAtTime(1.65, now);

          mainSource.connect(bassBoost);
          subLayerGain.connect(bassBoost);
          bassBoost.connect(presenceBoost);
          presenceBoost.connect(shaper);

          shaper.connect(compressor);
          shaper.connect(delay);
          wetGain.connect(compressor);

          compressor.connect(masterGain);
          masterGain.connect(ctx.destination);

          mainSource.start(now);
          subSource.start(now + 0.008);
          return;
        }
      } catch (err) {
        console.warn('WebAudio FPS clip fallback:', err);
      }
    }

    // Fallback to HTML5 Audio element with pitch shift if WebAudio buffer wasn't decoded yet
    const url =
      clipKey === 'KILL_THEM_ALL' ? './sfx-kill-them-all.mp3' : './sfx-game-over.mp3';
    try {
      const audio = new Audio(url);
      audio.preservesPitch = false;
      audio.mozPreservesPitch = false;
      audio.webkitPreservesPitch = false;
      audio.playbackRate = 0.85;
      audio.volume = 1.0;
      await audio.play();
      return;
    } catch (e) {
      this.speakCommand(fallbackPhrase);
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
      this.playFpsAnnouncerClip('KILL_THEM_ALL', 'Kill them all!');
    }, 180);
  }

  announceGameOver() {
    this.playGameOverSiren();
    setTimeout(() => {
      this.playFpsAnnouncerClip('GAME_OVER', 'Game Over!');
    }, 320);
  }
}

const TacticalAudioEnginePatch = {
  async preloadFpsVoiceClips() {
    const files = { KILL_THEM_ALL: './sfx-kill-them-all.mp3', GAME_OVER: './sfx-game-over.mp3' };
    this._decoding = this._decoding || {};
    for (const [key, url] of Object.entries(files)) {
      if (this.rawClipData[key] || this.decodedBuffers[key]) continue;
      try {
        const res = await fetch(url);
        if (res.ok) this.rawClipData[key] = await res.arrayBuffer();
      } catch (e) {
        /* offline no 1º load: tenta de novo no próximo gesto (warmUp) */
      }
    }
  },

  decodeClip(key) {
    if (this.decodedBuffers[key]) return Promise.resolve(this.decodedBuffers[key]);
    if (!this.ctx || !this.rawClipData[key]) return Promise.resolve(null);
    this._decoding = this._decoding || {};
    if (!this._decoding[key]) {
      const copy = this.rawClipData[key].slice(0);
      this._decoding[key] = this.ctx
        .decodeAudioData(copy)
        .then((buf) => {
          this.decodedBuffers[key] = buf;
          this.rawClipData[key] = null;
          return buf;
        })
        .catch(() => null)
        .finally(() => {
          delete this._decoding[key];
        });
    }
    return this._decoding[key];
  },

  async warmUp() {
    if (!this.ctx) return;
    await this.preloadFpsVoiceClips();
    await Promise.all(['KILL_THEM_ALL', 'GAME_OVER'].map((k) => this.decodeClip(k)));
  },

  ensureContext() {
    if (state.settings.muted) return null;
    if (this.ctx && this.ctx.state === 'closed') this.ctx = null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      try {
        this.ctx = new AudioCtx({ latencyHint: 'interactive' });
      } catch (e) {
        this.ctx = new AudioCtx();
      }
      this.ctx.onstatechange = () => {
        if (this.ctx && this.ctx.state === 'running') this.warmUp();
      };
    }
    if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  },

  unlockFromGesture() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (!this._silentPlayed) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, 22050);
        src.connect(ctx.destination);
        src.start(0);
        src.onended = () => src.disconnect();
        this._silentPlayed = true;
      } catch (e) {}
    }
    if (ctx.state === 'running') this.warmUp();
  },

  installUnlockListeners() {
    if (this._unlockInstalled) return;
    this._unlockInstalled = true;
    const handler = () => this.unlockFromGesture();
    for (const ev of ['pointerdown', 'touchend', 'click', 'keydown']) {
      document.addEventListener(ev, handler, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.ctx && this.ctx.state !== 'running') {
        this.ctx.resume().catch(() => {});
      }
    });
  },

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
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch (e) {}
    };
    osc.start(startTime);
    osc.stop(endTime + 0.02);
  },

  async playFpsAnnouncerClip(clipKey, fallbackPhrase) {
    if (state.settings.muted) return;
    const ctx = this.ensureContext();

    if (ctx) {
      try {
        const audioBuffer = this.decodedBuffers[clipKey] || (await this.decodeClip(clipKey));
        if (audioBuffer) {
          const now = ctx.currentTime;
          const nodes = [];
          const track = (n) => (nodes.push(n), n);

          const mainSource = track(ctx.createBufferSource());
          mainSource.buffer = audioBuffer;
          mainSource.playbackRate.setValueAtTime(0.87, now);

          const subSource = track(ctx.createBufferSource());
          subSource.buffer = audioBuffer;
          subSource.playbackRate.setValueAtTime(0.7, now);

          const subFilter = track(ctx.createBiquadFilter());
          subFilter.type = 'lowpass';
          subFilter.frequency.setValueAtTime(360, now);
          const subLayerGain = track(ctx.createGain());
          subLayerGain.gain.setValueAtTime(0.42, now);
          subSource.connect(subFilter);
          subFilter.connect(subLayerGain);

          const bassBoost = track(ctx.createBiquadFilter());
          bassBoost.type = 'lowshelf';
          bassBoost.frequency.setValueAtTime(140, now);
          bassBoost.gain.setValueAtTime(9.5, now);

          const presenceBoost = track(ctx.createBiquadFilter());
          presenceBoost.type = 'peaking';
          presenceBoost.frequency.setValueAtTime(2400, now);
          presenceBoost.Q.setValueAtTime(1.1, now);
          presenceBoost.gain.setValueAtTime(4.5, now);

          const shaper = track(ctx.createWaveShaper());
          if (!this._distCurve) this._distCurve = this.makeDistortionCurve(22);
          shaper.curve = this._distCurve;
          shaper.oversample = '2x';

          const delay = track(ctx.createDelay());
          delay.delayTime.setValueAtTime(0.11, now);
          const feedback = track(ctx.createGain());
          feedback.gain.setValueAtTime(0.24, now);
          const wetGain = track(ctx.createGain());
          wetGain.gain.setValueAtTime(0.26, now);
          delay.connect(feedback);
          feedback.connect(delay);
          delay.connect(wetGain);

          const compressor = track(ctx.createDynamicsCompressor());
          compressor.threshold.setValueAtTime(-20, now);
          compressor.knee.setValueAtTime(12, now);
          compressor.ratio.setValueAtTime(8, now);
          compressor.attack.setValueAtTime(0.003, now);
          compressor.release.setValueAtTime(0.18, now);

          const masterGain = track(ctx.createGain());
          masterGain.gain.setValueAtTime(1.65, now);

          mainSource.connect(bassBoost);
          subLayerGain.connect(bassBoost);
          bassBoost.connect(presenceBoost);
          presenceBoost.connect(shaper);
          shaper.connect(compressor);
          shaper.connect(delay);
          wetGain.connect(compressor);
          compressor.connect(masterGain);
          masterGain.connect(ctx.destination);

          let cleaned = false;
          const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            setTimeout(() => {
              for (const n of nodes) {
                try {
                  n.disconnect();
                } catch (e) {}
              }
            }, 1500);
          };
          subSource.onended = cleanup;

          mainSource.start(now);
          subSource.start(now + 0.008);
          return;
        }
      } catch (err) {
        console.warn('WebAudio FPS clip fallback:', err);
      }
    }

    const url = clipKey === 'KILL_THEM_ALL' ? './sfx-kill-them-all.mp3' : './sfx-game-over.mp3';
    try {
      const audio = new Audio(url);
      audio.preservesPitch = false;
      audio.mozPreservesPitch = false;
      audio.webkitPreservesPitch = false;
      audio.playbackRate = 0.85;
      audio.volume = 1.0;
      audio.addEventListener(
        'ended',
        () => {
          audio.removeAttribute('src');
          audio.load();
        },
        { once: true }
      );
      await audio.play();
      return;
    } catch (e) {
      this.speakCommand(fallbackPhrase);
    }
  }
};

Object.assign(TacticalAudioEngine.prototype, TacticalAudioEnginePatch);

const audioEngine = new TacticalAudioEngine();
audioEngine.installUnlockListeners();

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
   AUTHENTICATION, ADMIN PRIVILEGE & SELF-REGISTRATION ENGINE
   ========================================================================== */
/* Fase 2: contas só existem no Supabase Auth. Nada de senha no navegador. */

function purgeLegacyLocalCredentials() {
  try { localStorage.removeItem(LOCAL_USERS_KEY); } catch (e) {}
}


// Garante um JWT. Sem ele o RLS não entrega eventos Realtime e as RPCs recusam.
// Offline: devolve null sem lançar erro (o app continua local e tenta de novo ao reconectar).
let authInFlight = null;
function ensureAuthSession({ anonymous = true } = {}) {
  if (authInFlight) return authInFlight;
  authInFlight = (async () => {
    if (!initSupabaseClient()) return null;
    try {
      const { data } = await supabaseClient.auth.getSession(); // lê do localStorage: funciona offline
      if (data && data.session) return data.session;
    } catch (e) {}
    if (!anonymous) return null;
    try {
      const { data, error } = await supabaseClient.auth.signInAnonymously();
      if (error) throw error;
      return data.session;
    } catch (e) {
      tacticalLogger.warn('AUTH', 'Login anônimo indisponível agora', e && e.message);
      return null;
    }
  })().finally(() => { authInFlight = null; });
  return authInFlight;
}


// Atualiza cloudMeta.authUser a partir da sessão. Anônimo NÃO conta como "logado" na UI.
async function syncAuthUser(session) {
  if (!session || !session.user || session.user.is_anonymous) {
    cloudMeta.authUser = null;
    saveCloudMeta();
    return null;
  }
  let isAdmin = false;
  try {
    const w = await rpc('rpc_whoami', {});
    isAdmin = Boolean(w && w.is_admin);
  } catch (e) { /* offline: assume não-admin na UI; o servidor decide de qualquer forma */ }
  const u = session.user;
  cloudMeta.authUser = {
    id: u.id,
    email: String(u.email || '').toLowerCase(),
    name: (u.user_metadata && u.user_metadata.name) || String(u.email || '').split('@')[0].toUpperCase(),
    isAdmin
  };
  saveCloudMeta();
  return cloudMeta.authUser;
}


let authListenerInstalled = false;
function installAuthListener() {
  if (authListenerInstalled || !supabaseClient) return;
  authListenerInstalled = true;
  supabaseClient.auth.onAuthStateChange((event, session) => {
    // Não chamar o Supabase aqui dentro de forma síncrona (deadlock conhecido do supabase-js):
    // adia para o próximo tick.
    setTimeout(async () => {
      if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        await syncAuthUser(session);
        if (cloudMeta.authUser) fetchMyCreatedRooms();
        renderAll();
      } else if (event === 'SIGNED_OUT') {
        cloudMeta.authUser = null;
        saveCloudMeta();
        renderAll();
      }
      // TOKEN_REFRESHED: o supabase-js já repassa o novo JWT ao canal Realtime sozinho.
    }, 0);
  });
}


function friendlyAuthError(error) {
  const m = String((error && error.message) || '').toLowerCase();
  if (m.includes('email not confirmed')) return 'Confirme seu e-mail (veja a caixa de entrada) antes de entrar.';
  if (m.includes('invalid login')) return 'E-mail ou senha inválidos.';
  if (m.includes('already registered')) return 'Este e-mail já está cadastrado. Use a aba ENTRAR.';
  if (m.includes('password')) return 'Senha fraca: use pelo menos 8 caracteres.';
  if (m.includes('rate limit')) return 'Muitas tentativas. Aguarde um minuto.';
  return 'Não foi possível concluir agora. Tente novamente.';
}


async function handleLogin(emailRaw, password) {
  const email = (emailRaw || '').trim().toLowerCase();
  if (!email || !password) { showToast('⚠️', 'Preencha seu e-mail e senha!'); return; }
  if (!initSupabaseClient()) { showToast('⚙️', 'Configure o Supabase primeiro.'); return; }

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error || !data || !data.session) { showToast('❌', friendlyAuthError(error)); return; }

  const user = await syncAuthUser(data.session);
  await claimLegacyRooms();
  await fetchMyCreatedRooms();
  renderAll();
  renderAuthModal();
  showToast(user && user.isAdmin ? '👑' : '🔓', `Bem-vindo, ${user ? user.name : 'Comandante'}!`);
}


async function handleSelfRegister(nameRaw, emailRaw, password) {
  const name = (nameRaw || '').trim().toUpperCase().slice(0, 40);
  const email = (emailRaw || '').trim().toLowerCase();
  if (!name || !email || !password) { showToast('⚠️', 'Preencha todos os campos!'); return; }
  if (password.length < 8) { showToast('⚠️', 'A senha deve ter pelo menos 8 caracteres.'); return; }
  if (!initSupabaseClient()) { showToast('⚙️', 'Configure o Supabase primeiro.'); return; }

  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: { data: { name }, emailRedirectTo: location.origin + location.pathname }
  });
  if (error) { showToast('❌', friendlyAuthError(error)); return; }

  if (!data.session) {
    // Projeto com "Confirm email" ligado (padrão do Supabase): só entra depois do link.
    showToast('📧', 'Cadastro criado! Confirme o e-mail que enviamos e depois toque em ENTRAR.');
    return;
  }
  await syncAuthUser(data.session);
  const joinOpInput = document.getElementById('inputJoinOperatorName');
  if (joinOpInput && !joinOpInput.value) joinOpInput.value = name;
  await claimLegacyRooms();
  await fetchMyCreatedRooms();
  renderAll();
  renderAuthModal();
  showToast('✅', `Conta criada! Bem-vindo, ${name}.`);
}


async function handleLogout() {
  const wasHost = cloudMeta.role === 'HOST';
  try { await supabaseClient.auth.signOut(); } catch (e) {}
  cloudMeta.authUser = null;
  cloudMeta.myCreatedRooms = [];
  saveCloudMeta();
  if (wasHost) leaveCloudSession({ silent: true }); // sem a conta, este aparelho deixa de ser o Juiz
  await ensureAuthSession(); // volta a ter uma identidade anônima para entrar em salas
  renderAll();
  renderAuthModal();
  showToast('🚪', 'Você saiu da sua conta.');
}


// Salas criadas na versão antiga (dono = e-mail dentro do state). O servidor só entrega a
// posse se o e-mail CONFIRMADO do JWT bater com o e-mail guardado na tabela privada.
async function claimLegacyRooms() {
  const candidates = new Set([
    ...(cloudMeta.myCreatedRooms || []).map((r) => r.code),
    ...(cloudMeta.sessionCode ? [cloudMeta.sessionCode] : [])
  ]);
  for (const code of candidates) {
    try { await rpc('rpc_claim_legacy_room', { p_code: code }); } catch (e) { /* não é sua: ignora */ }
  }
}



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
    if (!supabaseClient) {
      supabaseClient = window.supabase.createClient(url, key, {
        realtime: { params: { eventsPerSecond: 10 } }
      });
    }
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
  const a = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(a);
  } else {
    a[0] = Math.floor(Math.random() * 100000);
  }
  return `${p}-${String((a[0] % 9000) + 1000)}`;
}

function sanitizeSessionCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-_]/g, '')
    .slice(0, 16);
}

// Build serializable state payload for Supabase (Preserving Creator Ownership & Authority)
function buildCloudStatePayload(isOnlineOverride = null, existingRoomMeta = null) {
  const baseMeta = existingRoomMeta || state.roomMeta || {};
  const currentOnline =
    isOnlineOverride !== null
      ? Boolean(isOnlineOverride)
      : baseMeta.isOnline !== undefined
      ? Boolean(baseMeta.isOnline)
      : true;

  const isHost = cloudMeta.role === 'HOST' || cloudMeta.role === 'LOCAL';
  const ownerName =
    (isHost && cloudMeta.authUser?.name) ||
    baseMeta.ownerName ||
    'COMANDANTE';
  const ownerDeviceId =
    baseMeta.ownerDeviceId || (isHost ? cloudMeta.deviceId : null) || cloudMeta.deviceId;

  return {
    teams: state.teams,
    soldiers: state.soldiers,
    settings: {
      mode: state.settings.mode,
      timeLimitMinutes: state.settings.timeLimitMinutes,
      prepSeconds: state.settings.prepSeconds
    },
    stats: state.stats,
    liveTimer: state.liveTimer,
    roomMeta: {
      ownerName,
      ownerDeviceId,
      isOnline: currentOnline
    },
    lastMutationBy: cloudMeta.deviceId,
    lastMutationRole: cloudMeta.role,
    updatedAtMs: Date.now()
  };
}

const OUTBOX_KEY = 'tactical_command_outbox_v1';
const BUSINESS_ERRORS = [
  'forbidden',
  'room_not_found',
  'soldier_not_found',
  'invalid_soldier',
  'room_full',
  'room_offline',
  'invalid_role',
  'auth_required',
  'code_taken',
  'invalid_code'
];

let connectionState = 'IDLE'; // IDLE | ONLINE | RECONNECTING | OFFLINE
let lastSeenRev = 0;
let lastSentRosterSig = null;
let flushTimer = null;
let flushing = false;
let flushAgain = false;
let flushAttempt = 0;
let heartbeatTimer = null;
let resyncInFlight = null;
let resyncRetryTimer = null;
let lastFullSyncAt = 0;

async function rpc(fn, args) {
  const { data, error } = await supabaseClient.rpc(fn, args);
  if (error) {
    const e = new Error(error.message || String(error));
    e.code = error.code;
    throw e;
  }
  return data;
}

function isBusinessError(e) {
  const msg = String((e && e.message) || '');
  return BUSINESS_ERRORS.some((k) => msg.includes(k));
}

function newBox() {
  return {
    alive: {},
    enlist: null,
    hostDirty: false,
    rosterDirty: false,
    removed: [],
    resetAlive: false,
    force: false
  };
}
function readOutbox() {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || {};
  } catch (e) {
    return {};
  }
}
function writeOutbox(ob) {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(ob));
  } catch (e) {}
}
function mutateOutbox(fn, delayMs = 0) {
  const code = cloudMeta.sessionCode;
  if (!code) return;
  const ob = readOutbox();
  const box = ob[code] || (ob[code] = newBox());
  fn(box);
  writeOutbox(ob);
  scheduleFlush(delayMs);
}
function drainOutbox(code) {
  const ob = readOutbox();
  const box = ob[code];
  if (!box) return null;
  delete ob[code];
  writeOutbox(ob);
  return box;
}
function restoreOutbox(code, drained) {
  const ob = readOutbox();
  const cur = ob[code] || newBox();
  cur.alive = { ...drained.alive, ...cur.alive };
  cur.enlist = cur.enlist || drained.enlist;
  cur.hostDirty = cur.hostDirty || drained.hostDirty;
  cur.rosterDirty = cur.rosterDirty || drained.rosterDirty;
  cur.resetAlive = cur.resetAlive || drained.resetAlive;
  cur.force = cur.force || drained.force;
  cur.removed = [...new Set([...(drained.removed || []), ...cur.removed])];
  ob[code] = cur;
  writeOutbox(ob);
}
function outboxBox() {
  return readOutbox()[cloudMeta.sessionCode] || null;
}

function queueSoldierAlive(soldier) {
  mutateOutbox((b) => {
    b.alive[soldier.id] = Boolean(soldier.alive);
  }, 0);
}
function queueEnlist(soldier) {
  mutateOutbox((b) => {
    b.enlist = { id: soldier.id, name: soldier.name, team: soldier.team, rank: soldier.rank };
  }, 0);
}
function queueHostSync({ roster = false, removedIds = [], resetAlive = false, force = false } = {}) {
  mutateOutbox((b) => {
    b.hostDirty = true;
    if (roster) b.rosterDirty = true;
    if (resetAlive) b.resetAlive = true;
    if (force) b.force = true;
    if (removedIds.length) b.removed = [...new Set([...b.removed, ...removedIds])];
  }, 90);
}

function pushStateToCloud() {
  if (!supabaseClient || !cloudMeta.sessionCode) return;
  if (cloudMeta.role !== 'HOST') return;
  queueHostSync({ roster: true });
}

function scheduleFlush(ms) {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushOutbox, ms);
}

function rosterSignature() {
  return JSON.stringify(
    state.soldiers.map((s) => [
      s.id,
      s.name,
      s.team,
      s.rank,
      (s.stats && s.stats.survived) | 0,
      (s.stats && s.stats.kia) | 0,
      (s.stats && s.stats.matches) | 0
    ])
  );
}

function buildHostPatch() {
  const t = (k) => ({
    name: state.teams[k].name,
    color: state.teams[k].color,
    wins: state.teams[k].wins,
    aliveCount: state.teams[k].aliveCount
  });
  return {
    teams: { A: t('A'), B: t('B') },
    settings: {
      mode: state.settings.mode,
      timeLimitMinutes: state.settings.timeLimitMinutes,
      prepSeconds: state.settings.prepSeconds
    },
    stats: state.stats,
    liveTimer: state.liveTimer
  };
}

async function flushOutbox() {
  flushTimer = null;
  if (!supabaseClient || !cloudMeta.sessionCode) return true;
  if (flushing) {
    flushAgain = true;
    return false;
  }
  const code = cloudMeta.sessionCode;
  const role = cloudMeta.role === 'HOST' ? 'HOST' : 'PLAYER';
  const box = drainOutbox(code);
  if (!box) return true;

  flushing = true;
  let ok = true;
  try {
    if (box.enlist) {
      const st = await rpc('rpc_enlist_soldier', {
        p_code: code,
        p_soldier: box.enlist,
        p_device_id: cloudMeta.deviceId
      });
      adoptServerSoldier(st, box.enlist.id);
      box.enlist = null;
    }

    for (const [id, alive] of Object.entries(box.alive)) {
      try {
        await rpc('rpc_set_soldier_alive', {
          p_code: code,
          p_soldier_id: id,
          p_alive: alive,
          p_device_id: cloudMeta.deviceId,
          p_role: role
        });
      } catch (e) {
        if (!String(e.message).includes('soldier_not_found')) throw e;
        const mine = state.soldiers.find((s) => s.id === id);
        if (!mine) {
          delete box.alive[id];
          continue;
        }
        await rpc('rpc_enlist_soldier', {
          p_code: code,
          p_soldier: { id: mine.id, name: mine.name, team: mine.team, rank: mine.rank },
          p_device_id: cloudMeta.deviceId
        });
        await rpc('rpc_set_soldier_alive', {
          p_code: code,
          p_soldier_id: id,
          p_alive: alive,
          p_device_id: cloudMeta.deviceId,
          p_role: role
        });
      }
      delete box.alive[id];
    }

    if (box.hostDirty && role === 'HOST') {
      await rpc('rpc_host_patch', {
        p_code: code,
        p_patch: buildHostPatch(),
        p_device_id: cloudMeta.deviceId,
        p_force: Boolean(box.force)
      });
      const sig = rosterSignature();
      if (box.rosterDirty && (sig !== lastSentRosterSig || box.resetAlive || box.removed.length)) {
        await rpc('rpc_host_sync_roster', {
          p_code: code,
          p_soldiers: state.soldiers,
          p_removed_ids: box.removed,
          p_reset_alive: Boolean(box.resetAlive),
          p_device_id: cloudMeta.deviceId
        });
        lastSentRosterSig = sig;
      }
      box.hostDirty = false;
      box.rosterDirty = false;
      box.resetAlive = false;
      box.force = false;
      box.removed = [];
    }

    flushAttempt = 0;
    if (connectionState !== 'ONLINE') setConnectionState('ONLINE');
  } catch (e) {
    ok = false;
    if (isBusinessError(e)) {
      tacticalLogger.error('CLOUD', `RPC recusada: ${e.message}`);
      if (String(e.message).includes('room_not_found')) {
        showToast('🗑️', 'A sala não existe mais.');
        leaveCloudSession();
      } else if (String(e.message).includes('forbidden')) {
        showToast('🔒', 'Ação não permitida nesta sala.');
        if (cloudMeta.role === 'PLAYER' && cloudMeta.mySoldierId) {
          // o servidor guardou este soldado para OUTRA identidade: peça para entrar de novo
          cloudMeta.mySoldierId = null;
          saveCloudMeta();
          renderAll();
          showToast('🪖', 'Sua identidade neste aparelho mudou. Toque em ENTRAR para se realistar.');
        }
      }
    } else {
      restoreOutbox(code, box);
      setConnectionState('OFFLINE');
      flushAttempt += 1;
      scheduleFlush(Math.min(30000, 1000 * 2 ** Math.min(flushAttempt, 5)));
      tacticalLogger.warn('CLOUD', 'Sem conexão: ações mantidas na fila local', e.message);
    }
  } finally {
    flushing = false;
    if (flushAgain) {
      flushAgain = false;
      scheduleFlush(0);
    }
  }
  return ok;
}

function adoptServerSoldier(serverState, soldierId) {
  const srv =
    serverState && Array.isArray(serverState.soldiers)
      ? serverState.soldiers.find((s) => s.id === soldierId)
      : null;
  const loc = state.soldiers.find((s) => s.id === soldierId);
  if (srv && loc) {
    loc.name = srv.name;
    loc.team = srv.team;
    loc.rank = srv.rank;
    saveState(true);
    renderAll();
  }
}

function applyOutboxOverlay() {
  const box = outboxBox();
  if (!box) return;
  for (const [id, alive] of Object.entries(box.alive || {})) {
    const s = state.soldiers.find((x) => x.id === id);
    if (s) s.alive = alive;
  }
  if (box.removed && box.removed.length) {
    state.soldiers = state.soldiers.filter((s) => !box.removed.includes(s.id));
  }
  if (box.enlist && !state.soldiers.some((s) => s.id === box.enlist.id)) {
    state.soldiers.push({
      ...box.enlist,
      alive: true,
      stats: { survived: 0, kia: 0, matches: 0 }
    });
  }
  syncAliveCountFromRoster('A');
  syncAliveCountFromRoster('B');
}

function setConnectionState(next) {
  if (connectionState === next) return;
  connectionState = next;
  if (typeof document === 'undefined') return;
  let el = document.getElementById('connBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'connBanner';
    el.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:90;text-align:center;font:800 12px/1.6 system-ui;' +
      'text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;background:#f59e0b;color:#09090b;display:none';
    document.body.appendChild(el);
  }
  if (next === 'ONLINE' || next === 'IDLE') {
    el.style.display = 'none';
  } else {
    el.textContent =
      next === 'OFFLINE'
        ? '📡 Sem conexão — suas ações serão enviadas quando voltar'
        : '🔄 Reconectando à sala…';
    el.style.display = 'block';
  }
}

function computeIsCreator(row) {
  if (!row) return false;
  if ((cloudMeta.myCreatedRooms || []).some((r) => r.code === row.code)) return true;
  return Boolean(cloudMeta.authUser) && row.host_id === cloudMeta.deviceId; // mesmo aparelho que criou
}

function resyncFromServer(reason) {
  if (resyncInFlight) return resyncInFlight;
  resyncInFlight = resyncOnce(reason, false).finally(() => {
    resyncInFlight = null;
  });
  return resyncInFlight;
}

async function resyncOnce(reason, retried) {
  const code = cloudMeta.sessionCode;
  if (!supabaseClient || !code) return false;
  try {
    await flushOutbox();
    const { data, error } = await supabaseClient
      .from('tactical_sessions')
      .select('code, host_id, state, rev')
      .eq('code', code)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (cloudMeta.sessionCode !== code) return false;

    if (!data) {
      tacticalLogger.warn('CLOUD', `Sala ${code} não existe mais (${reason})`);
      showToast('🗑️', `A sala ${code} foi encerrada.`);
      leaveCloudSession();
      return false;
    }

    const isCreator = computeIsCreator(data);

    if (isCreator && !retried) {
      const localMatches = (state.stats && state.stats.totalMatches) || 0;
      const remoteMatches = (data.state && data.state.stats && data.state.stats.totalMatches) || 0;
      if (localMatches > remoteMatches) {
        tacticalLogger.warn(
          'CLOUD',
          `Preservando relatório local do Juiz (${localMatches} partidas vs ${remoteMatches} na nuvem)`
        );
        queueHostSync({ roster: true });
        await flushOutbox();
        return await resyncOnce(reason, true);
      }
    }
    if (data.state?.roomMeta?.isOnline === false && !isCreator) {
      showToast('🔴', `A sala ${code} está OFFLINE.`);
      leaveCloudSession();
      return false;
    }

    cloudMeta.role = isCreator ? 'HOST' : 'PLAYER';
    saveCloudMeta();
    lastSeenRev = Math.max(lastSeenRev, Number(data.rev) || 0);
    applyRemoteCloudState(data.state, { forceFullSync: true });
    lastFullSyncAt = Date.now();
    if (resyncRetryTimer) {
      clearTimeout(resyncRetryTimer);
      resyncRetryTimer = null;
    }
    setConnectionState('ONLINE');
    return true;
  } catch (e) {
    setConnectionState('OFFLINE');
    tacticalLogger.warn('CLOUD', `Resync falhou (${reason}); nova tentativa em breve`, e.message);
    if (!resyncRetryTimer) {
      resyncRetryTimer = setTimeout(() => {
        resyncRetryTimer = null;
        resyncFromServer('retry');
      }, 4000);
    }
    return false;
  }
}

async function ensureConnected(reason) {
  if (!cloudMeta.sessionCode || !supabaseClient) return;
  syncServerClock();
  const ok = await resyncFromServer(reason);
  const ch = realtimeChannel;
  if (ok && (!ch || ch.state !== 'joined')) subscribeToCloudSession(cloudMeta.sessionCode);
}

let connectivityHooksInstalled = false;
function installConnectivityHooks() {
  if (connectivityHooksInstalled) return;
  connectivityHooksInstalled = true;
  window.addEventListener('online', () => ensureConnected('online'));
  window.addEventListener('offline', () => setConnectionState('OFFLINE'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ensureConnected('visible');
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) ensureConnected('pageshow');
  });
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (document.visibilityState !== 'visible' || !cloudMeta.sessionCode || !supabaseClient) return;
    try {
      const { data, error } = await supabaseClient
        .from('tactical_sessions')
        .select('rev')
        .eq('code', cloudMeta.sessionCode)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) {
        resyncFromServer('heartbeat');
        return;
      }
      if (Number(data.rev) > lastSeenRev) resyncFromServer('heartbeat');
      else if (connectionState !== 'ONLINE') {
        setConnectionState('ONLINE');
        scheduleFlush(0);
      }
    } catch (e) {
      setConnectionState('OFFLINE');
    }
  }, 20000);
}
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// Fetch open online rooms so Soldiers can join with 1 tap without typing errors
async function fetchOpenOnlineRooms() {
  if (!initSupabaseClient()) return [];
  try {
    await ensureAuthSession();
    const rows = await rpc('rpc_open_rooms', {}); // 20 linhas leves, sem baixar estados completos
    openOnlineRoomsCache = (rows || []).map((r) => ({
      code: r.code,
      ownerName: r.owner_name || 'COMANDANTE',
      soldiersCount: r.soldiers_count || 0,
      matchesCount: r.matches_count || 0
    }));
    renderOpenRoomsQuickChips();
    return openOnlineRoomsCache;
  } catch (err) {
    tacticalLogger.warn('CLOUD', 'Falha ao buscar salas online', err && err.message);
    return [];
  }
}

function renderOpenRoomsQuickChips() {
  const containers = [
    { el: document.getElementById('openRoomsChipsAuthModal'), inputId: 'inputAuthJoinCode' },
    { el: document.getElementById('openRoomsChipsCloudModal'), inputId: 'inputJoinSessionCode' }
  ];

  containers.forEach(({ el, inputId }) => {
    if (!el) return;
    el.innerHTML = '';

    if (openOnlineRoomsCache.length === 0) {
      return;
    }

    const label = document.createElement('span');
    label.className = 'w-full text-[10px] font-tactical-mono font-bold uppercase text-lime-400';
    label.textContent = '🟢 SALAS ONLINE ABERTAS AGORA (TOQUE PARA PREENCHER):';
    el.appendChild(label);

    openOnlineRoomsCache.forEach((rm) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className =
        'px-2.5 py-1.5 rounded-lg bg-lime-400/15 hover:bg-lime-400/30 border border-lime-400/60 text-lime-300 font-tactical-mono font-black text-xs uppercase flex items-center gap-1.5 transition active:scale-95';
      chip.innerHTML = `
        <span>🟢 #${escapeHtml(rm.code)}</span>
        <span class="text-[10px] text-zinc-300 font-normal">(${rm.soldiersCount} op)</span>
      `;
      chip.addEventListener('click', () => {
        const inp = document.getElementById(inputId);
        if (inp) {
          inp.value = rm.code;
        }
        const otherInp =
          inputId === 'inputAuthJoinCode'
            ? document.getElementById('inputJoinSessionCode')
            : document.getElementById('inputAuthJoinCode');
        if (otherInp) {
          otherInp.value = rm.code;
        }
        showToast('🎯', `Sala #${rm.code} selecionada! Digite seu nome e clique em Entrar.`);
      });
      el.appendChild(chip);
    });
  });
}

// Fetch rooms created exclusively by the current creator (other users cannot see them in management)
async function fetchMyCreatedRooms() {
  if (!initSupabaseClient() || !cloudMeta.authUser) {
    cloudMeta.myCreatedRooms = [];
    renderMyCreatedRoomsList();
    return [];
  }
  try {
    const rows = await rpc('rpc_my_rooms', {}); // o servidor já filtra por auth.uid() (admin vê todas)
    cloudMeta.myCreatedRooms = (rows || []).map((r) => ({
      code: r.code,
      host_id: null,
      isOnline: r.is_online !== false,
      updated_at: r.updated_at,
      soldiersCount: r.soldiers_count || 0,
      matchesCount: r.matches_count || 0
    }));
    saveCloudMeta();
    renderMyCreatedRoomsList();
    return cloudMeta.myCreatedRooms;
  } catch (err) {
    tacticalLogger.error('CLOUD', 'Erro ao buscar salas do criador', err && err.message);
    renderMyCreatedRoomsList();
    return [];
  }
}

// Toggle a created room between ONLINE and OFFLINE (Creator exclusive action)
async function toggleMyRoomOnlineStatus(roomCode) {
  if (!initSupabaseClient()) return;
  const mine = (cloudMeta.myCreatedRooms || []).find((r) => r.code === roomCode);
  if (!mine) { showToast('🔒', 'Apenas o criador da sala pode alterar o status!'); return; }
  const nextOnline = !mine.isOnline;
  try {
    await rpc('rpc_host_patch', {
      p_code: roomCode, p_patch: { roomMeta: { isOnline: nextOnline } }, p_device_id: cloudMeta.deviceId, p_force: false
    });
  } catch (e) {
    showToast(String(e.message).includes('forbidden') ? '🔒' : '⚠️', 'Não foi possível alterar o status da sala.');
    return;
  }
  if (cloudMeta.sessionCode === roomCode) {
    state.roomMeta = { ...(state.roomMeta || {}), isOnline: nextOnline };
    saveState(true);
  }
  await fetchMyCreatedRooms();
  await fetchOpenOnlineRooms();
  renderAll();
  showToast(nextOnline ? '🟢' : '🔴', `Sala ${roomCode} agora está ${nextOnline ? 'ONLINE (Aberta)' : 'OFFLINE (Fechada)'}!`);
}

// Delete a created room permanently (Creator exclusive action)
async function deleteMyCreatedRoom(roomCode) {
  if (!initSupabaseClient()) return;
  if (!window.confirm(`CONFIRMAÇÃO TÁTICA:\nDeseja realmente EXCLUIR permanentemente a sala "${roomCode}" da nuvem?`)) return;
  try {
    await rpc('rpc_delete_room', { p_code: roomCode });
  } catch (e) {
    showToast('🔒', String(e.message).includes('forbidden') ? 'Apenas o criador da sala pode excluí-la!' : 'Não foi possível excluir a sala.');
    return;
  }
  if (cloudMeta.sessionCode === roomCode) leaveCloudSession();
  await fetchMyCreatedRooms();
  await fetchOpenOnlineRooms();
  showToast('🗑️', `Sala ${roomCode} excluída permanentemente!`);
}

// Create a new session (or safely resume if room already exists for same creator!)
async function createCloudSession() {
  if (!cloudMeta.authUser) {
    document.getElementById('modalCloudSession').classList.add('hidden');
    renderAuthModal();
    document.getElementById('modalAuth').classList.remove('hidden');
    showToast('🔐', 'Faça login ou crie sua conta para criar e gerenciar salas!');
    return;
  }
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
  syncRuntimeToLiveTimer();

  try {
    await ensureAuthSession({ anonymous: false });
    await fetchMyCreatedRooms();
    const isMine = (cloudMeta.myCreatedRooms || []).some((r) => r.code === inputCode);

    if (isMine) {
      // Sala minha: retoma SEM zerar relatórios/tempo (comportamento original preservado)
      const { data: row } = await supabaseClient.from('tactical_sessions').select('*').eq('code', inputCode).maybeSingle();
      if (row) {
        const hasData =
          (row.state?.stats?.totalMatches || 0) > 0 || (Array.isArray(row.state?.soldiers) && row.state.soldiers.length > 0);
        if (hasData) {
          cloudMeta.sessionCode = inputCode;
          cloudMeta.role = 'HOST';
          lastSeenRev = Number(row.rev) || 0;
          applyRemoteCloudState(row.state, { forceFullSync: true });
          saveCloudMeta();
          await fetchOpenOnlineRooms();
          subscribeToCloudSession(inputCode);
          updateUrlRoomParam(inputCode);
          renderAll();
          renderCloudModal();
          document.getElementById('modalCloudSession').classList.add('hidden');
          document.getElementById('modalAuth').classList.add('hidden');
          showToast('👑', `Sala ${inputCode} retomada com relatórios e configurações preservados!`);
          return;
        }
        // sala minha e vazia: só reaplica a configuração atual
        await rpc('rpc_host_patch', { p_code: inputCode, p_patch: buildHostPatch(), p_device_id: cloudMeta.deviceId, p_force: true });
      }
    } else {
      state.roomMeta = { ownerName: cloudMeta.authUser.name, ownerDeviceId: cloudMeta.deviceId, isOnline: true };
      await rpc('rpc_create_room', {
        p_code: inputCode,
        p_state: buildCloudStatePayload(true, state.roomMeta),
        p_device_id: cloudMeta.deviceId,
        p_owner_name: cloudMeta.authUser.name
      });
    }

    cloudMeta.sessionCode = inputCode;
    cloudMeta.role = 'HOST';
    lastSeenRev = 0;
    lastSentRosterSig = null;
    saveCloudMeta();
    queueHostSync({ roster: true }); // garante o roster atual no servidor (idempotente)
    await fetchMyCreatedRooms();
    await fetchOpenOnlineRooms();
    subscribeToCloudSession(inputCode);
    updateUrlRoomParam(inputCode);
    renderAll();
    renderCloudModal();
    showToast('🚀', `Sessão ${inputCode} criada e ONLINE! Compartilhe o código.`);
  } catch (err) {
    const msg = String((err && err.message) || '');
    if (msg.includes('code_taken')) showToast('⚠️', `O código ${inputCode} já pertence a outro criador! Clique em 🎲 GERAR.`);
    else if (msg.includes('too_many_rooms')) showToast('⚠️', 'Limite de 20 salas atingido. Exclua alguma antiga.');
    else if (msg.includes('auth_required')) showToast('🔐', 'Sessão expirada. Entre novamente na sua conta.');
    else {
      tacticalLogger.error('CLOUD', 'Erro ao criar sala', msg);
      showToast('⚠️', 'Erro ao criar sala. Verifique os Logs (🐞)!');
    }
  }
}

// Join an existing session as Operator/Participant (or recover Host if creator)
async function joinCloudSession(customCodeOverride = null) {
  if (!initSupabaseClient()) {
    document.getElementById('supabaseConfigAccordion').open = true;
    showToast('⚙️', 'Configure a URL e Anon Key do Supabase abaixo primeiro!');
    return false;
  }

  const rawCode =
    customCodeOverride ||
    document.getElementById('inputJoinSessionCode')?.value ||
    document.getElementById('inputAuthJoinCode')?.value;
  let code = sanitizeSessionCode(rawCode);
  if (!code) {
    showToast('⚠️', 'Digite ou selecione o código da sala para entrar!');
    return false;
  }

  let operatorName = (document.getElementById('inputJoinOperatorName').value || '')
    .trim()
    .toUpperCase();
  if (!operatorName && cloudMeta.authUser?.name) {
    operatorName = cloudMeta.authUser.name.toUpperCase();
  }
  const chosenTeam = cloudMeta.joinSelectedTeam === 'B' ? 'B' : 'A';

  // Identidade anônima invisível (1 chamada): é o que o servidor usa para saber "este soldado é seu"
  const session = await ensureAuthSession();
  if (!session) {
    showToast('📡', 'Sem conexão para entrar agora. Tente de novo.');
    return false;
  }

  try {
    let { data, error } = await supabaseClient
      .from('tactical_sessions')
      .select('*')
      .eq('code', code)
      .maybeSingle();

    // Smart Fuzzy Match: se digitou "ALPHA42" em vez de "ALPHA-42", acha pela lista leve de salas abertas
    if (!data && !error) {
      const normalized = code.replace(/[^A-Z0-9]/g, '');
      const open = await rpc('rpc_open_rooms', {}).catch(() => []);
      const hit = (open || []).find((r) => String(r.code).replace(/[^A-Z0-9]/g, '') === normalized);
      if (hit) {
        code = hit.code;
        ({ data, error } = await supabaseClient
          .from('tactical_sessions')
          .select('*')
          .eq('code', code)
          .maybeSingle());
      }
    }

    if (error || !data) {
      tacticalLogger.warn('CLOUD', `Tentativa de entrar em sala inexistente: "${code}"`, error?.message);
      await fetchOpenOnlineRooms();
      showToast('❌', `Sala "${code}" não encontrada! Toque em uma das salas online listadas.`);
      return false;
    }

    const isCreator = computeIsCreator(data);

    const isRoomOnline = data.state?.roomMeta?.isOnline !== false;
    if (!isRoomOnline && !isCreator) {
      tacticalLogger.warn('CLOUD', `Tentativa de entrada bloqueada: sala ${code} está OFFLINE`);
      showToast('🔴', `A sala "${code}" está OFFLINE no momento (desativada pelo criador).`);
      return false;
    }

    cloudMeta.sessionCode = code;
    cloudMeta.role = isCreator ? 'HOST' : 'PLAYER';
    lastSeenRev = Number(data.rev) || 0;
    lastSentRosterSig = null;
    lastFullSyncAt = Date.now();

    // Apply fetched room state with full sync
    applyRemoteCloudState(data.state, { forceFullSync: true });

    // Auto-enlist operator if name was entered (for Players, or if Host explicitly typed a soldier name in Join box)
    const typedName = (document.getElementById('inputJoinOperatorName').value || '').trim();
    const shouldEnlist = operatorName && (!isCreator || typedName);

    if (shouldEnlist) {
      let mine = cloudMeta.mySoldierId && state.soldiers.find((s) => s.id === cloudMeta.mySoldierId);
      const rank = cloudMeta.selectedSoldierRank || (mine && mine.rank) || 'EXPERIENTE';
      if (mine) {
        mine.name = operatorName;
        mine.team = chosenTeam;
        mine.rank = rank;
      } else {
        mine = {
          id: 'op_' + cloudMeta.deviceId.slice(-6) + '_' + Date.now().toString(36),
          name: operatorName,
          team: chosenTeam,
          rank,
          alive: true,
          stats: { survived: 0, kia: 0, matches: 0 }
        };
        state.soldiers.push(mine);
      }
      cloudMeta.mySoldierId = mine.id;
      syncAliveCountFromRoster('A');
      syncAliveCountFromRoster('B');
      queueEnlist(mine);
      saveState(true);
    }

    saveCloudMeta();
    subscribeToCloudSession(code);
    syncServerClock();
    updateUrlRoomParam(code);
    renderAll();
    renderCloudModal();
    document.getElementById('modalCloudSession').classList.add('hidden');
    document.getElementById('modalAuth').classList.add('hidden');

    tacticalLogger.info(
      'CLOUD',
      `Conectado à sala #${code} como ${cloudMeta.role} (${operatorName || 'COMANDANTE'})`
    );

    showToast(
      '📡',
      isCreator
        ? `Comando da sala #${code} assumido em tempo real!`
        : operatorName
        ? `Conectado à sala #${code} como ${operatorName}!`
        : `Conectado à sala #${code} em tempo real!`
    );
    return true;
  } catch (err) {
    tacticalLogger.error('CLOUD', `Exceção ao entrar na sala ${code}`, err?.message || String(err));
    showToast('⚠️', 'Erro ao entrar na sessão. Verifique os Logs (🐞).');
    return false;
  }
}

function subscribeToCloudSession(code) {
  if (!supabaseClient || !code) return;
  if (realtimeChannel) {
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  realtimeConnectionStatus = 'CONNECTING...';
  if (connectionState !== 'OFFLINE') setConnectionState('RECONNECTING');

  realtimeChannel = supabaseClient
    .channel(`room_${code}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'tactical_sessions', filter: `code=eq.${code}` },
      (payload) => {
        if (payload.eventType === 'DELETE') {
          tacticalLogger.warn('CLOUD', `A sala ${code} foi excluída remotamente`);
          showToast('🗑️', `A sala ${code} foi encerrada e excluída pelo criador.`);
          leaveCloudSession();
          return;
        }
        const row = payload.new;
        if (!row || !row.state) return;
        const rev = Number(row.rev);
        if (Number.isFinite(rev)) {
          if (rev < lastSeenRev) return;
          lastSeenRev = rev;
        }
        if (row.state?.roomMeta?.isOnline === false && cloudMeta.role !== 'HOST') {
          showToast('🔴', `O criador colocou a sala ${code} em modo OFFLINE.`);
          leaveCloudSession();
          return;
        }
        applyRemoteCloudState(row.state, { forceFullSync: false });
      }
    )
    .subscribe((status, err) => {
      realtimeConnectionStatus = status || 'UNKNOWN';
      if (status === 'SUBSCRIBED') {
        tacticalLogger.info('CLOUD', `WebSocket Realtime conectado na sala #${code}`);
        setConnectionState('ONLINE');
        if (Date.now() - lastFullSyncAt > 1500) resyncFromServer('subscribed');
        startHeartbeat();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (cloudMeta.sessionCode === code) setConnectionState('RECONNECTING');
        tacticalLogger.warn('CLOUD', `Canal Realtime da sala #${code}: ${status}`, err?.message || '');
      }
      renderLogsModal();
    });
}

function mergeRemoteSoldiersIntoHost(incoming) {
  const box = outboxBox();
  const removed = new Set((box && box.removed) || []);
  const localById = new Map(state.soldiers.map((s) => [s.id, s]));
  const incIds = new Set(incoming.map((s) => s.id));

  const merged = incoming
    .filter((s) => !removed.has(s.id))
    .map((inc) => {
      const loc = localById.get(inc.id);
      const keepLocalStats =
        loc && ((loc.stats && loc.stats.matches) || 0) > ((inc.stats && inc.stats.matches) || 0);
      return {
        ...inc,
        stats: keepLocalStats ? loc.stats : inc.stats || { survived: 0, kia: 0, matches: 0 }
      };
    });
  for (const loc of state.soldiers) {
    if (!incIds.has(loc.id) && !removed.has(loc.id)) merged.push(loc);
  }
  state.soldiers = merged;
}

function applyRemoteCloudState(remoteState, options = { forceFullSync: false }) {
  if (!remoteState) return;

  // 1. Eco do próprio aparelho (a menos que seja sincronização completa)
  if (
    !options.forceFullSync &&
    remoteState.lastMutationBy &&
    remoteState.lastMutationBy === cloudMeta.deviceId
  ) {
    return;
  }

  isApplyingRemoteUpdate = true;
  try {
    const prevMuted = state.settings.muted;
    const def = getDefaultState();
    const remoteSoldiers = Array.isArray(remoteState.soldiers) ? remoteState.soldiers : [];

    // 2. Juiz recebendo evento de Player
    if (
      !options.forceFullSync &&
      cloudMeta.role === 'HOST' &&
      remoteState.lastMutationRole === 'PLAYER'
    ) {
      mergeRemoteSoldiersIntoHost(remoteSoldiers);
      applyOutboxOverlay();
      syncAliveCountFromRoster('A');
      syncAliveCountFromRoster('B');

      if (runtime.phase === 'COMBAT') {
        for (const k of ['A', 'B']) {
          if (state.teams[k].aliveCount === 0 && getTeamSoldiers(k).length > 0) {
            isApplyingRemoteUpdate = false;
            finishMatchAndOpenVerification(`ELIMINAÇÃO TOTAL (${state.teams[k].name} ZERADO)`, k);
            return;
          }
        }
      }
      saveState(true);
      renderAll();
      return;
    }

    // 3. Sincronização completa
    state.teams = {
      A: { ...def.teams.A, ...(remoteState.teams?.A || {}) },
      B: { ...def.teams.B, ...(remoteState.teams?.B || {}) }
    };
    state.soldiers = remoteSoldiers.map((s) => ({ ...s }));
    state.settings = { ...def.settings, ...(remoteState.settings || {}), muted: prevMuted };
    state.stats = { ...def.stats, ...(remoteState.stats || {}) };
    state.liveTimer = { ...def.liveTimer, ...(remoteState.liveTimer || {}) };
    if (remoteState.roomMeta) {
      state.roomMeta = { ...(state.roomMeta || {}), ...remoteState.roomMeta };
    }

    applyOutboxOverlay();

    if (
      cloudMeta.role === 'PLAYER' &&
      cloudMeta.mySoldierId &&
      !state.soldiers.some((s) => s.id === cloudMeta.mySoldierId) &&
      !(outboxBox() && outboxBox().enlist)
    ) {
      cloudMeta.mySoldierId = null;
      saveCloudMeta();
      showToast('🪖', 'Seu operador não está mais na sala. Entre novamente para se alistar.');
    }

    syncRuntimeFromRemoteLiveTimer({ silent: Boolean(options.forceFullSync) });

    if (isHostOrLocal() && runtime.phase === 'COMBAT') {
      for (const k of ['A', 'B']) {
        if (state.teams[k].aliveCount === 0 && getTeamSoldiers(k).length > 0) {
          isApplyingRemoteUpdate = false;
          finishMatchAndOpenVerification(`ELIMINAÇÃO TOTAL (${state.teams[k].name} ZERADO)`, k);
          return;
        }
      }
    }

    saveState(true);
    renderAll();
  } finally {
    isApplyingRemoteUpdate = false;
  }
}

function leaveCloudSession(opts = {}) {
  const wasPlayer = cloudMeta.role === 'PLAYER';
  if (realtimeChannel && supabaseClient) {
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  stopHeartbeat();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (resyncRetryTimer) {
    clearTimeout(resyncRetryTimer);
    resyncRetryTimer = null;
  }
  lastSeenRev = 0;
  lastSentRosterSig = null;
  setConnectionState('IDLE');

  cloudMeta.sessionCode = null;
  cloudMeta.role = 'LOCAL';
  saveCloudMeta();
  updateUrlRoomParam(null);

  if (wasPlayer) {
    clearMatchInterval();
    runtime.phase = 'IDLE';
    runtime.pausedFrom = null;
    runtime.lastAnnouncedPhase = 'IDLE';
    runtime.remainingPrepSec = state.settings.prepSeconds;
    runtime.combatSeconds =
      state.settings.mode === 'TIME_LIMIT' ? state.settings.timeLimitMinutes * 60 : 0;
    state.liveTimer = getDefaultState().liveTimer;
    saveState(true);
  }
  renderAll();
  renderCloudModal();
  if (!opts.silent) showToast('🚪', 'Você saiu da sessão na nuvem. Modo Local ativado.');
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
let clockOffsetMs = 0; // (relógio do servidor) - (Date.now() local)

function getServerNow() {
  return Date.now() + clockOffsetMs;
}

async function syncServerClock(samples = 5) {
  if (!supabaseClient) return;
  let best = null;
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    try {
      const serverMs = Number(await rpc('server_now_ms', {}));
      const t1 = Date.now();
      const rtt = t1 - t0;
      if (Number.isFinite(serverMs) && (!best || rtt < best.rtt)) {
        best = { rtt, offset: serverMs - (t0 + t1) / 2 };
      }
    } catch (e) {
      break;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (best && best.rtt < 4000) {
    const next = Math.round(best.offset);
    if (Math.abs(next - clockOffsetMs) > 250 || clockOffsetMs === 0) {
      clockOffsetMs = next;
      tacticalLogger.info('TIMER', `Relógio sincronizado: offset ${clockOffsetMs}ms (rtt ${best.rtt}ms)`);
    }
  }
}

function isTimerPhase(p) {
  return p === 'PREP' || p === 'COMBAT';
}

function phaseElapsedSec(lt) {
  return Math.max(0, Math.floor((getServerNow() - lt.phaseStartedAt) / 1000));
}

function refreshRuntimeFromClock() {
  const lt = state.liveTimer;
  if (!lt || !lt.phaseStartedAt) return;
  if (runtime.phase === 'PREP') {
    runtime.remainingPrepSec = Math.max(
      0,
      (lt.initialPrepSec ?? state.settings.prepSeconds) - phaseElapsedSec(lt)
    );
  } else if (runtime.phase === 'COMBAT') {
    const el = phaseElapsedSec(lt);
    runtime.combatSeconds =
      state.settings.mode === 'TIME_LIMIT'
        ? Math.max(0, (lt.initialCombatSec ?? state.settings.timeLimitMinutes * 60) - el)
        : (lt.initialCombatSec || 0) + el;
  }
}

function syncRuntimeToLiveTimer() {
  state.liveTimer = {
    phase: runtime.phase,
    pausedFrom: runtime.pausedFrom,
    phaseStartedAt: isTimerPhase(runtime.phase) ? getServerNow() : null,
    initialPrepSec: runtime.remainingPrepSec,
    initialCombatSec: runtime.combatSeconds,
    snapshotRemainingPrepSec: runtime.remainingPrepSec,
    snapshotCombatSec: runtime.combatSeconds
  };
}

function clearMatchInterval() {
  if (runtime.timerInterval) {
    clearTimeout(runtime.timerInterval);
    runtime.timerInterval = null;
  }
}

function startTimerLoop() {
  clearMatchInterval();
  if (!isTimerPhase(runtime.phase) || !state.liveTimer || !state.liveTimer.phaseStartedAt) return;

  const loop = () => {
    runtime.timerInterval = null;
    if (!isTimerPhase(runtime.phase) || !state.liveTimer || !state.liveTimer.phaseStartedAt) return;
    unifiedTick();
    if (!isTimerPhase(runtime.phase) || runtime.timerInterval) return;
    const intoSecond = (((getServerNow() - state.liveTimer.phaseStartedAt) % 1000) + 1000) % 1000;
    runtime.timerInterval = setTimeout(loop, 1000 - intoSecond + 4);
  };
  loop();
}

function unifiedTick() {
  const host = isHostOrLocal();

  if (runtime.phase === 'PREP') {
    const prev = runtime.remainingPrepSec;
    refreshRuntimeFromClock();
    const rem = runtime.remainingPrepSec;
    if (rem <= 0) {
      if (host) {
        enterCombatPhase();
      } else {
        renderChronometer();
      }
      return;
    }
    if (rem !== prev) {
      if (rem > 10) {
        if (rem % 15 === 0) audioEngine.playDoubleBeep();
      } else {
        audioEngine.playCountdownBeep(rem);
      }
    }
    renderChronometer();
  } else if (runtime.phase === 'COMBAT') {
    const prev = runtime.combatSeconds;
    refreshRuntimeFromClock();
    if (state.settings.mode === 'TIME_LIMIT') {
      if (runtime.combatSeconds <= 0) {
        runtime.combatSeconds = 0;
        renderChronometer();
        if (host) finishMatchAndOpenVerification('TEMPO ESGOTADO (00:00)', null);
        return;
      }
      if (runtime.combatSeconds !== prev && runtime.combatSeconds <= 10) {
        audioEngine.playCountdownBeep(runtime.combatSeconds);
      }
    }
    renderChronometer();
  }
}

function syncRuntimeFromRemoteLiveTimer(opts = {}) {
  const lt = state.liveTimer;
  if (!lt) return;

  const oldPhase = runtime.phase;
  runtime.phase = lt.phase || 'IDLE';
  runtime.pausedFrom = lt.pausedFrom || null;

  if (oldPhase !== runtime.phase && runtime.lastAnnouncedPhase !== runtime.phase) {
    runtime.lastAnnouncedPhase = runtime.phase;
    if (!opts.silent) {
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
  }

  if (isTimerPhase(runtime.phase) && lt.phaseStartedAt) {
    refreshRuntimeFromClock();
    startTimerLoop();
  } else {
    clearMatchInterval();
    runtime.remainingPrepSec = lt.snapshotRemainingPrepSec ?? state.settings.prepSeconds;
    runtime.combatSeconds =
      lt.snapshotCombatSec ??
      (state.settings.mode === 'TIME_LIMIT' ? state.settings.timeLimitMinutes * 60 : 0);
  }
}

function restoreRuntimeFromLiveTimer() {
  const lt = state.liveTimer;
  if (!lt || !lt.phase || lt.phase === 'IDLE') return;
  syncRuntimeFromRemoteLiveTimer({ silent: true });
  if (runtime.phase === 'PREP' || runtime.phase === 'COMBAT') requestWakeLock();
  if (runtime.phase === 'VERIFY' && isHostOrLocal()) {
    finishMatchAndOpenVerification('CONFERÊNCIA RETOMADA', null, { silent: true });
  }
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
  if (cloudMeta.role === 'HOST') queueHostSync({ roster: true, resetAlive: true });
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

  let flipped = null;
  const teamSoldiers = getTeamSoldiers(teamKey);
  if (teamSoldiers.length > 0) {
    if (delta < 0) {
      const aliveList = teamSoldiers.filter((s) => s.alive);
      if (aliveList.length > next) {
        flipped = aliveList[aliveList.length - 1];
        flipped.alive = false;
      }
    } else if (delta > 0) {
      const kiaList = teamSoldiers.filter((s) => !s.alive);
      if (kiaList.length > 0 && teamSoldiers.filter((s) => s.alive).length < next) {
        flipped = kiaList[0];
        flipped.alive = true;
      }
    }
  }

  if (flipped) queueSoldierAlive(flipped);
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
  queueSoldierAlive(soldier);

  audioEngine.playTone(soldier.alive ? 920 : 310, 80, 'triangle', 0.2);
  saveState(true);
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
    startTimerLoop();
  } else {
    enterCombatPhase();
  }
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

  startTimerLoop();
}

function togglePauseResumeMatch() {
  if (!isHostOrLocal()) return;

  if (runtime.phase === 'PREP' || runtime.phase === 'COMBAT') {
    refreshRuntimeFromClock();
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
    startTimerLoop();
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
  eliminatedTeamKey = null,
  opts = {}
) {
  if (!isHostOrLocal()) return;
  if (isTimerPhase(runtime.phase)) refreshRuntimeFromClock();

  clearMatchInterval();
  if (runtime.phase === 'PREP' || runtime.phase === 'COMBAT') {
    runtime.pausedFrom = runtime.phase;
  }
  runtime.phase = 'VERIFY';
  runtime.lastAnnouncedPhase = 'VERIFY';
  releaseWakeLock();
  syncRuntimeToLiveTimer();
  saveState();

  if (!opts.silent) audioEngine.announceGameOver();

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
  tacticalLogger.info(
    'TIMER',
    `Round #${state.stats.totalMatches} finalizado e salvo no relatório (${msg})`,
    { countA, countB, totalMatches: state.stats.totalMatches }
  );
  showToast('🏆', msg);
}

/* ==========================================================================
   ROSTER MANAGEMENT (ALISTAMENTO & EQUILIBRAR TIMES)
   ========================================================================== */
function addSoldier(nameRaw, teamKey, bindToCurrentDevice = false, rankOverride = null) {
  const name = (nameRaw || '').trim().toUpperCase();
  if (!name) return;

  const rank = getSoldierRankInfo(rankOverride || cloudMeta.selectedSoldierRank || 'EXPERIENTE').id;

  const newSoldier = {
    id: 'op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name,
    team: teamKey === 'B' ? 'B' : 'A',
    rank,
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
  if (cloudMeta.role === 'PLAYER') queueEnlist(newSoldier);
  saveState();
  renderAll();
  renderRosterModal();

  const input = document.getElementById('inputSoldierName');
  if (input) {
    input.value = '';
    input.focus();
  }
}

function cycleSoldierRank(soldierId) {
  if (cloudMeta.role === 'PLAYER' && soldierId !== cloudMeta.mySoldierId) {
    showToast('🔒', 'Só o Juiz altera outros operadores.');
    return;
  }
  const soldier = state.soldiers.find((s) => s.id === soldierId);
  if (!soldier) return;

  const order = ['RECRUTA', 'EXPERIENTE', 'MATADOR'];
  const currentIdx = order.indexOf(getSoldierRankInfo(soldier.rank).id);
  const nextRank = order[(currentIdx + 1) % order.length];
  soldier.rank = nextRank;

  if (cloudMeta.role === 'PLAYER') queueEnlist(soldier);
  saveState();
  renderAll();
  renderRosterModal();
}

function switchSoldierTeam(soldierId) {
  if (cloudMeta.role === 'PLAYER' && soldierId !== cloudMeta.mySoldierId) {
    showToast('🔒', 'Só o Juiz altera outros operadores.');
    return;
  }
  const soldier = state.soldiers.find((s) => s.id === soldierId);
  if (!soldier) return;

  soldier.team = soldier.team === 'A' ? 'B' : 'A';
  soldier.alive = true;

  syncAliveCountFromRoster('A');
  syncAliveCountFromRoster('B');
  if (cloudMeta.role === 'PLAYER') queueEnlist(soldier);
  saveState();
  renderAll();
  renderRosterModal();
}

function deleteSoldier(soldierId) {
  if (cloudMeta.role === 'PLAYER' && soldierId !== cloudMeta.mySoldierId) {
    showToast('🔒', 'Só o Juiz remove outros operadores.');
    return;
  }
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

  if (cloudMeta.role === 'HOST') queueHostSync({ roster: true, removedIds: [soldierId] });
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

  // Sort by combat rank weight (Matador -> Experiente -> Recruta) after randomizing so both squads receive balanced skill levels
  shuffled.sort((a, b) => getSoldierRankInfo(b.rank).weight - getSoldierRankInfo(a.rank).weight);

  const startWithB = Math.random() < 0.5;
  shuffled.forEach((s, idx) => {
    const mod = idx % 2;
    s.team = startWithB ? (mod === 0 ? 'B' : 'A') : mod === 0 ? 'A' : 'B';
    s.alive = true;
  });

  state.soldiers = shuffled;
  syncAliveCountFromRoster('A');
  syncAliveCountFromRoster('B');
  if (cloudMeta.role === 'HOST') queueHostSync({ roster: true, resetAlive: true });
  saveState();
  renderAll();
  renderRosterModal();
  audioEngine.playDoubleBeep();
  showToast('🎲', 'Times sorteados e equilibrados por nível (Recruta / Experiente / Matador)!');
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
      const rankInfo = getSoldierRankInfo(s.rank);
      const medal =
        idx === 0 && surv > 0 ? '🥇 [IMORTAL]' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}º`;
      lines.push(
        `${medal} *${s.name}* [${rankInfo.icon} ${rankInfo.label}] (${tName}) — 🛡️ ${surv}x Vivo | 💀 ${kia} KIA | 📈 ${rate}% (${matches}j)`
      );
    });
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`⚡ _Desenvolvido por SOLia Labs_`);
  lines.push(`🔗 https://www.instagram.com/soliaoficial`);

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
    const rankInfo = getSoldierRankInfo(mySoldier.rank);
    playerHud.classList.remove('hidden');
    document.getElementById('playerHudSessionCode').textContent = `#${cloudMeta.sessionCode}`;
    document.getElementById('playerHudName').textContent = `${mySoldier.name} (${rankInfo.icon} ${rankInfo.label})`;

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

function renderHeaderAuthButton() {
  const icon = document.getElementById('headerUserIcon');
  const nameEl = document.getElementById('headerUserName');
  const roleBadge = document.getElementById('headerUserRoleBadge');
  const btn = document.getElementById('btnOpenAuthModal');

  if (!btn) return;

  if (cloudMeta.authUser) {
    icon.textContent = cloudMeta.authUser.isAdmin ? '👑' : '🪖';
    nameEl.textContent = cloudMeta.authUser.name;
    roleBadge.classList.remove('hidden');
    if (cloudMeta.authUser.isAdmin) {
      roleBadge.textContent = 'ADM';
      roleBadge.className =
        'shrink-0 px-1.5 py-0.5 text-[10px] font-tactical-mono rounded bg-amber-400 text-zinc-950 font-black';
      btn.className =
        'w-full sm:w-auto px-2.5 sm:px-3.5 h-[46px] rounded-xl bg-amber-500/15 hover:bg-amber-500/25 active:scale-95 border-2 border-amber-400 text-white font-extrabold text-xs sm:text-sm uppercase tracking-wider flex items-center justify-center gap-1.5 whitespace-nowrap overflow-hidden transition';
    } else {
      roleBadge.textContent = 'OP';
      roleBadge.className =
        'shrink-0 px-1.5 py-0.5 text-[10px] font-tactical-mono rounded bg-sky-400 text-zinc-950 font-black';
      btn.className =
        'w-full sm:w-auto px-2.5 sm:px-3.5 h-[46px] rounded-xl bg-zinc-900 hover:bg-zinc-800 active:scale-95 border-2 border-sky-400/70 text-white font-extrabold text-xs sm:text-sm uppercase tracking-wider flex items-center justify-center gap-1.5 whitespace-nowrap overflow-hidden transition';
    }
  } else {
    icon.textContent = '🔐';
    nameEl.textContent = 'CONTA';
    roleBadge.classList.add('hidden');
    btn.className =
      'w-full sm:w-auto px-2.5 sm:px-3.5 h-[46px] rounded-xl bg-zinc-950 hover:bg-zinc-800 active:scale-95 border-2 border-lime-400/70 text-white font-extrabold text-xs sm:text-sm uppercase tracking-wider flex items-center justify-center gap-1.5 whitespace-nowrap overflow-hidden transition';
  }
}

function renderRankSelectorButtons() {
  const selected = getSoldierRankInfo(cloudMeta.selectedSoldierRank).id;
  document.querySelectorAll('[data-rank-select]').forEach((btn) => {
    const rankId = btn.getAttribute('data-rank-select');
    const isSelected = rankId === selected;

    if (!isSelected) {
      btn.className =
        'min-h-[42px] rounded-xl border-2 border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-white font-black text-xs uppercase tracking-wider transition';
      return;
    }

    if (rankId === 'RECRUTA') {
      btn.className =
        'min-h-[42px] rounded-xl border-2 border-emerald-400 bg-emerald-500/25 text-white font-black text-xs uppercase tracking-wider shadow transition';
    } else if (rankId === 'MATADOR') {
      btn.className =
        'min-h-[42px] rounded-xl border-2 border-red-500 bg-red-600/25 text-white font-black text-xs uppercase tracking-wider shadow transition';
    } else {
      btn.className =
        'min-h-[42px] rounded-xl border-2 border-amber-400 bg-amber-500/25 text-white font-black text-xs uppercase tracking-wider shadow transition';
    }
  });
}

function renderAuthModal() {
  renderRankSelectorButtons();
  const loggedInView = document.getElementById('authLoggedInView');
  const loggedOutView = document.getElementById('authLoggedOutView');
  if (!loggedInView || !loggedOutView) return;

  // Show Active Room Quick Resume Banner if already connected to a session
  const activeBanner = document.getElementById('authActiveRoomQuickBanner');
  const activeCodeText = document.getElementById('authActiveRoomCodeText');
  if (activeBanner && activeCodeText) {
    if (cloudMeta.sessionCode) {
      activeBanner.classList.remove('hidden');
      activeCodeText.textContent = `#${cloudMeta.sessionCode} (${cloudMeta.role === 'HOST' ? 'JUIZ' : 'SOLDADO'})`;
    } else {
      activeBanner.classList.add('hidden');
    }
  }

  // Update team button labels in Quick Join inside Auth Modal
  const btnAuthJoinA = document.getElementById('btnAuthJoinTeamA');
  const btnAuthJoinB = document.getElementById('btnAuthJoinTeamB');
  if (btnAuthJoinA && btnAuthJoinB) {
    btnAuthJoinA.textContent = `🛡️ TIME A (${state.teams.A.name})`;
    btnAuthJoinB.textContent = `⚔️ TIME B (${state.teams.B.name})`;

    if (cloudMeta.joinSelectedTeam === 'B') {
      btnAuthJoinB.className =
        'min-h-[46px] rounded-xl border-2 border-red-500 bg-red-600/25 text-white font-black text-xs uppercase tracking-wider';
      btnAuthJoinA.className =
        'min-h-[46px] rounded-xl border-2 border-zinc-700 bg-zinc-900 text-zinc-400 font-black text-xs uppercase tracking-wider';
    } else {
      btnAuthJoinA.className =
        'min-h-[46px] rounded-xl border-2 border-blue-500 bg-blue-600/25 text-white font-black text-xs uppercase tracking-wider';
      btnAuthJoinB.className =
        'min-h-[46px] rounded-xl border-2 border-zinc-700 bg-zinc-900 text-zinc-400 font-black text-xs uppercase tracking-wider';
    }
  }

  if (cloudMeta.authUser) {
    loggedInView.classList.remove('hidden');
    loggedOutView.classList.add('hidden');

    document.getElementById('authProfileName').textContent = cloudMeta.authUser.name;
    document.getElementById('authProfileEmail').textContent = cloudMeta.authUser.email;

    const badge = document.getElementById('authProfileRoleBadge');
    if (cloudMeta.authUser.isAdmin) {
      badge.textContent = '👑 ADMINISTRADOR MASTER (ADM)';
      badge.className =
        'inline-block px-2.5 py-0.5 rounded bg-amber-400 text-zinc-950 font-tactical-mono font-black text-xs uppercase';
    } else {
      badge.textContent = '🪖 USUÁRIO AUTENTICADO (CRIADOR)';
      badge.className =
        'inline-block px-2.5 py-0.5 rounded bg-sky-400 text-zinc-950 font-tactical-mono font-black text-xs uppercase';
    }
    renderMyCreatedRoomsList();
  } else {
    loggedInView.classList.add('hidden');
    loggedOutView.classList.remove('hidden');
  }
}

function renderMyCreatedRoomsList() {
  const container = document.getElementById('myCreatedRoomsList');
  const authQuickContainer = document.getElementById('authQuickMyRoomsList');
  const rooms = cloudMeta.myCreatedRooms || [];

  // Render 1-Click Quick List inside Main Login Screen (#authLoggedInView)
  if (authQuickContainer) {
    authQuickContainer.innerHTML = '';
    if (rooms.length === 0) {
      authQuickContainer.innerHTML = `
        <div class="py-2.5 px-3 rounded-lg border border-dashed border-zinc-800 text-center text-[11px] text-zinc-500">
          Nenhuma sala criada ainda. Clique em "🚀 CRIAR / GERENCIAR SALAS" abaixo para abrir uma nova!
        </div>
      `;
    } else {
      rooms.forEach((rm) => {
        const isCurrent = cloudMeta.sessionCode === rm.code;
        const item = document.createElement('div');
        item.className = `flex items-center justify-between gap-2 p-2 rounded-xl border ${
          isCurrent ? 'bg-zinc-900 border-lime-400' : 'bg-zinc-900/80 border-zinc-800'
        }`;
        item.innerHTML = `
          <div class="flex items-center gap-2 min-w-0">
            <span class="px-2 py-0.5 rounded font-tactical-mono font-black text-xs ${
              rm.isOnline ? 'bg-lime-400/20 text-lime-400' : 'bg-red-500/20 text-red-400'
            }">
              #${escapeHtml(rm.code)}
            </span>
            <span class="text-[11px] text-zinc-400 font-tactical-mono truncate">
              ${rm.soldiersCount} op • ${rm.matchesCount} j
            </span>
          </div>
          <button
            type="button"
            data-quick-enter-room="${escapeHtml(rm.code)}"
            class="shrink-0 min-h-[36px] px-3 rounded-lg bg-lime-400 hover:bg-lime-300 text-zinc-950 font-black text-xs uppercase"
          >
            ${isCurrent ? '🟢 ABRIR SALA' : '👑 ENTRAR'}
          </button>
        `;
        item.querySelector('[data-quick-enter-room]').addEventListener('click', async () => {
          document.getElementById('inputJoinSessionCode').value = rm.code;
          await joinCloudSession(rm.code);
        });
        authQuickContainer.appendChild(item);
      });
    }
  }

  if (!container) return;
  container.innerHTML = '';

  if (rooms.length === 0) {
    container.innerHTML = `
      <div class="py-5 px-4 rounded-xl border border-dashed border-zinc-800 text-center text-xs text-zinc-500">
        Nenhuma sala criada por você ainda. Crie uma sessão acima para gerenciá-la exclusivamente aqui!
      </div>
    `;
    return;
  }

  rooms.forEach((rm) => {
    const isCurrent = cloudMeta.sessionCode === rm.code;
    const row = document.createElement('div');
    row.className = `flex flex-wrap items-center justify-between gap-2.5 p-3 rounded-xl border ${
      isCurrent
        ? 'bg-zinc-900 border-lime-400/80'
        : 'bg-zinc-900/70 border-zinc-800'
    }`;

    row.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="px-2.5 py-1 rounded-lg font-tactical-mono font-black text-sm ${
          rm.isOnline
            ? 'bg-lime-400/15 text-lime-400 border border-lime-400/40'
            : 'bg-red-500/15 text-red-400 border border-red-500/40'
        }">
          #${escapeHtml(rm.code)}
        </span>
        <div>
          <div class="flex items-center gap-2">
            <span class="text-xs font-black uppercase ${
              rm.isOnline ? 'text-lime-400' : 'text-red-400'
            }">
              ${rm.isOnline ? '🟢 SALA ONLINE' : '🔴 SALA OFFLINE'}
            </span>
            ${
              isCurrent
                ? '<span class="text-[10px] font-tactical-mono px-1.5 py-0.5 rounded bg-sky-400 text-zinc-950 font-black">CONECTADO</span>'
                : ''
            }
          </div>
          <span class="text-[11px] text-zinc-400 font-tactical-mono">
            ${rm.soldiersCount} operadores • ${rm.matchesCount} partidas
          </span>
        </div>
      </div>

      <div class="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          data-open-room="${escapeHtml(rm.code)}"
          class="min-h-[40px] px-3 rounded-lg bg-sky-500/20 hover:bg-sky-500/35 border border-sky-400 text-sky-300 font-black text-xs uppercase"
          title="Assumir Comando da Sala"
        >
          👑 COMANDAR
        </button>
        <button
          type="button"
          data-toggle-online="${escapeHtml(rm.code)}"
          class="min-h-[40px] px-3 rounded-lg font-black text-xs uppercase border ${
            rm.isOnline
              ? 'bg-amber-500/20 hover:bg-amber-500/35 border-amber-400 text-amber-300'
              : 'bg-lime-500/20 hover:bg-lime-500/35 border-lime-400 text-lime-300'
          }"
          title="Alternar entre Online e Offline"
        >
          ${rm.isOnline ? '⏸️ DEIXAR OFF' : '🟢 DEIXAR ONLINE'}
        </button>
        <button
          type="button"
          data-delete-room="${escapeHtml(rm.code)}"
          class="min-h-[40px] px-3 rounded-lg bg-red-950/60 hover:bg-red-900 border border-red-700 text-red-300 font-black text-xs uppercase"
          title="Excluir sala permanentemente"
        >
          🗑️ EXCLUIR
        </button>
      </div>
    `;

    row.querySelector('[data-open-room]').addEventListener('click', () => {
      document.getElementById('inputJoinSessionCode').value = rm.code;
      joinCloudSession();
    });
    row.querySelector('[data-toggle-online]').addEventListener('click', () => {
      toggleMyRoomOnlineStatus(rm.code);
    });
    row.querySelector('[data-delete-room]').addEventListener('click', () => {
      deleteMyCreatedRoom(rm.code);
    });

    container.appendChild(row);
  });
}

function renderCloudModal() {
  renderRankSelectorButtons();
  const activeBox = document.getElementById('cloudActiveRoomBox');
  const createUnlocked = document.getElementById('createSessionUnlockedView');
  const createLocked = document.getElementById('createSessionLockedView');
  const myRoomsPanel = document.getElementById('myRoomsPanelContainer');

  document.getElementById('inputSupabaseUrl').value = cloudMeta.supabaseUrl || '';
  document.getElementById('inputSupabaseKey').value = cloudMeta.supabaseKey || '';

  // Restrict Room Creation & My Rooms List exclusively to logged-in users (Email & Password)
  if (cloudMeta.authUser) {
    if (createUnlocked) createUnlocked.classList.remove('hidden');
    if (createLocked) {
      createLocked.classList.add('hidden');
      createLocked.classList.remove('flex');
    }
    if (myRoomsPanel) myRoomsPanel.classList.remove('hidden');
  } else {
    if (createUnlocked) createUnlocked.classList.add('hidden');
    if (createLocked) {
      createLocked.classList.remove('hidden');
      createLocked.classList.add('flex');
    }
    if (myRoomsPanel) myRoomsPanel.classList.add('hidden');
  }

  // Pre-fill operator name if logged in
  const opInput = document.getElementById('inputJoinOperatorName');
  if (opInput && !opInput.value && cloudMeta.authUser?.name) {
    opInput.value = cloudMeta.authUser.name;
  }

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
      cloudMeta.role === 'HOST' ? '👑 JUIZ (CRIADOR)' : '🪖 OPERADOR CONECTADO';
  } else {
    activeBox.classList.add('hidden');
  }

  initSupabaseClient();
  fetchOpenOnlineRooms();
  if (cloudMeta.authUser) {
    fetchMyCreatedRooms();
  }
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
        const rankInfo = getSoldierRankInfo(s.rank);
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = `soldier-badge ${s.alive ? 'soldier-alive' : 'soldier-kia'} ${
          isMe ? 'ring-2 ring-sky-400' : ''
        }`;
        badge.innerHTML = `
          <span>${s.alive ? '🛡️' : '💀'}</span>
          <span>${escapeHtml(s.name)}${isMe ? ' (VOCÊ)' : ''}</span>
          <span class="text-[10px] font-tactical-mono uppercase px-1.5 py-0.5 rounded border ${rankInfo.badgeClass}" title="Nível: ${rankInfo.label}">
            ${rankInfo.icon} ${rankInfo.label}
          </span>
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
      'w-full sm:w-auto px-2 sm:px-3 h-[46px] rounded-xl bg-red-950/60 hover:bg-red-900/60 active:scale-95 border border-red-700 text-red-300 font-bold text-xs sm:text-sm uppercase tracking-wider flex items-center justify-center gap-1 whitespace-nowrap transition';
  } else {
    icon.textContent = '🔊';
    label.textContent = 'SOM';
    btn.className =
      'w-full sm:w-auto px-2 sm:px-3 h-[46px] rounded-xl bg-zinc-950 hover:bg-zinc-800 active:scale-95 border border-zinc-700 text-lime-400 font-bold text-xs sm:text-sm uppercase tracking-wider flex items-center justify-center gap-1 whitespace-nowrap transition';
  }
}

function renderRosterModal() {
  renderRankSelectorButtons();
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
      const rankInfo = getSoldierRankInfo(s.rank);
      const row = document.createElement('div');
      row.className =
        'flex items-center justify-between gap-2 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2';
      row.innerHTML = `
        <div class="flex items-center gap-2 min-w-0 flex-wrap">
          <span class="text-base">🪖</span>
          <span class="font-bold text-sm text-white truncate">${escapeHtml(s.name)}${
        isMe ? ' <span class="text-sky-400 text-xs">(VOCÊ)</span>' : ''
      }</span>
          <button
            type="button"
            data-rank-cycle-id="${s.id}"
            title="Clique para alterar o nível do operador (Recruta / Experiente / Matador)"
            class="text-[10px] font-tactical-mono font-black uppercase px-2 py-0.5 rounded border ${rankInfo.badgeClass} hover:brightness-125 transition"
          >
            ${rankInfo.icon} ${rankInfo.label}
          </button>
        </div>
        <div class="flex items-center gap-1.5 shrink-0 ${canModify ? '' : 'opacity-40 pointer-events-none'}">
          <button
            type="button"
            data-toggle-alive-id="${s.id}"
            title="Alternar entre VIVO e MORTO (K.I.A.)"
            class="min-h-[42px] px-2.5 rounded-lg font-black text-xs uppercase flex items-center gap-1 border transition ${
              s.alive
                ? 'bg-lime-500/15 hover:bg-lime-500/25 border-lime-400 text-lime-300'
                : 'bg-red-950/70 hover:bg-red-900 border-red-600 text-red-300'
            }"
          >
            ${s.alive ? '🛡️ VIVO' : '💀 K.I.A.'}
          </button>
          <button
            type="button"
            data-switch-id="${s.id}"
            title="Transferir para outro time"
            class="min-h-[42px] px-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-amber-300 font-black text-xs uppercase flex items-center gap-1"
          >
            ⇄ TIME
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
      row.querySelector('[data-rank-cycle-id]').addEventListener('click', () => {
        if (!canModify) return;
        cycleSoldierRank(s.id);
      });
      row.querySelector('[data-toggle-alive-id]').addEventListener('click', () => {
        if (!canModify) return;
        toggleSoldierAliveInField(s.id);
        renderRosterModal();
      });
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

    const rankInfo = getSoldierRankInfo(s.rank);

    tr.innerHTML = `
      <td class="py-3.5 px-3 sm:px-4 whitespace-nowrap">${posBadge}</td>
      <td class="py-3.5 px-3 sm:px-4 font-black uppercase text-white">
        <div class="flex items-center gap-1.5 flex-wrap">
          <span>${escapeHtml(s.name)}</span>
          <span class="text-[10px] font-tactical-mono px-1.5 py-0.5 rounded border ${rankInfo.badgeClass}">
            ${rankInfo.icon} ${rankInfo.label}
          </span>
        </div>
      </td>
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

function renderLogsModal() {
  tacticalLogger.updateHeaderBadge();

  const roleEl = document.getElementById('diagRoleText');
  const roomEl = document.getElementById('diagRoomText');
  const wsEl = document.getElementById('diagRealtimeStatusText');
  const errEl = document.getElementById('diagErrorsCountText');
  const listEl = document.getElementById('logsContainerList');

  if (!listEl) return;

  if (roleEl) roleEl.textContent = cloudMeta.role || 'LOCAL';
  if (roomEl) roomEl.textContent = cloudMeta.sessionCode ? `#${cloudMeta.sessionCode}` : 'NENHUMA';
  if (wsEl) {
    wsEl.textContent = realtimeConnectionStatus;
    wsEl.className = `text-sm font-tactical-mono font-black ${
      realtimeConnectionStatus === 'SUBSCRIBED'
        ? 'text-lime-400'
        : realtimeConnectionStatus.includes('ERROR') || realtimeConnectionStatus.includes('TIMED')
        ? 'text-red-400'
        : 'text-amber-300'
    }`;
  }
  if (errEl) errEl.textContent = String(tacticalLogger.getErrorCount());

  // Highlight active filter button
  document.querySelectorAll('[data-log-filter]').forEach((btn) => {
    const f = btn.getAttribute('data-log-filter');
    if (f === currentLogFilter) {
      btn.className = 'px-3 py-1.5 rounded-lg bg-sky-400 text-zinc-950 font-black text-xs uppercase';
    } else {
      btn.className =
        'px-3 py-1.5 rounded-lg bg-zinc-900 text-zinc-300 border border-zinc-700 font-black text-xs uppercase hover:text-white';
    }
  });

  const filtered = tacticalLogger.logs.filter((entry) => {
    if (currentLogFilter === 'ERROR') {
      return entry.level === 'ERROR' || entry.level === 'WARN';
    }
    if (currentLogFilter === 'CLOUD') {
      return entry.category === 'CLOUD';
    }
    return true;
  });

  listEl.innerHTML = '';

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div class="py-8 text-center text-zinc-500">
        Nenhum registro encontrado para este filtro. O sistema está operando normalmente!
      </div>
    `;
    return;
  }

  filtered.forEach((entry) => {
    const timeStr = new Date(entry.timestamp).toLocaleTimeString('pt-BR');
    const isErr = entry.level === 'ERROR';
    const isWarn = entry.level === 'WARN';

    const row = document.createElement('div');
    row.className = `p-2.5 rounded-lg border ${
      isErr
        ? 'bg-red-950/40 border-red-700/80 text-red-200'
        : isWarn
        ? 'bg-amber-950/30 border-amber-700/70 text-amber-200'
        : 'bg-zinc-900/80 border-zinc-800 text-zinc-200'
    }`;

    row.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 mb-1">
        <div class="flex items-center gap-1.5">
          <span class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase ${
            isErr
              ? 'bg-red-600 text-white'
              : isWarn
              ? 'bg-amber-500 text-zinc-950'
              : 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
          }">
            ${escapeHtml(entry.level)} • ${escapeHtml(entry.category)}
          </span>
          <span class="text-[10px] text-zinc-400">
            [${escapeHtml(entry.role)}${entry.room ? ' #' + escapeHtml(entry.room) : ''}]
          </span>
        </div>
        <span class="text-[10px] text-zinc-400">${escapeHtml(timeStr)}</span>
      </div>
      <div class="font-bold text-xs break-words">${escapeHtml(entry.message)}</div>
      ${
        entry.details
          ? `<div class="mt-1 text-[11px] text-zinc-400 bg-black/40 p-1.5 rounded break-all">${escapeHtml(
              entry.details
            )}</div>`
          : ''
      }
    `;
    listEl.appendChild(row);
  });
}

async function runCloudConnectionDiagnostic() {
  if (!initSupabaseClient()) {
    tacticalLogger.error('CLOUD', 'Diagnóstico falhou: Cliente Supabase não inicializado.');
    renderLogsModal();
    showToast('❌', 'Supabase não inicializado. Verifique URL/Key.');
    return;
  }

  const startMs = Date.now();
  try {
    const { data, error } = await supabaseClient
      .from('tactical_sessions')
      .select('code, updated_at')
      .limit(5);

    const latency = Date.now() - startMs;
    if (error) {
      tacticalLogger.error('CLOUD', `Falha no teste de conexão Supabase (${latency}ms)`, error.message);
      renderLogsModal();
      showToast('❌', `Erro no banco: ${error.message}`);
      return;
    }

    tacticalLogger.info(
      'CLOUD',
      `Diagnóstico Supabase OK! Latência: ${latency}ms • Salas ativas lidas: ${
        Array.isArray(data) ? data.length : 0
      }`
    );
    renderLogsModal();
    showToast('🟢', `Conexão Supabase OK! Latência: ${latency}ms.`);
  } catch (err) {
    tacticalLogger.error('CLOUD', 'Exceção durante teste de conexão', err?.message || String(err));
    renderLogsModal();
    showToast('⚠️', 'Falha de rede ao testar Supabase.');
  }
}

function renderAll() {
  tacticalLogger.updateHeaderBadge();
  renderHeaderAuthButton();
  renderAuthModal();
  renderRankSelectorButtons();
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
        .then((reg) => {
          pwaBadge.innerHTML = '🟢 PRONTO OFFLINE';
          const promoteIfIdle = (worker) => {
            if (worker && runtime.phase === 'IDLE') {
              worker.postMessage({ type: 'SKIP_WAITING' });
            }
          };
          if (reg && reg.waiting) promoteIfIdle(reg.waiting);
          if (reg && reg.addEventListener) {
            reg.addEventListener('updatefound', () => {
              const nw = reg.installing;
              if (!nw) return;
              nw.addEventListener('statechange', () => {
                if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                  promoteIfIdle(nw);
                }
              });
            });
          }
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
    const allIds = state.soldiers.map((s) => s.id);
    state = getDefaultState();
    if (cloudMeta.role === 'HOST') {
      queueHostSync({ roster: true, removedIds: allIds, force: true });
    }
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
  document.getElementById('btnJoinCloudSession').addEventListener('click', () => joinCloudSession());
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

  // Help / Manual Modal Controls
  const openHelp = () => {
    document.getElementById('modalHelp').classList.remove('hidden');
  };
  const closeHelp = () => {
    document.getElementById('modalHelp').classList.add('hidden');
  };
  document.getElementById('btnOpenHelp').addEventListener('click', openHelp);
  document.getElementById('btnCloseHelp').addEventListener('click', closeHelp);
  document.getElementById('btnDoneHelp').addEventListener('click', closeHelp);

  // System & Error Logs Modal Controls
  const openLogs = () => {
    renderLogsModal();
    document.getElementById('modalLogs').classList.remove('hidden');
  };
  const closeLogs = () => {
    document.getElementById('modalLogs').classList.add('hidden');
  };
  const btnOpenLogs = document.getElementById('btnOpenLogs');
  if (btnOpenLogs) btnOpenLogs.addEventListener('click', openLogs);
  const btnCloseLogs = document.getElementById('btnCloseLogs');
  if (btnCloseLogs) btnCloseLogs.addEventListener('click', closeLogs);
  const btnDoneLogs = document.getElementById('btnDoneLogs');
  if (btnDoneLogs) btnDoneLogs.addEventListener('click', closeLogs);

  document.querySelectorAll('[data-log-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentLogFilter = btn.getAttribute('data-log-filter') || 'ALL';
      renderLogsModal();
    });
  });

  const btnRunDiag = document.getElementById('btnRunCloudDiag');
  if (btnRunDiag) {
    btnRunDiag.addEventListener('click', runCloudConnectionDiagnostic);
  }

  const btnCopyLogs = document.getElementById('btnCopyLogs');
  if (btnCopyLogs) {
    btnCopyLogs.addEventListener('click', () => {
      const lines = tacticalLogger.logs.map((l) => {
        const dt = new Date(l.timestamp).toLocaleString('pt-BR');
        return `[${dt}] [${l.level}/${l.category}] (${l.role}${l.room ? ' #' + l.room : ''}) ${
          l.message
        }${l.details ? ' | ' + l.details : ''}`;
      });
      const text =
        `🐞 *DIAGNÓSTICO DE PRODUÇÃO — TACTICAL COMMAND*\n` +
        ` Papel: ${cloudMeta.role} | Sala: ${cloudMeta.sessionCode || 'LOCAL'} | WS: ${realtimeConnectionStatus}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        (lines.length > 0 ? lines.slice(0, 45).join('\n') : 'Sem erros registrados.');

      navigator.clipboard.writeText(text).then(() => {
        showToast('📋', 'Logs copiados para a área de transferência!');
      });
    });
  }

  const btnClearLogs = document.getElementById('btnClearLogs');
  if (btnClearLogs) {
    btnClearLogs.addEventListener('click', () => {
      tacticalLogger.clear();
      renderLogsModal();
      showToast('🗑️', 'Histórico de logs limpo!');
    });
  }

  // Refresh Open Online Rooms Buttons
  document.querySelectorAll('[data-refresh-open-rooms]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetchOpenOnlineRooms();
      showToast('🔄', 'Lista de salas online atualizada!');
    });
  });

  const btnRefreshAuthMyRooms = document.getElementById('btnRefreshAuthMyRooms');
  if (btnRefreshAuthMyRooms) {
    btnRefreshAuthMyRooms.addEventListener('click', async () => {
      await fetchMyCreatedRooms();
      showToast('🔄', 'Suas salas foram atualizadas!');
    });
  }

  const btnResumeActiveRoom = document.getElementById('btnResumeActiveRoomFromAuth');
  if (btnResumeActiveRoom) {
    btnResumeActiveRoom.addEventListener('click', () => {
      closeAuthModal();
      showToast('🎯', `De volta à sala #${cloudMeta.sessionCode}!`);
    });
  }

  // Soldier Combat Level / Rank Selector Buttons (Recruta / Experiente / Matador)
  document.querySelectorAll('[data-rank-select]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rankId = btn.getAttribute('data-rank-select');
      cloudMeta.selectedSoldierRank = getSoldierRankInfo(rankId).id;
      saveCloudMeta();
      renderRankSelectorButtons();
    });
  });

  // Auth / Login / Self-Registration / Quick Join Modal Controls (Main Landing Screen)
  const openAuthModal = (defaultTab = 'LOGIN') => {
    renderAuthModal();
    document.getElementById('modalAuth').classList.remove('hidden');
    if (!cloudMeta.authUser && defaultTab) {
      activateAuthTab(defaultTab);
    }
  };
  const closeAuthModal = () => {
    document.getElementById('modalAuth').classList.add('hidden');
  };

  document.getElementById('btnOpenAuthModal').addEventListener('click', () => openAuthModal('LOGIN'));
  document.getElementById('btnCloseAuthModal').addEventListener('click', closeAuthModal);
  const btnEnterMainPanel = document.getElementById('btnEnterMainPanelFromAuth');
  if (btnEnterMainPanel) {
    btnEnterMainPanel.addEventListener('click', closeAuthModal);
  }

  const tabQuickJoin = document.getElementById('tabAuthQuickJoin');
  const tabLogin = document.getElementById('tabAuthLogin');
  const tabRegister = document.getElementById('tabAuthRegister');
  const formQuickJoin = document.getElementById('formAuthQuickJoin');
  const formLogin = document.getElementById('formAuthLogin');
  const formRegister = document.getElementById('formAuthRegister');

  function activateAuthTab(tabName) {
    const inactiveClass =
      'min-h-[46px] rounded-lg font-black text-[11px] sm:text-xs uppercase tracking-wider bg-zinc-900 text-zinc-300 hover:text-white transition px-1';
    tabQuickJoin.className = inactiveClass;
    tabLogin.className = inactiveClass;
    tabRegister.className = inactiveClass;

    formQuickJoin.classList.add('hidden');
    formLogin.classList.add('hidden');
    formRegister.classList.add('hidden');

    if (tabName === 'LOGIN') {
      tabLogin.className =
        'min-h-[46px] rounded-lg font-black text-[11px] sm:text-xs uppercase tracking-wider bg-lime-400 text-zinc-950 transition px-1';
      formLogin.classList.remove('hidden');
    } else if (tabName === 'REGISTER') {
      tabRegister.className =
        'min-h-[46px] rounded-lg font-black text-[11px] sm:text-xs uppercase tracking-wider bg-sky-400 text-zinc-950 transition px-1';
      formRegister.classList.remove('hidden');
    } else {
      tabQuickJoin.className =
        'min-h-[46px] rounded-lg font-black text-[11px] sm:text-xs uppercase tracking-wider bg-amber-400 text-zinc-950 transition px-1';
      formQuickJoin.classList.remove('hidden');
    }
  }

  tabQuickJoin.addEventListener('click', () => {
    activateAuthTab('JOIN');
    fetchOpenOnlineRooms();
  });
  tabLogin.addEventListener('click', () => activateAuthTab('LOGIN'));
  tabRegister.addEventListener('click', () => activateAuthTab('REGISTER'));

  document.getElementById('btnAuthJoinTeamA').addEventListener('click', () => {
    cloudMeta.joinSelectedTeam = 'A';
    saveCloudMeta();
    renderAuthModal();
  });

  document.getElementById('btnAuthJoinTeamB').addEventListener('click', () => {
    cloudMeta.joinSelectedTeam = 'B';
    saveCloudMeta();
    renderAuthModal();
  });

  formQuickJoin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = document.getElementById('inputAuthJoinCode').value;
    const name = document.getElementById('inputAuthJoinName').value;
    document.getElementById('inputJoinSessionCode').value = code;
    document.getElementById('inputJoinOperatorName').value = name;
    const joined = await joinCloudSession(code);
    if (joined) {
      closeAuthModal();
    }
  });

  const btnGoToLoginFromCloud = document.getElementById('btnGoToLoginFromCloud');
  if (btnGoToLoginFromCloud) {
    btnGoToLoginFromCloud.addEventListener('click', () => {
      document.getElementById('modalCloudSession').classList.add('hidden');
      openAuthModal('LOGIN');
    });
  }

  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('inputLoginEmail').value;
    const pass = document.getElementById('inputLoginPassword').value;
    await handleLogin(email, pass);
  });

  formRegister.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('inputRegName').value;
    const email = document.getElementById('inputRegEmail').value;
    const pass = document.getElementById('inputRegPassword').value;
    await handleSelfRegister(name, email, pass);
  });

  document.getElementById('btnLogout').addEventListener('click', handleLogout);
  document.getElementById('btnOpenMyRoomsFromAuth').addEventListener('click', () => {
    closeAuthModal();
    renderCloudModal();
    document.getElementById('modalCloudSession').classList.remove('hidden');
  });

  document.getElementById('btnRefreshMyRooms').addEventListener('click', () => {
    fetchMyCreatedRooms();
    showToast('🔄', 'Lista das suas salas atualizada!');
  });
}

// Reconnect to active session or URL ?room=CODE parameter on boot
async function checkInitialCloudSession() {
  initSupabaseClient();
  purgeLegacyLocalCredentials();
  installAuthListener();
  const session = await ensureAuthSession(); // sem JWT o RLS não entrega Realtime
  if (session) await syncAuthUser(session);
  installConnectivityHooks();
  if (supabaseClient) {
    syncServerClock();
    fetchOpenOnlineRooms();
    if (cloudMeta.authUser) fetchMyCreatedRooms();
  }

  const roomFromUrl = sanitizeSessionCode(new URLSearchParams(window.location.search).get('room'));
  if (roomFromUrl) {
    document.getElementById('inputJoinSessionCode').value = roomFromUrl;
    const authJoinCode = document.getElementById('inputAuthJoinCode');
    if (authJoinCode) authJoinCode.value = roomFromUrl;

    if (cloudMeta.sessionCode !== roomFromUrl) {
      if (cloudMeta.sessionCode) leaveCloudSession({ silent: true });
      renderAuthModal();
      document.getElementById('modalAuth').classList.remove('hidden');
      document.getElementById('tabAuthQuickJoin')?.click();
      setTimeout(() => document.getElementById('inputAuthJoinName')?.focus(), 100);
      return;
    }
  }

  if (cloudMeta.sessionCode && supabaseClient) {
    subscribeToCloudSession(cloudMeta.sessionCode);
    await resyncFromServer('boot');
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
  restoreRuntimeFromLiveTimer();
  checkInitialCloudSession();
});
