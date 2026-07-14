'use client';

import { useEffect, useState } from 'react';

interface RoomStatus {
  roomId: string;
  name: string;
  temperature: number | null;
  humidity: number | null;
  setpoint: number | null;
  mode: string;
  connectionUp: boolean;
  apiSource: string;
  targetTemp?: number;
  targetWinter?: number | null;
  targetSummer?: number | null;
}

type Season = 'heat' | 'cool' | 'off';

const SEASON_LABEL: Record<Season, string> = {
  heat: 'Inverno',
  cool: 'Estate',
  off: 'Spento',
};

interface Thermostat {
  temperature: number | null;
  setpoint: number | null;
  humidity: number | null;
}

const ROOM_ICONS: Record<string, string> = {
  leone: '\u{1F476}', soggiorno: '\u{1F6CB}', camera: '\u{1F6CF}', studio: '\u{1F4BB}',
  cucina: '\u{1F373}', bagno1: '\u{1F6C1}', bagno2: '\u{1F6BF}',
};

export default function SettingsPage() {
  const [netatmoStatus, setNetatmoStatus] = useState<'loading' | 'connected' | 'disconnected'>('loading');
  const [netatmoHome, setNetatmoHome] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomStatus[]>([]);
  const [thermostat, setThermostat] = useState<Thermostat | null>(null);
  const [season, setSeason] = useState<Season>('heat');
  const [seasonPending, setSeasonPending] = useState(false);
  const [seasonError, setSeasonError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);

  async function reload() {
    const [netatmoRes, roomsRes, settingsRes] = await Promise.all([
      fetch('/api/netatmo/status').then(r => r.json()).catch(() => ({ ok: false })),
      fetch('/api/rooms').then(r => r.json()).catch(() => ({ ok: false })),
      fetch('/api/settings').then(r => r.json()).catch(() => ({ ok: false })),
    ]);

    if (netatmoRes.ok) {
      setNetatmoStatus('connected');
      setNetatmoHome(netatmoRes.homeId);
    } else {
      setNetatmoStatus('disconnected');
    }

    if (roomsRes.ok) {
      setRooms(roomsRes.rooms || []);
      if (roomsRes.thermostat) setThermostat(roomsRes.thermostat);
      setLastUpdate(new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }));
    }

    if (settingsRes.ok) {
      const s = settingsRes.season;
      setSeason(s === 'cool' || s === 'off' ? s : 'heat');
    }
  }

  useEffect(() => {
    reload();
  }, []);

  async function changeSeason(next: Season) {
    if (next === season || seasonPending) return;
    const prev = season;
    setSeasonPending(true);
    setSeasonError(null);
    setSeason(next); // optimistic
    try {
      // Step 1: flip the season flag (and broadcast mode to all 5 Sabianas
      // when next !== 'off' — settings POST already does this).
      const r1 = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ season: next }),
      });
      const j1 = await r1.json();
      if (!j1.ok) throw new Error(j1.error || 'season_flip_failed');

      // Step 2: when switching to an active season, copy the persisted
      // target_<season> values into target_temp so the agent picks them up.
      if (next === 'heat' || next === 'cool') {
        const hasAnyPersisted = rooms.some(r =>
          (next === 'cool' ? r.targetSummer : r.targetWinter) != null,
        );
        const r2 = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            // First-time summer activation: seed every room to 26°C if no
            // persisted summer target exists yet.
            next === 'cool' && !hasAnyPersisted
              ? { action: 'apply_season_defaults', season: 'cool', targetTemp: 26 }
              : { action: 'apply_season_defaults', season: next },
          ),
        });
        const j2 = await r2.json();
        if (!j2.ok) throw new Error(j2.error || 'defaults_apply_failed');
      }
      await reload();
    } catch (e) {
      setSeason(prev); // rollback
      setSeasonError(e instanceof Error ? e.message : 'errore');
    } finally {
      setSeasonPending(false);
    }
  }

  const sabianaRooms = rooms.filter(r => r.apiSource === 'sabiana');
  const netatmoRooms = rooms.filter(r => r.apiSource === 'netatmo');
  const sabianaOnline = sabianaRooms.filter(r => r.connectionUp).length;
  const sabianaTotal = sabianaRooms.length;

  return (
    <main className="px-4 pt-safe max-w-lg mx-auto pb-4">
      <div className="pt-6 pb-4">
        <h1 className="text-[28px] font-bold tracking-tight bg-gradient-to-b from-white to-white/70 bg-clip-text text-transparent">
          Impostazioni
        </h1>
        {lastUpdate && (
          <p className="text-[11px] text-slate-500 mt-1">Ultimo aggiornamento: {lastUpdate}</p>
        )}
      </div>

      {/* ── Season ── */}
      <section className="rounded-3xl bg-white/[0.04] backdrop-blur-xl border border-white/[0.08] overflow-hidden mb-4">
        <div className="p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-amber-500/20 to-orange-600/10 flex items-center justify-center">
              {season === 'heat' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5 text-orange-400">
                  <circle cx="12" cy="12" r="4" /><path d="M12 2v2" strokeLinecap="round" /><path d="M12 20v2" strokeLinecap="round" /><path d="m4.93 4.93 1.41 1.41" strokeLinecap="round" /><path d="m17.66 17.66 1.41 1.41" strokeLinecap="round" />
                </svg>
              ) : season === 'cool' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5 text-sky-400">
                  <path d="M2 12h20" strokeLinecap="round" /><path d="M12 2v20" strokeLinecap="round" /><path d="m4.93 4.93 14.14 14.14" strokeLinecap="round" /><path d="m19.07 4.93-14.14 14.14" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5 text-slate-400">
                  <circle cx="12" cy="12" r="10" /><path d="M8 12h8" strokeLinecap="round" />
                </svg>
              )}
            </div>
            <div className="flex-1">
              <h3 className="text-[15px] font-semibold">Modalita</h3>
              <p className="text-[12px] text-slate-400">
                {season === 'heat' && 'Inverno — Riscaldamento'}
                {season === 'cool' && 'Estate — Raffrescamento'}
                {season === 'off' && 'Spento — Nessuna attuazione'}
              </p>
            </div>
          </div>

          {/* 3-way segmented control */}
          <div
            role="radiogroup"
            aria-label="Modalità stagionale"
            className={`grid grid-cols-3 gap-1 p-1 rounded-2xl bg-white/[0.04] border border-white/[0.06] ${seasonPending ? 'opacity-60 pointer-events-none' : ''}`}
          >
            {(['heat', 'cool', 'off'] as Season[]).map(opt => {
              const active = season === opt;
              const tone = opt === 'heat'
                ? (active ? 'bg-orange-500/20 text-orange-300' : 'text-slate-400')
                : opt === 'cool'
                  ? (active ? 'bg-sky-500/20 text-sky-300' : 'text-slate-400')
                  : (active ? 'bg-slate-500/20 text-slate-200' : 'text-slate-500');
              return (
                <button
                  key={opt}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => changeSeason(opt)}
                  disabled={seasonPending}
                  className={`py-2.5 rounded-xl text-[13px] font-semibold transition-colors ${tone}`}
                >
                  {SEASON_LABEL[opt]}
                </button>
              );
            })}
          </div>
          {seasonError && (
            <p className="text-[11px] text-red-400/80 mt-2">Errore: {seasonError}</p>
          )}
          <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
            {season === 'cool'
              ? 'Estate: fancoil in raffrescamento, valvole bagno disattivate, caldaia ferma.'
              : season === 'off'
                ? 'Spento: nessun comando automatico. Valvole bagno in antigelo.'
                : 'Inverno: fancoil in riscaldamento, caldaia gestita, valvole bagno attive.'}
          </p>
        </div>
      </section>


      {/* ── BTicino / Netatmo ── */}
      <section className="rounded-3xl bg-white/[0.04] backdrop-blur-xl border border-white/[0.08] overflow-hidden mb-4">
        <div className="p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-sky-500/20 to-sky-600/10 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5 text-sky-400">
                <path d="M12 2L2 7l10 5 10-5-10-5z" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M2 17l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-[15px] font-semibold">BTicino / Netatmo</h3>
              <p className="text-[12px] text-slate-400">Smarther 2 + valvole bagno</p>
            </div>
            <div className={`w-2.5 h-2.5 rounded-full ${
              netatmoStatus === 'connected' ? 'bg-emerald-500' :
              netatmoStatus === 'disconnected' ? 'bg-red-500' :
              'bg-slate-500 animate-pulse'
            }`} />
          </div>

          {netatmoStatus === 'connected' ? (
            <div className="space-y-2">
              {/* Thermostat */}
              {thermostat && (
                <div className="rounded-xl bg-white/[0.04] border border-white/[0.06] px-3.5 py-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] text-slate-400">Smarther 2 Soggiorno</span>
                    <span className="text-[10px] text-emerald-400/70 font-medium">Online</span>
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <div>
                      <span className="text-[18px] font-semibold text-white tabular-nums">
                        {thermostat.temperature?.toFixed(1) ?? '--'}°
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Target {thermostat.setpoint?.toFixed(1) ?? '--'}°C
                    </div>
                    {thermostat.humidity != null && (
                      <div className="text-[11px] text-slate-500">
                        {thermostat.humidity}% UR
                      </div>
                    )}
                  </div>
                </div>
              )}
              {/* Netatmo rooms */}
              {netatmoRooms.map(r => (
                <div key={r.roomId} className="rounded-xl bg-white/[0.04] border border-white/[0.06] px-3.5 py-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] text-slate-400">
                      {ROOM_ICONS[r.roomId] || '\u{1F3E0}'} {r.name}
                    </span>
                    <span className={`text-[10px] font-medium ${r.connectionUp ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
                      {r.connectionUp ? 'Online' : 'Offline'}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <span className="text-[16px] font-semibold text-white tabular-nums">
                      {r.temperature?.toFixed(1) ?? '--'}°
                    </span>
                    {r.humidity != null && (
                      <span className="text-[11px] text-slate-500">{r.humidity}% UR</span>
                    )}
                  </div>
                </div>
              ))}
              {netatmoHome && (
                <p className="text-[10px] text-slate-600 px-1 mt-1">Home ID: {netatmoHome}</p>
              )}
            </div>
          ) : netatmoStatus === 'disconnected' ? (
            <a
              href="/api/netatmo/auth"
              className="block w-full text-center py-3 rounded-2xl bg-sky-500/20 text-sky-300 text-[13px] font-semibold
                hover:bg-sky-500/30 active:bg-sky-500/40 transition-colors"
            >
              Collega BTicino
            </a>
          ) : (
            <div className="h-10 rounded-2xl bg-white/[0.03] animate-pulse" />
          )}
        </div>
      </section>

      {/* ── Sabiana ── */}
      <section className="rounded-3xl bg-white/[0.04] backdrop-blur-xl border border-white/[0.08] overflow-hidden mb-4">
        <div className="p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-orange-500/20 to-orange-600/10 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5 text-orange-400">
                <path d="M12 9v4" strokeLinecap="round" /><path d="M12 17h.01" />
                <path d="M3.6 9h16.8" /><path d="M3.6 15h16.8" />
                <rect x="2" y="3" width="20" height="18" rx="3" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-[15px] font-semibold">Sabiana Cloud WM</h3>
              <p className="text-[12px] text-slate-400">{sabianaTotal} fancoil CB-Touch</p>
            </div>
            <div className={`w-2.5 h-2.5 rounded-full ${
              sabianaOnline === sabianaTotal && sabianaTotal > 0 ? 'bg-emerald-500' :
              sabianaOnline > 0 ? 'bg-amber-500' : 'bg-red-500'
            }`} />
          </div>

          <div className="space-y-2">
            {sabianaRooms.map(r => (
              <div key={r.roomId} className="rounded-xl bg-white/[0.04] border border-white/[0.06] px-3.5 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-slate-400">
                    {ROOM_ICONS[r.roomId] || '\u{1F3E0}'} {r.name}
                  </span>
                  <span className={`text-[10px] font-medium ${r.connectionUp ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
                    {r.connectionUp ? 'Online' : 'Offline'}
                  </span>
                </div>
                <div className="flex items-center gap-4 mt-1">
                  <span className="text-[16px] font-semibold text-white tabular-nums">
                    {r.temperature?.toFixed(1) ?? '--'}°
                  </span>
                  <span className="text-[11px] text-slate-500">
                    SP {r.setpoint?.toFixed(1) ?? '--'}°
                  </span>
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-lg ${
                    r.mode === 'heat' ? 'bg-orange-500/15 text-orange-400' :
                    r.mode === 'cool' ? 'bg-sky-500/15 text-sky-400' :
                    'bg-slate-500/15 text-slate-500'
                  }`}>
                    {r.mode === 'heat' ? 'Riscaldamento' : r.mode === 'cool' ? 'Raffrescamento' : 'Spento'}
                  </span>
                  {r.humidity != null && (
                    <span className="text-[11px] text-slate-500 ml-auto">{r.humidity}%</span>
                  )}
                </div>
              </div>
            ))}
            <p className="text-[10px] text-slate-600 px-1 mt-1">
              {sabianaOnline}/{sabianaTotal} dispositivi online
            </p>
          </div>
        </div>
      </section>

      {/* ── Agent status ── */}
      <section className="rounded-3xl bg-white/[0.04] backdrop-blur-xl border border-white/[0.08] overflow-hidden mb-4">
        <div className="p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-purple-500/20 to-purple-600/10 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5 text-purple-400">
                <path d="M12 8V4H8" strokeLinecap="round" strokeLinejoin="round" />
                <rect width="16" height="12" x="4" y="8" rx="2" />
                <path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-[15px] font-semibold">Agente 24/7</h3>
              <p className="text-[12px] text-slate-400">Controllo automatico temperature</p>
            </div>
          </div>
          <p className="text-[12px] text-slate-500 mt-3 leading-relaxed">
            L&apos;agente monitora ogni 2 minuti, regola setpoint e ventola per mantenere
            le temperature target. Camera Nursery ha priorita massima.
          </p>
        </div>
      </section>

      {/* ── Info ── */}
      <section className="rounded-3xl bg-white/[0.04] backdrop-blur-xl border border-white/[0.08] overflow-hidden">
        <div className="p-4">
          <h3 className="text-[15px] font-semibold mb-2">ThermoLeo</h3>
          <p className="text-[12px] text-slate-500 leading-relaxed">
            Dashboard per il controllo temperature di casa. Progettato per garantire
            comfort e sicurezza, specialmente per Nursery.
          </p>
          <div className="flex items-center gap-3 mt-3 pt-3 border-t border-white/[0.06]">
            <span className="text-[11px] text-slate-600">v1.0.0</span>
            <span className="text-[11px] text-slate-600">Next.js 16</span>
            <span className="text-[11px] text-slate-600">Supabase</span>
          </div>
        </div>
      </section>
    </main>
  );
}
