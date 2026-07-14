'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import type { RoomStatus } from '@/lib/types';
import type { SabianaMode } from '@/lib/sabiana/types';
import { shouldApplyRoomsReply } from '@/lib/property-guard';

type Season = 'heat' | 'cool' | 'off';
const BATHROOM_ROOMS = new Set(['bagno1', 'bagno2']);

const FAN_OPTIONS = [
  { value: 1, label: 'Min' },
  { value: 2, label: 'Med' },
  { value: 3, label: 'Max' },
  { value: 4, label: 'Auto' },
];

// Campomarino MELCloud splits: 0=silent (the remote's "silenzioso"), 1-3 ladder.
// Default stays 1 (lowest non-silent). Sabiana uses FAN_OPTIONS above.
const MELCLOUD_FAN_OPTIONS = [
  { value: 0, label: 'Silenzioso' },
  { value: 1, label: 'Min' },
  { value: 2, label: 'Med' },
  { value: 3, label: 'Max' },
];

/* ── Room icon mapping ── */
function RoomIcon({ icon, className = '' }: { icon: string; className?: string }) {
  const icons: Record<string, React.ReactNode> = {
    bed: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M2 4v16" /><path d="M2 8h18a2 2 0 0 1 2 2v10" /><path d="M2 17h20" /><path d="M6 8v9" />
      </svg>
    ),
    baby: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M9 12h.01" /><path d="M15 12h.01" />
        <path d="M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5" />
        <path d="M19 6.3a9 9 0 0 1 1.8 3.9 2 2 0 0 1 0 3.6 9 9 0 0 1-17.6 0 2 2 0 0 1 0-3.6A9 9 0 0 1 12 3c2 0 3.5 1.1 3.5 2.5s-.9 2.5-2 2.5c-.8 0-1.5-.4-1.5-1" />
      </svg>
    ),
    sofa: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3" />
        <path d="M2 11v5a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v2H6v-2a2 2 0 0 0-4 0Z" />
        <path d="M4 18v2" /><path d="M20 18v2" />
      </svg>
    ),
    utensils: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" /><path d="M7 2v20" />
        <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
      </svg>
    ),
    door: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M18 20V6a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v14" /><path d="M2 20h20" /><path d="M14 12v.01" />
      </svg>
    ),
    default: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
        <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    ),
  };
  return icons[icon] || icons.default;
}

/* ── Temperature state classification ── */
type TempState = 'cold' | 'ok' | 'hot' | 'off' | 'unknown';

function classifyTemp(temp: number | null, targetTemp: number | null, isOff: boolean): TempState {
  if (isOff) return 'off';
  if (temp === null || targetTemp === null) return 'unknown';
  if (temp < targetTemp - 0.2) return 'cold';
  if (temp > targetTemp + 0.2) return 'hot';
  return 'ok';
}

const STATE_LABELS: Record<TempState, string> = {
  cold: 'Freddo',
  ok: 'A target',
  hot: 'Caldo',
  off: 'Spento',
  unknown: '--',
};

/* ── Color palette per state ── */
const STATE_COLORS: Record<TempState, {
  bg: string;
  border: string;
  glow: string;
  text: string;
  accent: string;
  dot: string;
  iconBg: string;
  iconText: string;
  label: string;
  ringBorder: string;
}> = {
  cold: {
    bg: 'from-cyan-800/70 to-blue-900/60',
    border: 'border-cyan-400/50',
    glow: 'shadow-[0_0_36px_-2px_rgba(34,211,238,0.4)]',
    text: 'text-sky-400',
    accent: 'text-sky-400',
    dot: 'bg-sky-400',
    iconBg: 'bg-sky-500/25',
    iconText: 'text-sky-400',
    label: 'text-sky-400',
    ringBorder: 'border-sky-400/50',
  },
  ok: {
    bg: 'from-emerald-950/30 to-slate-900/50',
    border: 'border-emerald-500/20',
    glow: 'shadow-none',
    text: 'text-emerald-300',
    accent: 'text-emerald-400',
    dot: 'bg-emerald-400',
    iconBg: 'bg-emerald-500/10',
    iconText: 'text-emerald-400',
    label: 'text-emerald-400/70',
    ringBorder: 'border-emerald-500/20',
  },
  hot: {
    bg: 'from-red-900/50 to-red-950/40',
    border: 'border-red-400/40',
    glow: 'shadow-[0_0_32px_-4px_rgba(239,68,68,0.35)]',
    text: 'text-red-300',
    accent: 'text-red-400',
    dot: 'bg-red-400',
    iconBg: 'bg-red-500/20',
    iconText: 'text-red-400',
    label: 'text-red-400',
    ringBorder: 'border-red-500/30',
  },
  off: {
    bg: 'from-slate-800/40 to-slate-900/60',
    border: 'border-white/[0.04]',
    glow: '',
    text: 'text-slate-500',
    accent: 'text-slate-500',
    dot: 'bg-slate-500',
    iconBg: 'bg-white/[0.04]',
    iconText: 'text-slate-600',
    label: 'text-slate-600',
    ringBorder: 'border-white/[0.06]',
  },
  unknown: {
    bg: 'from-slate-800/50 to-slate-900/40',
    border: 'border-white/[0.06]',
    glow: '',
    text: 'text-slate-400',
    accent: 'text-slate-400',
    dot: 'bg-slate-500',
    iconBg: 'bg-white/[0.06]',
    iconText: 'text-slate-400',
    label: 'text-slate-500',
    ringBorder: 'border-white/[0.08]',
  },
};

/* Nursery override: golden accent border left + shimmer regardless of state */

/* ── WMO weather code → description + icon ── */
function weatherCodeToInfo(code: number): { description: string; icon: string } {
  if (code === 0) return { description: 'Sereno', icon: 'sun' };
  if (code <= 3) return { description: 'Parzialmente nuvoloso', icon: 'cloud-sun' };
  if (code <= 48) return { description: 'Nebbia', icon: 'fog' };
  if (code <= 57) return { description: 'Pioviggine', icon: 'drizzle' };
  if (code <= 67) return { description: 'Pioggia', icon: 'rain' };
  if (code <= 77) return { description: 'Neve', icon: 'snow' };
  if (code <= 82) return { description: 'Rovescio', icon: 'rain' };
  if (code <= 86) return { description: 'Neve forte', icon: 'snow' };
  if (code <= 99) return { description: 'Temporale', icon: 'storm' };
  return { description: 'N/D', icon: 'sun' };
}

function WeatherIcon({ icon, className = '' }: { icon: string; className?: string }) {
  const icons: Record<string, React.ReactNode> = {
    sun: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className={className}>
        <circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
      </svg>
    ),
    'cloud-sun': (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className={className}>
        <path d="M12 2v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="M20 12h2" /><path d="m19.07 4.93-1.41 1.41" /><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128" />
        <path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z" />
      </svg>
    ),
    fog: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className={className}>
        <path d="M4 14h16" /><path d="M4 18h16" /><path d="M6 10a4 4 0 0 1 8 0" /><path d="M14 10a4 4 0 0 1 4-1" />
      </svg>
    ),
    drizzle: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className={className}>
        <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
        <path d="M8 19v1" /><path d="M8 14v1" /><path d="M16 19v1" /><path d="M16 14v1" /><path d="M12 21v1" /><path d="M12 16v1" />
      </svg>
    ),
    rain: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className={className}>
        <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
        <path d="M16 14v6" /><path d="M8 14v6" /><path d="M12 16v6" />
      </svg>
    ),
    snow: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className={className}>
        <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
        <path d="M8 15h.01" /><path d="M8 19h.01" /><path d="M12 17h.01" /><path d="M12 21h.01" /><path d="M16 15h.01" /><path d="M16 19h.01" />
      </svg>
    ),
    storm: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className={className}>
        <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
        <path d="m13 12-3 5h4l-3 5" />
      </svg>
    ),
  };
  return <>{icons[icon] || icons.sun}</>;
}

type PropertyId = 'milano' | 'campomarino';
const PROPERTIES: { id: PropertyId; label: string }[] = [
  { id: 'milano', label: 'Milano' },
  { id: 'campomarino', label: 'Campomarino' },
];

export default function HomePage() {
  const [rooms, setRooms] = useState<RoomStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  // Which home the dashboard is showing. Persisted so a reload keeps the choice.
  // Milano is the default — the primary home and the byte-identical path.
  const [property, setProperty] = useState<PropertyId>('milano');
  const [season, setSeason] = useState<Season>('heat');
  const [seasonLoading, setSeasonLoading] = useState(false);
  const [thermostat, setThermostat] = useState<{ temperature: number | null; setpoint: number | null; humidity: number | null } | null>(null);
  const thermostatNetatmoId = '2171004425'; // Smarther 2 Netatmo room ID

  // Weather for Milano Porta Romana (Open-Meteo, no API key)
  const [weather, setWeather] = useState<{
    temp: number; min: number; max: number; humidity: number;
    code: number; description: string; icon: string;
  } | null>(null);

  // Query suffix for the current property. Milano → '' (bare URL, byte-identical
  // to the pre-multi-property behaviour); campomarino → '?property=campomarino'.
  const propQuery = property === 'milano' ? '' : `?property=${property}`;

  // Always-current property, immune to stale closures. fetchRooms reads this
  // (not the captured `property`) to bail when an in-flight reply lands after
  // the user has already switched homes.
  const propertyRef = useRef<PropertyId>(property);
  useEffect(() => { propertyRef.current = property; }, [property]);

  const fetchSeason = useCallback(async () => {
    try {
      const res = await fetch(`/api/settings${property === 'milano' ? '' : `?property=${property}`}`);
      const data = await res.json();
      if (data.ok) {
        setSeason(
          data.season === 'cool' ? 'cool' : data.season === 'off' ? 'off' : 'heat',
        );
      }
    } catch { /* silent */ }
  }, [property]);

  const fetchRooms = useCallback(async () => {
    // Capture the property this fetch is FOR. A switch (or the 60s poll) can
    // leave a previous-property request in flight; if it resolves after the
    // new one it must NOT overwrite state with the other home's rooms. The
    // backend echoes `property` in the response — drop any reply that doesn't
    // match the property still selected when it lands. (Stale-response race:
    // tab Campomarino briefly showed Milano's fancoils.)
    const requestedProperty = property;
    try {
      const res = await fetch(`/api/rooms${propQuery}`);
      const data = await res.json();
      // Drop a reply that no longer matches the selected home (stale-response
      // race). propertyRef.current is the live value, immune to this closure's
      // captured `property`. See shouldApplyRoomsReply for the full rule.
      if (!shouldApplyRoomsReply(data.property, requestedProperty, propertyRef.current)) return;
      if (data.ok) {
        const serverRooms: RoomStatus[] = data.rooms;
        const PROTECT_MS = 120_000; // keep optimistic values for 2min after command
        setRooms(prev => {
          if (prev.length === 0) return serverRooms;
          return serverRooms.map(sr => {
            const cmdTime = lastCommandTime.current[sr.roomId];
            if (cmdTime && Date.now() - cmdTime < PROTECT_MS) {
              // Merge optimistic setpoint/fan only — NOT mode. The server's
              // mode comes from deriveFancoilMode (fanRunning-derived, the
              // safety-critical ON/OFF signal); trusting a stale optimistic
              // mode here would mask a command that silently failed (e.g. a
              // fancoil shown "off" while it's actually blowing on Nursery).
              // sendCommand clears lastCommandTime on a failed request, so a
              // failure also stops protecting setpoint/fan on the next poll.
              const local = prev.find(r => r.roomId === sr.roomId);
              if (local) {
                return {
                  ...sr,
                  setpoint: local.setpoint,
                  fanSpeed: local.fanSpeed,
                };
              }
            }
            return sr;
          });
        });
        if (data.thermostat) {
          // Protect thermostat optimistic state
          const thermCmdTime = lastCommandTime.current['_thermostat'];
          if (thermCmdTime && Date.now() - thermCmdTime < PROTECT_MS) {
            setThermostat(prev => prev ? { ...data.thermostat, setpoint: prev.setpoint } : data.thermostat);
          } else {
            setThermostat(data.thermostat);
          }
        }
        setLastUpdate(new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }));
        setError(null);
      } else {
        setError(data.error);
      }
    } catch {
      setError('Connessione fallita');
    } finally {
      setLoading(false);
    }
  }, [propQuery, property]);

  const fetchWeather = useCallback(async () => {
    try {
      const { lat, lon } = property === 'campomarino'
        ? { lat: 41.95, lon: 15.05 }
        : { lat: 45.4642, lon: 9.1900 };
      const res = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code&daily=temperature_2m_min,temperature_2m_max&timezone=Europe/Rome&forecast_days=1`,
      );
      const data = await res.json();
      const code = data.current?.weather_code ?? 0;
      setWeather({
        temp: data.current?.temperature_2m,
        humidity: data.current?.relative_humidity_2m,
        min: data.daily?.temperature_2m_min?.[0],
        max: data.daily?.temperature_2m_max?.[0],
        code,
        ...weatherCodeToInfo(code),
      });
    } catch { /* silent */ }
  }, [property]);

  // Hydrate the saved property once on mount (before the first fetch settles).
  useEffect(() => {
    const saved = localStorage.getItem('thermoleo:property');
    if (saved === 'milano' || saved === 'campomarino') setProperty(saved);
  }, []);

  // Persist the property choice whenever it changes.
  useEffect(() => {
    localStorage.setItem('thermoleo:property', property);
  }, [property]);

  // On every property switch, clear the other home's rooms and show the loading
  // state until the new home's first fetch lands. Without this the old cards
  // (Milano's 5 fancoils) keep rendering for the seconds the fetch is in flight
  // — the visible half of "tab Campomarino shows Milano". The race guard in
  // fetchRooms handles the other half (a stale reply overwriting fresh state).
  useEffect(() => {
    setRooms([]);
    setThermostat(null);
    setLoading(true);
  }, [property]);

  useEffect(() => {
    fetchSeason();
    fetchRooms();
    fetchWeather();
    // Poll rooms every 60s. Poll season alongside so the UI mirrors backend
    // changes from /settings (or any out-of-band season flip) within the
    // same minute — otherwise a stale 'heat' default would keep bathroom
    // cards editable in summer + flash "Valvola chiusa" on fancoil cards
    // while the chiller is actually running.
    const interval = setInterval(() => {
      fetchSeason();
      fetchRooms();
    }, 60_000);
    const weatherInterval = setInterval(fetchWeather, 10 * 60_000); // 10 min
    return () => {
      clearInterval(interval);
      clearInterval(weatherInterval);
      Object.values(debounceTimers.current).forEach(clearTimeout);
      debounceTimers.current = {};
    };
  }, [fetchSeason, fetchRooms, fetchWeather]);

  const changeSeason = async (newSeason: Season) => {
    if (newSeason === season || seasonLoading) return;
    setSeasonLoading(true);
    setSeason(newSeason);
    try {
      // Property-scoped: a season change on the Campomarino tab MUST write
      // settings:campomarino, never settings:milano (that flipped Milano to
      // cool once — the empty house must stay off).
      await fetch(`/api/settings${propQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ season: newSeason }),
      });
      setTimeout(fetchRooms, 2500);
    } catch { /* silent */ }
    finally { setSeasonLoading(false); }
  };

  // --- Debounced command system ---
  // Tracks pending values per room so rapid clicks accumulate correctly
  const pendingRef = useRef<Record<string, { setpoint: number; fan: number; mode: SabianaMode; deviceId: string; netatmoRoomId?: string }>>({});
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Tracks last command time per room — fetchRooms preserves optimistic setpoint/fan/mode
  // for 35 seconds (longer than the 30s polling interval, so the device has time to update)
  const lastCommandTime = useRef<Record<string, number>>({});

  const sendCommand = useCallback(async (
    deviceId: string,
    temperature: number,
    mode: SabianaMode,
    fan: number,
    roomId: string,
  ) => {
    setSending(deviceId);
    lastCommandTime.current[roomId] = Date.now();
    try {
      const res = await fetch('/api/sabiana/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, temperature, mode, fan }),
      });
      // If the command didn't land, stop protecting optimistic values — let
      // the next poll show ground truth instead of a phantom "applied" state.
      if (!res.ok) delete lastCommandTime.current[roomId];
    } catch {
      delete lastCommandTime.current[roomId];
    }
    finally { setSending(null); }
  }, []);

  const sendNetatmoCommand = useCallback(async (netatmoRoomId: string, temperature: number, roomId: string) => {
    setSending(roomId);
    lastCommandTime.current[roomId] = Date.now();
    try {
      await fetch('/api/netatmo/setpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: netatmoRoomId, temperature, dashboardRoomId: roomId }),
      });
    } catch { /* silent */ }
    finally { setSending(null); }
  }, []);

  const flushCommand = useCallback((roomId: string) => {
    const p = pendingRef.current[roomId];
    if (!p) return;
    delete pendingRef.current[roomId];
    if (p.netatmoRoomId) {
      sendNetatmoCommand(p.netatmoRoomId, p.setpoint, roomId);
    } else {
      sendCommand(p.deviceId, p.setpoint, p.mode, p.fan, roomId);
    }
  }, [sendCommand, sendNetatmoCommand]);

  const adjustTemp = (room: RoomStatus, delta: number) => {
    const roomId = room.roomId;
    // Bathroom Netatmo valves are physically forced closed (7°C, 180-day
    // endtime) whenever season != 'heat'. Their radiators carry building-loop
    // water; in cool/off that water is cold or absent, and an open valve
    // condenses bathroom humidity onto the cold metal → mould risk. Changing
    // the target in those states is misleading because the valve won't move.
    if (BATHROOM_ROOMS.has(roomId) && season !== 'heat') {
      return;
    }
    const current = room.targetTemp;
    const newTarget = Math.round(Math.max(18, Math.min(28, current + delta)) * 2) / 2; // 0.5°C step, 18-28 range

    // Optimistic UI — update targetTemp locally
    setRooms(prev => prev.map(r =>
      r.roomId === roomId ? { ...r, targetTemp: newTarget } : r
    ));

    // Debounce: save to DB after 700ms of no clicks
    if (debounceTimers.current[roomId]) clearTimeout(debounceTimers.current[roomId]);
    debounceTimers.current[roomId] = setTimeout(async () => {
      setSending(roomId);
      try {
        const res = await fetch(`/api/rooms/${roomId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetTemp: newTarget }),
        });
        if (!res.ok) console.error('Target save failed:', res.status);
      } catch (e) {
        console.error('Target save error:', e);
      } finally {
        setSending(null);
      }
    }, 700);

    // For Netatmo rooms, also send the setpoint command (agent doesn't control Netatmo valves)
    if (room.apiSource === 'netatmo' && room.netatmoRoomId) {
      pendingRef.current[roomId] = {
        setpoint: newTarget, fan: 0, mode: 'heat' as SabianaMode, deviceId: '',
        netatmoRoomId: room.netatmoRoomId,
      };
      // Use a separate timer so DB save and Netatmo command don't conflict
      setTimeout(() => flushCommand(roomId), 800);
    }
  };

  // Campomarino MELCloud split: pin the manual mode (cool/dry). Optimistic UI,
  // then POST. The agent honours the pin (auto-cool escalation can still override
  // a 'dry' if the room gets hot — the card mode then shows the device's real
  // mode at the next poll). melcloud-only.
  const changeMode = (room: RoomStatus, mode: 'cool' | 'dry') => {
    if (room.apiSource !== 'melcloud') return;
    setRooms(prev => prev.map(r => r.roomId === room.roomId ? { ...r, manualMode: mode, mode } : r));
    fetch('/api/melcloud/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: room.roomId, mode }),
    }).catch(() => { /* next poll reconciles */ });
  };

  const changeFan = (room: RoomStatus, fan: number) => {
    // Campomarino MELCloud split: persist a manual fan override (UI wins,
    // permanent until changed). Optimistic UI, then POST to the command route
    // which writes manualFan + re-sends immediately if the split is on.
    if (room.apiSource === 'melcloud') {
      setRooms(prev => prev.map(r => r.roomId === room.roomId ? { ...r, fanSpeed: fan } : r));
      fetch('/api/melcloud/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId, fan }),
      }).catch(() => {});
      return;
    }
    if (!room.deviceId || room.apiSource !== 'sabiana') return;
    const roomId = room.roomId;

    pendingRef.current[roomId] = {
      setpoint: pendingRef.current[roomId]?.setpoint ?? room.setpoint ?? 22,
      fan,
      mode: (pendingRef.current[roomId]?.mode ?? room.mode) as SabianaMode,
      deviceId: room.deviceId,
    };

    setRooms(prev => prev.map(r =>
      r.roomId === roomId ? { ...r, fanSpeed: fan } : r
    ));

    if (debounceTimers.current[roomId]) clearTimeout(debounceTimers.current[roomId]);
    debounceTimers.current[roomId] = setTimeout(() => flushCommand(roomId), 700);
  };

  // Manual power toggle for a campomarino MELCloud split. Optimistic, then POSTs
  // to /api/melcloud/command. The agent's next cycle re-governs it (it's the
  // brain) — a manual OFF on a hot room will be re-evaluated, same as Milano.
  // The OFF path is VERIFIED server-side (it reads the device back); if the split
  // refused to turn off the server returns applied:false → we REVERT the toggle
  // so the card never lies about a baby room's split. (board Opus+GLM 2026-06-23)
  const toggleMelcloudPower = (room: RoomStatus) => {
    const turningOn = room.mode === 'off';
    const prevMode = room.mode;
    setRooms(prev => prev.map(r =>
      r.roomId === room.roomId ? { ...r, mode: turningOn ? 'cool' : 'off' } : r,
    ));
    fetch('/api/melcloud/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: room.roomId, power: turningOn }),
    })
      .then(async res => {
        // Server confirms OFF only when the device read-back says power=false.
        // On a non-OK response (502 applied:false) revert the optimistic toggle.
        if (!res.ok) {
          setRooms(prev => prev.map(r => r.roomId === room.roomId ? { ...r, mode: prevMode } : r));
        }
      })
      .catch(() => { /* network error — next poll reconciles */ });
  };

  const togglePower = (room: RoomStatus) => {
    if (room.apiSource === 'melcloud') { toggleMelcloudPower(room); return; }
    if (!room.deviceId || room.apiSource !== 'sabiana') return;
    const isOff = room.mode === 'off';
    // Global OFF: never power a fancoil back ON from a card (to run one, the
    // user re-arms the season). BUT if a fancoil is somehow still running in
    // off (failed shutdown / panel-on), the toggle MUST be able to force it
    // OFF — that's the manual override we never want to take away.
    if (season === 'off') {
      if (isOff) return; // already off: nothing to do, and we won't turn it on
      setRooms(prev => prev.map(r => r.roomId === room.roomId ? { ...r, mode: 'off' } : r));
      sendCommand(room.deviceId, room.setpoint ?? 22, 'off', room.fanSpeed ?? 4, room.roomId);
      return;
    }
    const newMode: SabianaMode = isOff ? (season === 'heat' ? 'heat' : 'cool') : 'off';
    setRooms(prev => prev.map(r =>
      r.roomId === room.roomId ? { ...r, mode: newMode } : r
    ));
    sendCommand(room.deviceId, room.setpoint ?? 22, newMode, room.fanSpeed ?? 4, room.roomId);
  };

  const adjustThermostat = (delta: number) => {
    const current = pendingRef.current['_thermostat']?.setpoint ?? thermostat?.setpoint ?? 25;
    const newTemp = Math.max(5, Math.min(35, +(current + delta).toFixed(1)));
    pendingRef.current['_thermostat'] = {
      setpoint: newTemp, fan: 0, mode: 'heat' as SabianaMode, deviceId: '',
      netatmoRoomId: thermostatNetatmoId,
    };
    setThermostat(prev => prev ? { ...prev, setpoint: newTemp } : prev);
    if (debounceTimers.current['_thermostat']) clearTimeout(debounceTimers.current['_thermostat']);
    debounceTimers.current['_thermostat'] = setTimeout(() => {
      const p = pendingRef.current['_thermostat'];
      if (!p) return;
      delete pendingRef.current['_thermostat'];
      sendNetatmoCommand(thermostatNetatmoId, p.setpoint, '_thermostat');
    }, 700);
  };

  // Winter-only signal: when Smarther 2 is satisfied (room temp ≥ setpoint),
  // the boiler stops calling and the zone valve closes — fancoils receive
  // no hot water, so their cards are visually inactive.
  //
  // Defensive: also bail out if Smarther setpoint is ≥ 30°C — that's the
  // sentinel used by ensureSmartherSummerOpen() to force the valve OPEN in
  // summer. If we ever see that setpoint with season still showing 'heat'
  // (stale client cache, mid-transition), we must NOT label cards "Valvola
  // chiusa" because the valve is actually open and the chiller is running.
  const zoneValveClosed = season === 'heat'
    && thermostat?.temperature != null && thermostat?.setpoint != null
    && thermostat.setpoint < 30
    && thermostat.temperature >= thermostat.setpoint;

  return (
    <main className="px-4 pt-safe max-w-lg mx-auto pb-4 touch-manipulation">
      {/* ── Header ── */}
      <div className="flex items-end justify-between pt-6 pb-6">
        <div>
          <h1 className="text-[34px] font-bold tracking-tight bg-gradient-to-b from-white to-white/70 bg-clip-text text-transparent">
            Casa
          </h1>
          <p className="text-[13px] text-slate-500 font-medium mt-0.5">
            {loading ? 'Caricamento...' : `Aggiornato ${lastUpdate || ''}`}
          </p>
        </div>
        {/* Refresh pulse indicator */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className={`w-1.5 h-1.5 rounded-full transition-colors duration-1000 ${
            loading ? 'bg-sky-400 animate-pulse' : 'bg-emerald-500/60'
          }`} />
          <span className="text-[11px] text-slate-600 font-medium tabular-nums">
            {lastUpdate || '--:--'}
          </span>
        </div>
      </div>

      {/* ── Weather bar — Milano Porta Romana ── */}
      {weather && (
        <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded-2xl bg-white/[0.04] backdrop-blur-xl border border-white/[0.06]">
          <div className="w-8 h-8 flex items-center justify-center text-amber-400/70">
            <WeatherIcon icon={weather.icon} className="w-6 h-6" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[18px] font-light tabular-nums text-white">{weather.temp?.toFixed(1)}°</span>
              <span className="text-[11px] text-slate-500 font-medium">{weather.description}</span>
            </div>
            <div className="flex items-center gap-3 mt-0.5">
              <span className="text-[10px] text-sky-400/70 font-medium tabular-nums">
                Min {weather.min?.toFixed(0)}°
              </span>
              <span className="text-[10px] text-orange-400/70 font-medium tabular-nums">
                Max {weather.max?.toFixed(0)}°
              </span>
              <span className="text-[10px] text-slate-600 font-medium">
                {property === 'campomarino' ? 'Campomarino' : 'Porta Romana'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-sky-500/40" aria-hidden="true">
              <path d="M10 2S5 8.5 5 12.5a5 5 0 0 0 10 0C15 8.5 10 2 10 2Z" />
            </svg>
            <span className="text-[11px] text-slate-500 tabular-nums">{weather.humidity}%</span>
          </div>
        </div>
      )}

      {/* ── Error banner ── */}
      {error && (
        <div role="alert" className="mb-4 px-4 py-3 rounded-2xl bg-red-500/10 backdrop-blur-xl border border-red-500/20 text-red-400 text-[13px] font-medium flex items-center gap-2.5">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 flex-shrink-0 opacity-80" aria-hidden="true">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
          </svg>
          {error}
        </div>
      )}

      {/* ── Property selector — which home (Milano / Campomarino) ── */}
      <div className="mb-4">
        <div className="relative flex bg-white/[0.04] rounded-2xl p-1 max-w-xs">
          <div
            className={`absolute top-1 bottom-1 w-[calc(50%-3px)] rounded-xl bg-gradient-to-r from-white/15 to-white/5 shadow-[0_0_12px_-2px_rgba(255,255,255,0.2)] transition-all duration-300 ease-out ${
              property === 'milano' ? 'left-1' : 'left-[calc(50%+1px)]'
            }`}
          />
          {PROPERTIES.map((p) => (
            <button
              key={p.id}
              onClick={() => setProperty(p.id)}
              className={`relative z-10 flex-1 py-2 text-[13px] font-semibold tracking-tight rounded-xl transition-colors ${
                property === p.id ? 'text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Impianto — Season control (governs ALL rooms) ── */}
      <section className="mb-4 rounded-3xl overflow-hidden bg-gradient-to-br from-white/[0.07] to-white/[0.02] backdrop-blur-xl border border-white/[0.08] shadow-lg">
        {/* Top gradient strip — colored by current mode */}
        <div className={`h-0.5 w-full transition-colors duration-700 ${
          season === 'heat'
            ? 'bg-gradient-to-r from-orange-500/60 via-amber-500/40 to-orange-500/20'
            : season === 'cool'
              ? 'bg-gradient-to-r from-sky-500/60 via-blue-500/40 to-sky-500/20'
              : 'bg-gradient-to-r from-slate-500/40 via-slate-600/30 to-slate-500/10'
        }`} />

        <div className="px-5 pt-3.5 pb-1 flex items-center gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight text-slate-300">Impianto</h2>
          <span className="text-[12px] text-slate-500 font-medium">· tutte le stanze</span>
        </div>

        {/* Season segmented control — iOS style, 3 segments: Inverno / Estate / Off */}
        <div className="px-5 pb-4 pt-1">
          <div className="relative flex bg-white/[0.04] rounded-2xl p-1">
            {/* Sliding pill indicator — 3 positions */}
            <div
              className={`absolute top-1 bottom-1 w-[calc(33.333%-3px)] rounded-xl transition-all duration-300 ease-out ${
                season === 'heat'
                  ? 'left-1 bg-gradient-to-r from-orange-500/25 to-amber-500/15 shadow-[0_0_12px_-2px_rgba(245,158,11,0.3)]'
                  : season === 'cool'
                    ? 'left-[calc(33.333%+1px)] bg-gradient-to-r from-sky-500/25 to-blue-500/15 shadow-[0_0_12px_-2px_rgba(56,189,248,0.3)]'
                    : 'left-[calc(66.666%+2px)] bg-gradient-to-r from-slate-500/25 to-slate-600/15 shadow-[0_0_12px_-2px_rgba(100,116,139,0.3)]'
              }`}
            />
            <button
              onClick={() => changeSeason('heat')}
              disabled={seasonLoading}
              aria-pressed={season === 'heat'}
              className={`relative z-10 flex-1 py-3 rounded-xl text-[13px] font-semibold transition-colors duration-300
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50
                disabled:opacity-40 ${
                season === 'heat' ? 'text-orange-300' : 'text-slate-500'
              }`}
            >
              Inverno
            </button>
            <button
              onClick={() => changeSeason('cool')}
              disabled={seasonLoading}
              aria-pressed={season === 'cool'}
              className={`relative z-10 flex-1 py-3 rounded-xl text-[13px] font-semibold transition-colors duration-300
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50
                disabled:opacity-40 ${
                season === 'cool' ? 'text-sky-300' : 'text-slate-500'
              }`}
            >
              Estate
            </button>
            <button
              onClick={() => {
                if (season !== 'off') {
                  const ok = window.confirm('Spegnere tutto l\'impianto? Tutti i fancoil verranno spenti e le valvole dei bagni chiuse. Usalo quando sei fuori casa.');
                  if (!ok) return;
                }
                changeSeason('off');
              }}
              disabled={seasonLoading}
              aria-pressed={season === 'off'}
              className={`relative z-10 flex-1 py-3 rounded-xl text-[13px] font-semibold transition-colors duration-300
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/50
                disabled:opacity-40 ${
                season === 'off' ? 'text-slate-200' : 'text-slate-500'
              }`}
            >
              Off
            </button>
          </div>
          {season === 'off' && (
            <p className="mt-2.5 text-[11px] text-slate-500 leading-snug">
              {property === 'milano'
                ? 'Impianto spento — fancoil tutti off, bagni in antigelo. Riattiva Inverno o Estate per ripartire.'
                : 'Impianto spento — split tutti off. Riattiva Inverno o Estate per ripartire.'}
            </p>
          )}
        </div>
      </section>

      {/* ── Termostato Zona — Smarther 2 reading (Milano only; Campomarino has
            no zone thermostat, just MELCloud splits) ── */}
      {property === 'milano' && (
      <section className="mb-5 rounded-3xl overflow-hidden bg-gradient-to-br from-white/[0.07] to-white/[0.02] backdrop-blur-xl border border-white/[0.08] shadow-lg">
        {/* Top gradient strip */}
        <div className={`h-0.5 w-full transition-colors duration-700 ${
          zoneValveClosed
            ? 'bg-white/[0.06]'
            : season === 'heat'
              ? 'bg-gradient-to-r from-orange-500/60 via-amber-500/40 to-orange-500/20'
              : 'bg-gradient-to-r from-sky-500/60 via-blue-500/40 to-sky-500/20'
        }`} />

        <div className="px-5 pt-4 pb-2 flex items-center gap-3">
          <div className={`w-10 h-10 rounded-2xl flex items-center justify-center transition-colors duration-500 ${
            zoneValveClosed ? 'bg-white/[0.04]' : season === 'heat' ? 'bg-orange-500/15' : 'bg-sky-500/15'
          }`}>
            {season === 'heat' ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className={`w-5 h-5 transition-colors duration-300 ${zoneValveClosed ? 'text-slate-600' : 'text-orange-400'}`} aria-hidden="true">
                <circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className={`w-5 h-5 transition-colors duration-300 ${zoneValveClosed ? 'text-slate-600' : 'text-sky-400'}`} aria-hidden="true">
                <path d="M2 12h10" /><path d="M9 4v16" /><path d="m3 9 3 3-3 3" />
                <path d="M12 6 8 2" /><path d="m14 6-2 2" /><path d="M12 18l-4 4" /><path d="m14 18-2-2" />
              </svg>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className={`text-[16px] font-semibold tracking-tight transition-colors duration-300 ${zoneValveClosed ? 'text-slate-500' : ''}`}>Termostato Zona</h2>
            <span className="text-[12px] text-slate-500 font-medium">
              {zoneValveClosed ? 'Valvola chiusa' : 'Smarther 2 · Soggiorno'}
            </span>
          </div>
          {/* Thermostat temperature + target with controls */}
          {thermostat?.temperature !== null && thermostat?.temperature !== undefined && (
            <div className="flex items-center gap-3">
              {/* Current temp — always visible */}
              <div className="flex flex-col items-end">
                <div className="flex items-baseline gap-0.5">
                  <span className="text-[26px] font-extralight tabular-nums tracking-tighter leading-none text-white">
                    {thermostat.temperature.toFixed(1)}
                  </span>
                  <span className="text-[12px] font-extralight text-slate-500">°</span>
                </div>
                {thermostat.humidity !== null && thermostat.humidity !== undefined && (
                  <span className="text-[10px] text-slate-500">{thermostat.humidity}%</span>
                )}
              </div>
              {/* Target with ± — simple inline, no ring */}
              {thermostat.setpoint !== null && thermostat.setpoint !== undefined && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => adjustThermostat(-0.5)}
                    className="w-7 h-7 rounded-full bg-white/[0.06] border border-white/[0.08]
                      hover:bg-white/[0.1] active:bg-white/[0.14] active:scale-95
                      flex items-center justify-center text-slate-400 transition-all duration-200"
                    aria-label="Diminuisci target termostato"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M4 10a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75A.75.75 0 0 1 4 10Z" /></svg>
                  </button>
                  <div className="flex items-baseline gap-0.5 px-0.5">
                    <span className="text-[18px] font-extralight tabular-nums tracking-tighter leading-none text-slate-400">
                      {thermostat.setpoint.toFixed(1)}
                    </span>
                    <span className="text-[10px] font-extralight text-slate-600">°</span>
                  </div>
                  <button
                    onClick={() => adjustThermostat(0.5)}
                    className="w-7 h-7 rounded-full bg-white/[0.06] border border-white/[0.08]
                      hover:bg-white/[0.1] active:bg-white/[0.14] active:scale-95
                      flex items-center justify-center text-slate-400 transition-all duration-200"
                    aria-label="Aumenta target termostato"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" /></svg>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
      )}

      {/* ── Room Cards ── */}
      {loading && rooms.length === 0 ? (
        <div className="space-y-4" aria-label="Caricamento stanze">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-44 rounded-3xl bg-white/[0.03] backdrop-blur-xl border border-white/[0.06] animate-pulse"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-3.5">
          {rooms.map((room, idx) => (
            <RoomCard
              key={room.roomId}
              room={room}
              sending={sending === room.deviceId || sending === room.roomId}
              onAdjustTemp={(delta) => adjustTemp(room, delta)}
              onChangeFan={(fan) => changeFan(room, fan)}
              onChangeMode={(mode) => changeMode(room, mode)}
              onTogglePower={() => togglePower(room)}
              index={idx}
              zoneValveClosed={zoneValveClosed && room.apiSource === 'sabiana'}
              bathroomLocked={BATHROOM_ROOMS.has(room.roomId) && season !== 'heat'}
              systemOff={season === 'off' && room.apiSource === 'sabiana'}
            />
          ))}
        </div>
      )}
    </main>
  );
}

/* ══════════════════════════════════════════════════════════
   Room Card — iOS 2026 Premium / Distance-Based Color System
   ══════════════════════════════════════════════════════════ */
function RoomCard({
  room,
  sending,
  onAdjustTemp,
  onChangeFan,
  onChangeMode,
  onTogglePower,
  index,
  zoneValveClosed = false,
  bathroomLocked = false,
  systemOff = false,
}: {
  room: RoomStatus;
  sending: boolean;
  onAdjustTemp: (delta: number) => void;
  onChangeFan: (fan: number) => void;
  onChangeMode: (mode: 'cool' | 'dry') => void;
  onTogglePower: () => void;
  index: number;
  zoneValveClosed?: boolean;
  /** Set when a Netatmo bathroom room is forced-closed for anti-condensation
   *  (season != 'heat'). Disables setpoint adjust + shows "Valvola chiusa". */
  bathroomLocked?: boolean;
  /** Set when season='off' (global shutdown). The fancoil is forced off and
   *  the power toggle is disabled — to run it the user re-arms the season. */
  systemOff?: boolean;
}) {
  const isSabiana = room.apiSource === 'sabiana';
  const isMelcloud = room.apiSource === 'melcloud';
  // Campomarino splits are read-only in the UI until their actuation gate opens
  // (independent sensor validated). The card shows live state + a "sola lettura"
  // badge and disables every control.
  const melcloudReadOnly = isMelcloud && room.actuationEnabled !== true;
  // Vendor label shown on the card's device badge (don't say "Valvola BTicino"
  // for a Mitsubishi split).
  const deviceLabel = isMelcloud ? 'Split Mitsubishi' : isSabiana ? 'Fancoil Sabiana' : 'Valvola BTicino';
  const temp = room.temperature;
  const isOff = room.mode === 'off';

  // Bridge freshness. The API already hides stale temps (temperature === null),
  // but we surface WHY so the user sees 'bridge fermo Xm' instead of a silent '--'.
  const bridgeAgeMinutes = room.bridgeAgeMs != null && Number.isFinite(room.bridgeAgeMs)
    ? Math.floor(room.bridgeAgeMs / 60_000)
    : null;
  const bridgeStale = room.bridgeStale ?? false;
  const bridgeNeverSeen = room.bridgeUpdatedAt == null;
  // Nursery is priority 1 (life-safety). Promote bridge issues to a loud,
  // red warning so a silent bridge cannot hide behind a grey card.
  const isNursery = room.roomId === 'leone';
  const leoneBridgeAlert = isNursery && (bridgeStale || bridgeNeverSeen);

  // If zone valve is closed (winter Smarther satisfied) OR the bathroom is
  // forced-closed for anti-condensation (cool/off season) OR the whole system
  // is in global OFF, treat the card as inactive — all grey, no warm/cold tint.
  // systemOff (season=off) is OR'd in only when the unit is ACTUALLY off
  // (isOff comes from the server's fanRunning-derived mode). If a fancoil is
  // still physically blowing in global-off — shutdown command failed, rate
  // limited, connection flapped, or someone switched it on at the CB-Touch
  // panel — it must NOT be greyed out and its toggle must stay live, so the
  // user can see it and force it off. Never hide a blowing fancoil.
  const effectivelyInactive = (zoneValveClosed && !isOff) || bathroomLocked || (systemOff && isOff) || melcloudReadOnly;
  const state = effectivelyInactive ? 'off' as TempState : classifyTemp(temp, room.targetTemp, isOff && (isSabiana || isMelcloud));
  const c = effectivelyInactive ? { ...STATE_COLORS['off'], label: 'text-slate-600' } : STATE_COLORS[state];
  // MELCloud mode label: the split's current operating mode when running.
  const MEL_MODE_LABEL: Record<string, string> = {
    cool: 'Raffresca', dry: 'Deumidifica', heat: 'Riscalda', auto: 'Auto', fan: 'Ventila',
  };
  const stateLabel = melcloudReadOnly
    ? (isOff ? 'Spento · sola lettura' : 'Acceso · sola lettura')
    : isMelcloud
      ? (isOff ? 'Spento' : (MEL_MODE_LABEL[room.mode] ?? 'Acceso'))
    : systemOff
    ? 'Impianto spento'
    : bathroomLocked
      ? 'Valvola chiusa — estate'
      : effectivelyInactive
        ? 'Valvola chiusa'
        : STATE_LABELS[state];

  // Target circle is ALWAYS colored by temp vs target (never grey/off),
  // EXCEPT when the bathroom is locked — then the target is meaningless.
  const targetState = classifyTemp(temp, room.targetTemp, false);
  const tc = bathroomLocked
    ? { ...STATE_COLORS['off'], label: 'text-slate-600' }
    : STATE_COLORS[targetState];

  return (
    <article
      className={`
        rounded-3xl overflow-hidden border backdrop-blur-xl thermo-card card-enter
        bg-gradient-to-br ${c.bg}
        ${leoneBridgeAlert ? 'border-red-500/60 shadow-[0_0_32px_-4px_rgba(239,68,68,0.4)]' : `${c.border} ${c.glow}`}
        ${isOff && isSabiana && !leoneBridgeAlert ? 'opacity-60' : ''}
      `}
      style={{
        animationDelay: `${index * 60}ms`,
      }}
    >
      {/* ── Card Header: Icon + Name + State Badge + Power Toggle ── */}
      <div className="flex items-center gap-3 px-5 pt-4 pb-2">
        {/* Room icon in glass circle — colored by state */}
        <div className={`w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0 transition-colors duration-500 ${c.iconBg} ${c.iconText}`}>
          <RoomIcon icon={room.icon} className="w-5 h-5" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className={`text-[16px] font-semibold tracking-tight truncate transition-colors duration-300 ${
              effectivelyInactive || (isOff && isSabiana) ? 'text-slate-500' : 'text-white'
            }`}>
              {room.name}
            </h3>
          </div>
          {/* State label + active heating indicator */}
          {sending ? (
            <span className="text-[11px] text-sky-400/70 font-medium flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full bg-sky-400 animate-pulse inline-block" />
              Invio comando...
            </span>
          ) : leoneBridgeAlert ? (
            <span className="text-[11px] text-red-400 font-semibold flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse inline-block" />
              {bridgeNeverSeen ? 'Monitoraggio interrotto' : `Bridge fermo ${bridgeAgeMinutes}m`}
            </span>
          ) : melcloudReadOnly ? (
            <span className="text-[11px] text-slate-500 font-medium flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-500 inline-block" />
              Sola lettura
            </span>
          ) : !isMelcloud && (bridgeStale || bridgeNeverSeen) ? (
            // MELCloud splits have no Sonoff bridge — they read their own probe,
            // so the "Sensore offline" bridge badge must not show for them.
            <span className="text-[11px] text-amber-400/80 font-medium flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
              {bridgeNeverSeen ? 'Sensore offline' : `Sensore fermo ${bridgeAgeMinutes}m`}
            </span>
          ) : state !== 'unknown' ? (
            <div className="flex items-center gap-1.5">
              <span className={`text-[12px] font-semibold transition-colors duration-500 ${c.label}`}>
                {stateLabel}
              </span>
              {/* Fancoil running indicator: shows what the fancoil is
                  actually doing right now (mode + fan spinning). The colour
                  matches the season — sky/blue when cooling, orange when
                  heating — so a glance answers "is it doing something?". */}
              {isSabiana && !isOff && room.fanSpeed != null && room.fanSpeed > 0 && (
                <span className={`flex items-center gap-1 text-[10px] font-medium ${
                  room.mode === 'cool' ? 'text-sky-400/90' : 'text-orange-400/90'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full animate-pulse inline-block ${
                    room.mode === 'cool' ? 'bg-sky-400' : 'bg-orange-400'
                  }`} />
                  {room.mode === 'cool' ? 'Raffrescando' : room.mode === 'heat' ? 'Riscaldando' : 'Attivo'}
                  {' · fan '}{room.fanSpeed ?? '—'}
                </span>
              )}
              {/* Fancoil OFF: shown when at target (SATISFIED — fancoil correctly stopped) */}
              {isSabiana && isOff && temp != null && (
                <span className="flex items-center gap-1 text-[10px] text-emerald-500/80 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                  A target
                </span>
              )}
              {/* Netatmo valve heating indicator */}
              {!isSabiana && (room.heatingPowerRequest ?? 0) > 0 && (
                <span className="flex items-center gap-1 text-[10px] text-orange-400/80 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse inline-block" />
                  {room.heatingPowerRequest}%
                </span>
              )}
            </div>
          ) : !isSabiana && !room.connectionUp ? (
            <span className="text-[11px] text-slate-600 font-medium">Collegamento in corso</span>
          ) : null}
        </div>

        {/* iOS Power Toggle (Sabiana fancoils + MELCloud splits) */}
        {(isSabiana || isMelcloud) && (
          <button
            onClick={onTogglePower}
            disabled={sending || effectivelyInactive}
            aria-label={`${room.name} ${isOff ? 'accendi' : 'spegni'}`}
            className={`
              relative w-[52px] h-[31px] rounded-full transition-all duration-300 flex-shrink-0
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900
              disabled:opacity-40
              ${effectivelyInactive
                ? 'bg-white/[0.05]'
                : isOff
                  ? 'bg-white/[0.08]'
                  : 'bg-emerald-500/80 shadow-[0_0_12px_-2px_rgba(16,185,129,0.4)]'
              }
            `}
          >
            <span
              className={`
                absolute top-[2px] w-[27px] h-[27px] rounded-full bg-white shadow-md
                transition-all duration-300 ease-out
                ${isOff ? 'left-[2px]' : 'left-[23px]'}
              `}
            />
          </button>
        )}
      </div>

      {/* ── Temperature Display ── */}
      {isOff && isSabiana ? (
        /* OFF state — very muted, greyed out, no controls */
        <div className="px-5 pb-5 pt-1">
          <div className="flex items-center gap-3 opacity-35">
            <span className="text-[42px] font-extralight tabular-nums tracking-tighter leading-none text-slate-500">
              {temp !== null ? `${temp.toFixed(1)}` : '--'}
            </span>
            <span className="text-[24px] font-extralight text-slate-600 -ml-1 mt-1">°C</span>
          </div>
          {/*
            Intentionally no deviceTemp fallback for Sabiana rooms: the T1
            return-air probe drifts to random values when the fancoil is off.
            Showing '--' is more honest than a misleading number.
          */}
          {room.humidity !== null && (
            <div className="mt-2 flex items-center gap-1.5 opacity-50">
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-sky-500/50" aria-hidden="true">
                <path d="M10 2S5 8.5 5 12.5a5 5 0 0 0 10 0C15 8.5 10 2 10 2Z" />
              </svg>
              <span className="text-[11px] text-slate-500 font-medium tabular-nums">{room.humidity}%</span>
            </div>
          )}
        </div>
      ) : isSabiana && room.connectionUp ? (
        /* Sabiana ON — full controls */
        <div className="px-5 pb-5">
          {/* Temperature section */}
          <div className="flex items-center justify-between mt-1">
            {/* Current temperature — large, colored by state */}
            <div className="flex flex-col">
              <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest mb-1">
                Ambiente{room.tempSource === 'device' ? ' (sensore)' : ''}
              </span>
              <div className="flex items-baseline">
                <span className={`text-[48px] font-extralight tabular-nums tracking-tighter leading-none transition-colors duration-600 ${c.text}`}>
                  {temp !== null ? temp.toFixed(1) : '--'}
                </span>
                <span className="text-[20px] font-extralight text-slate-500 ml-0.5">°</span>
              </div>
              {/*
                No Sabiana T1 "Sensore" annotation — that probe reads fancoil
                return air and can be meaningless (e.g. 11°C) when the unit
                is off. The Sonoff bridge is the only truth we show.
              */}
            </div>

            {/* Setpoint circular control — ring colored by state */}
            <div className="flex items-center gap-2">
              {/* Minus button — disabled when the zone valve is closed / system
                  off: changing the target does nothing physically, so don't
                  let the user think it did (mirrors the Netatmo bathroom path). */}
              <button
                onClick={() => onAdjustTemp(-0.5)}
                disabled={effectivelyInactive}
                aria-label={`${room.name} diminuisci target`}
                className="w-11 h-11 rounded-full bg-white/[0.06] backdrop-blur-sm border border-white/[0.08]
                  hover:bg-white/[0.1] active:bg-white/[0.14] active:scale-95
                  flex items-center justify-center text-slate-300 transition-all duration-200
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20
                  disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden="true">
                  <path d="M4 10a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75A.75.75 0 0 1 4 10Z" />
                </svg>
              </button>

              {/* Setpoint display — glass circle, ALWAYS colored by temp vs target */}
              <div className={`
                flex flex-col items-center justify-center
                w-[78px] h-[78px] rounded-full
                bg-white/[0.05] backdrop-blur-xl border-2 ${tc.ringBorder}
                shadow-lg transition-all duration-500
              `}>
                <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider -mb-0.5">Target</span>
                <span className={`text-[26px] font-light tabular-nums tracking-tight leading-none ${tc.accent} transition-colors duration-500`}>
                  {room.targetTemp.toFixed(1)}
                </span>
                <span className="text-[10px] text-slate-600 font-medium -mt-0.5">°C</span>
              </div>

              {/* Plus button — disabled when valve closed / system off. */}
              <button
                onClick={() => onAdjustTemp(0.5)}
                disabled={effectivelyInactive}
                aria-label={`${room.name} aumenta target`}
                className="w-11 h-11 rounded-full bg-white/[0.06] backdrop-blur-sm border border-white/[0.08]
                  hover:bg-white/[0.1] active:bg-white/[0.14] active:scale-95
                  flex items-center justify-center text-slate-300 transition-all duration-200
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20
                  disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden="true">
                  <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
                </svg>
              </button>
            </div>
          </div>

          {/* Status bar — dot + zone colored by state */}
          {temp !== null && (
            <div className="mt-3 flex items-center gap-2.5">
              <div className="flex-1 h-1.5 rounded-full bg-white/[0.04] overflow-hidden relative">
                {/* Target zone highlight */}
                <div
                  className="absolute h-full bg-emerald-500/20 rounded-full"
                  style={{
                    left: `${Math.max(0, ((room.targetTemp - 0.2 - 16) / 14) * 100)}%`,
                    width: `${(0.4 / 14) * 100}%`,
                  }}
                />
                {/* Current temp indicator — colored by state */}
                <div
                  className={`absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full shadow-sm transition-all duration-700 ${c.dot}`}
                  style={{ left: `calc(${Math.max(0, Math.min(100, ((temp - 16) / 14) * 100))}% - 5px)` }}
                />
              </div>
              <span className={`text-[11px] font-semibold transition-colors duration-500 min-w-fit ${c.label}`}>
                {stateLabel}
              </span>
            </div>
          )}

          {/* ── Fan Speed — Segmented Control (hidden when valve closed) ── */}
          {/* Melcloud (Campomarino): only 1-3, default Min(1). Sabiana: 1-4, default Auto(4). */}
          {(() => { const fanOpts = isMelcloud ? FAN_OPTIONS.filter(f => f.value <= 3) : FAN_OPTIONS;
            const fanSel = room.fanSpeed ?? (isMelcloud ? 1 : 4);
            return !effectivelyInactive && <div className="mt-4">
            <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest">Ventola</span>
            <div className="relative flex bg-white/[0.03] rounded-2xl p-1 mt-1.5">
              {/* Sliding pill */}
              <div
                className="absolute top-1 bottom-1 rounded-xl bg-sky-500/20 shadow-[0_0_10px_-3px_rgba(56,189,248,0.3)] transition-all duration-300 ease-out"
                style={{
                  width: `calc(${100 / fanOpts.length}% - 4px)`,
                  left: `calc(${(fanSel - 1) * (100 / fanOpts.length)}% + 2px)`,
                }}
              />
              {fanOpts.map((f) => (
                <button
                  key={f.value}
                  onClick={() => onChangeFan(f.value)}
                  aria-label={`Ventola ${f.label}`}
                  aria-pressed={fanSel === f.value}
                  className={`relative z-10 flex-1 py-2.5 rounded-xl text-[12px] font-semibold transition-colors duration-300
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 ${
                    fanSel === f.value
                      ? 'text-sky-300'
                      : 'text-slate-500 hover:text-slate-400 active:text-slate-300'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>; })()}

          {/* Humidity if available */}
          {room.humidity !== null && (
            <div className="mt-3 flex items-center gap-1.5">
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-sky-500/50" aria-hidden="true">
                <path d="M10 2S5 8.5 5 12.5a5 5 0 0 0 10 0C15 8.5 10 2 10 2Z" />
              </svg>
              <span className="text-[11px] text-slate-500 font-medium tabular-nums">{room.humidity}%</span>
            </div>
          )}

        </div>
      ) : isMelcloud && room.connectionUp && !melcloudReadOnly ? (
        /* ── Campomarino MELCloud split — full controls (mode + fan + target) ── */
        <div className="px-5 pb-5">
          {/* Temperature + target */}
          <div className="flex items-center justify-between mt-1">
            <div className="flex flex-col">
              <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest mb-1">Ambiente</span>
              <div className="flex items-baseline">
                <span className={`text-[48px] font-extralight tabular-nums tracking-tighter leading-none transition-colors duration-600 ${c.text}`}>
                  {temp !== null ? temp.toFixed(1) : '--'}
                </span>
                <span className="text-[20px] font-extralight text-slate-500 ml-0.5">°</span>
              </div>
              {room.humidity !== null && (
                <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-sky-500/70 tabular-nums">
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3" aria-hidden="true">
                    <path d="M10 2S5 8.5 5 12.5a5 5 0 0 0 10 0C15 8.5 10 2 10 2Z" />
                  </svg>
                  {room.humidity}%
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onAdjustTemp(-0.5)}
                disabled={effectivelyInactive}
                aria-label={`${room.name} diminuisci target`}
                className="w-11 h-11 rounded-full bg-white/[0.06] backdrop-blur-sm border border-white/[0.08]
                  hover:bg-white/[0.1] active:bg-white/[0.14] active:scale-95
                  flex items-center justify-center text-slate-300 transition-all duration-200
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20
                  disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden="true">
                  <path d="M4 10a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75A.75.75 0 0 1 4 10Z" />
                </svg>
              </button>
              <div className={`flex flex-col items-center justify-center w-[78px] h-[78px] rounded-full bg-white/[0.05] backdrop-blur-xl border-2 ${tc.ringBorder} shadow-lg transition-all duration-500`}>
                <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider -mb-0.5">Target</span>
                <span className={`text-[26px] font-light tabular-nums tracking-tight leading-none ${tc.accent} transition-colors duration-500`}>
                  {room.targetTemp.toFixed(1)}
                </span>
                <span className="text-[10px] text-slate-600 font-medium -mt-0.5">°C</span>
              </div>
              <button
                onClick={() => onAdjustTemp(0.5)}
                disabled={effectivelyInactive}
                aria-label={`${room.name} aumenta target`}
                className="w-11 h-11 rounded-full bg-white/[0.06] backdrop-blur-sm border border-white/[0.08]
                  hover:bg-white/[0.1] active:bg-white/[0.14] active:scale-95
                  flex items-center justify-center text-slate-300 transition-all duration-200
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20
                  disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden="true">
                  <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
                </svg>
              </button>
            </div>
          </div>

          {/* ── Mode selector: Deumidifica (dry) / Raffresca (cool) ── */}
          {!effectivelyInactive && !isOff && (() => {
            // The pinned manual mode wins the highlight; with no pin, highlight the
            // device's actual running mode. AUTO-COOL badge when escalation pushed
            // a dry pin to cool (manualMode='dry' but device is cooling).
            const active = room.manualMode ?? (room.mode === 'cool' ? 'cool' : 'dry');
            const autoCool = room.manualMode === 'dry' && room.mode === 'cool';
            const MODES: Array<{ v: 'dry' | 'cool'; label: string }> = [
              { v: 'dry', label: 'Deumidifica' },
              { v: 'cool', label: 'Raffresca' },
            ];
            return <div className="mt-4">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest">Modalità</span>
                {autoCool && (
                  <span className="text-[9px] font-semibold uppercase tracking-wide text-amber-400/90 bg-amber-400/10 px-1.5 py-0.5 rounded-md">
                    auto-cool
                  </span>
                )}
              </div>
              <div className="relative flex bg-white/[0.03] rounded-2xl p-1 mt-1.5">
                <div
                  className="absolute top-1 bottom-1 rounded-xl bg-sky-500/20 shadow-[0_0_10px_-3px_rgba(56,189,248,0.3)] transition-all duration-300 ease-out"
                  style={{ width: `calc(50% - 4px)`, left: `calc(${active === 'cool' ? 50 : 0}% + 2px)` }}
                />
                {MODES.map(m => (
                  <button
                    key={m.v}
                    onClick={() => onChangeMode(m.v)}
                    aria-label={`Modalità ${m.label}`}
                    aria-pressed={active === m.v}
                    className={`relative z-10 flex-1 py-2.5 rounded-xl text-[12px] font-semibold transition-colors duration-300
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 ${
                      active === m.v ? 'text-sky-300' : 'text-slate-500 hover:text-slate-400 active:text-slate-300'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>;
          })()}

          {/* ── Fan selector incl. Silenzioso (0). Index by position, not value-1
               (silent=0 would push the pill off-screen). ── */}
          {!effectivelyInactive && !isOff && (() => {
            const opts = MELCLOUD_FAN_OPTIONS;
            const selVal = room.fanSpeed ?? 1;
            const selIdx = Math.max(0, opts.findIndex(o => o.value === selVal));
            return <div className="mt-4">
              <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest">Ventola</span>
              <div className="relative flex bg-white/[0.03] rounded-2xl p-1 mt-1.5">
                <div
                  className="absolute top-1 bottom-1 rounded-xl bg-sky-500/20 shadow-[0_0_10px_-3px_rgba(56,189,248,0.3)] transition-all duration-300 ease-out"
                  style={{ width: `calc(${100 / opts.length}% - 4px)`, left: `calc(${selIdx * (100 / opts.length)}% + 2px)` }}
                />
                {opts.map(f => (
                  <button
                    key={f.value}
                    onClick={() => onChangeFan(f.value)}
                    aria-label={`Ventola ${f.label}`}
                    aria-pressed={selVal === f.value}
                    className={`relative z-10 flex-1 py-2.5 rounded-xl text-[11px] font-semibold transition-colors duration-300
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 ${
                      selVal === f.value ? 'text-sky-300' : 'text-slate-500 hover:text-slate-400 active:text-slate-300'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>;
          })()}
        </div>
      ) : (
        /* ── Netatmo rooms — with setpoint controls ── */
        <div className="px-5 pb-5">
          {temp !== null && room.connectionUp ? (
            <>
              {/* Temperature section — same layout as Sabiana */}
              <div className="flex items-center justify-between mt-1">
                {/* Current temperature — large, colored by state */}
                <div className="flex flex-col">
                  <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest mb-1">Ambiente</span>
                  <div className="flex items-baseline">
                    <span className={`text-[48px] font-extralight tabular-nums tracking-tighter leading-none transition-colors duration-600 ${bathroomLocked ? 'text-slate-500' : c.text}`}>
                      {temp.toFixed(1)}
                    </span>
                    <span className="text-[20px] font-extralight text-slate-500 ml-0.5">°</span>
                  </div>
                  {room.deviceTemp !== null && (
                    <span className="text-[10px] text-slate-500/70 tabular-nums mt-0.5">
                      Sensore {room.deviceTemp.toFixed(1)}°
                    </span>
                  )}
                  {bathroomLocked && (
                    <span className="text-[10px] text-sky-400/80 font-semibold mt-1.5">
                      Valvola chiusa — estate
                    </span>
                  )}
                </div>

                {/* Setpoint circular control with +/- and state-colored ring.
                    Disabled entirely when the bathroom valve is forced-closed
                    for anti-condensation (cool/off seasons). */}
                <div className={`flex items-center gap-2 ${bathroomLocked ? 'opacity-40 pointer-events-none' : ''}`}>
                  <button
                    onClick={() => onAdjustTemp(-0.5)}
                    disabled={bathroomLocked}
                    aria-label={`${room.name} diminuisci target`}
                    className="w-11 h-11 rounded-full bg-white/[0.06] backdrop-blur-sm border border-white/[0.08]
                      hover:bg-white/[0.1] active:bg-white/[0.14] active:scale-95
                      flex items-center justify-center text-slate-300 transition-all duration-200
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20
                      disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden="true">
                      <path d="M4 10a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75A.75.75 0 0 1 4 10Z" />
                    </svg>
                  </button>

                  <div className={`flex flex-col items-center justify-center w-[78px] h-[78px] rounded-full
                    bg-white/[0.05] backdrop-blur-xl border-2 ${bathroomLocked ? 'border-slate-700' : c.ringBorder} shadow-lg transition-all duration-500`}>
                    <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider -mb-0.5">Target</span>
                    <span className={`text-[26px] font-light tabular-nums tracking-tight leading-none ${bathroomLocked ? 'text-slate-500' : c.accent} transition-colors duration-500`}>
                      {room.targetTemp.toFixed(1)}
                    </span>
                    <span className="text-[10px] text-slate-600 font-medium -mt-0.5">°C</span>
                  </div>

                  <button
                    onClick={() => onAdjustTemp(0.5)}
                    disabled={bathroomLocked}
                    aria-label={`${room.name} aumenta target`}
                    className="w-11 h-11 rounded-full bg-white/[0.06] backdrop-blur-sm border border-white/[0.08]
                      hover:bg-white/[0.1] active:bg-white/[0.14] active:scale-95
                      flex items-center justify-center text-slate-300 transition-all duration-200
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20
                      disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden="true">
                      <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Sending indicator */}
              {sending && (
                <div className="mt-3 flex items-center justify-center gap-2">
                  <span className="w-1 h-1 rounded-full bg-sky-400 animate-pulse" />
                  <span className="text-[11px] text-sky-400/70 font-medium">Invio comando...</span>
                </div>
              )}
            </>
          ) : temp !== null ? (
            <div className="flex items-center justify-between mt-1">
              <div className="flex flex-col">
                <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest mb-1">Ambiente</span>
                <div className="flex items-baseline">
                  <span className={`text-[48px] font-extralight tabular-nums tracking-tighter leading-none transition-colors duration-600 ${c.text}`}>
                    {temp.toFixed(1)}
                  </span>
                  <span className="text-[20px] font-extralight text-slate-500 ml-0.5">°</span>
                </div>
              </div>
              <span className="text-[11px] text-slate-600 font-medium bg-white/[0.03] px-3 py-1.5 rounded-xl">
                {deviceLabel}
              </span>
            </div>
          ) : (
            <div className="flex items-center justify-between pt-1">
              <div className="flex flex-col">
                <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest mb-1">Target</span>
                <span className="text-[24px] font-extralight tabular-nums tracking-tight leading-none text-slate-500">
                  {room.targetTemp.toFixed(1)}°
                </span>
              </div>
              <span className="text-[11px] text-slate-600 font-medium bg-white/[0.03] px-3 py-1.5 rounded-xl">
                {deviceLabel}
              </span>
            </div>
          )}

          {/* Status bar for Netatmo rooms — state-colored */}
          {temp !== null && (
            <div className="mt-3 flex items-center gap-2.5">
              <div className="flex-1 h-1.5 rounded-full bg-white/[0.04] overflow-hidden relative">
                <div
                  className="absolute h-full bg-emerald-500/20 rounded-full"
                  style={{
                    left: `${Math.max(0, ((room.targetTemp - 0.2 - 16) / 14) * 100)}%`,
                    width: `${(0.4 / 14) * 100}%`,
                  }}
                />
                <div
                  className={`absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full shadow-sm transition-all duration-700 ${c.dot}`}
                  style={{ left: `calc(${Math.max(0, Math.min(100, ((temp - 16) / 14) * 100))}% - 5px)` }}
                />
              </div>
              <span className={`text-[11px] font-semibold transition-colors duration-500 min-w-fit ${c.label}`}>
                {stateLabel}
              </span>
            </div>
          )}

          {/* Humidity if available */}
          {room.humidity !== null && (
            <div className="mt-2 flex items-center gap-1.5">
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-sky-500/50" aria-hidden="true">
                <path d="M10 2S5 8.5 5 12.5a5 5 0 0 0 10 0C15 8.5 10 2 10 2Z" />
              </svg>
              <span className="text-[11px] text-slate-500 font-medium tabular-nums">{room.humidity}%</span>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
