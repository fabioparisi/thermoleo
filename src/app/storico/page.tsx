'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  CartesianGrid,
} from 'recharts';

// --- Types ---
interface Reading {
  room_id: string;
  measured_at: string;
  temperature: number;
  setpoint: number;
  mode: string;
}

interface RoomMeta {
  id: string;
  name: string;
  icon: string;
  target: number;
  color: string;
}

// --- Room config (defaults — runtime targets loaded from API) ---
const ROOMS: RoomMeta[] = [
  { id: 'leone',     name: 'Camera Nursery',    icon: '\u{1F476}', target: 21,   color: '#f59e0b' },
  { id: 'soggiorno', name: 'Soggiorno',       icon: '\u{1F6CB}', target: 21,   color: '#3b82f6' },
  { id: 'studio',    name: 'Studio Fabio',    icon: '\u{1F4BB}', target: 21,   color: '#8b5cf6' },
  { id: 'cucina',    name: 'Cucina',          icon: '\u{1F373}', target: 21,   color: '#10b981' },
  { id: 'camera',    name: 'Camera da letto', icon: '\u{1F6CF}', target: 20.5, color: '#ec4899' },
  { id: 'bagno1',    name: 'Bagno Vasca',     icon: '\u{1F6C1}', target: 22,   color: '#06b6d4' },
  { id: 'bagno2',    name: 'Bagno Doccia',    icon: '\u{1F6BF}', target: 22,   color: '#14b8a6' },
];

type TimeRange = '6h' | '24h' | '7d' | '30d';

const RANGE_CONFIG: Record<TimeRange, { label: string; hours: number; limit: number }> = {
  '6h':  { label: '6 ore',    hours: 6,     limit: 500 },
  '24h': { label: '24 ore',   hours: 24,    limit: 1000 },
  '7d':  { label: '7 giorni', hours: 168,   limit: 3000 },
  '30d': { label: '30 giorni', hours: 720,  limit: 5000 },
};

// --- Custom Tooltip ---
function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; name: string; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl bg-slate-900/95 backdrop-blur-xl border border-white/10 px-3 py-2 shadow-xl">
      <p className="text-[11px] text-slate-400 mb-1">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 text-[12px]">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-slate-300">{p.name}:</span>
          <span className="font-semibold text-white">{p.value?.toFixed(1)}°C</span>
        </div>
      ))}
    </div>
  );
}

// --- Stats Card ---
function StatsCard({ room, readings }: { room: RoomMeta; readings: Reading[] }) {
  // Filter out sensor faults (0°C, null, or clearly wrong values < 5°C)
  const valid = readings.filter(r => r.temperature != null && r.temperature >= 5);
  if (valid.length === 0) return null;
  const temps = valid.map(r => r.temperature);
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
  const avgDelta = avg - room.target;
  const timeOutOfRange = valid.filter(r => r.temperature < room.target - 0.2 || r.temperature > room.target + 0.2).length;
  const pctOutOfRange = (timeOutOfRange / valid.length) * 100;

  return (
    <div className="grid grid-cols-4 gap-2 mt-3">
      <div className="rounded-xl bg-white/[0.04] p-2 text-center">
        <div className="text-[10px] text-slate-500 uppercase tracking-wider">Min</div>
        <div className="text-[15px] font-semibold text-sky-400">{min.toFixed(1)}°</div>
      </div>
      <div className="rounded-xl bg-white/[0.04] p-2 text-center">
        <div className="text-[10px] text-slate-500 uppercase tracking-wider">Max</div>
        <div className="text-[15px] font-semibold text-orange-400">{max.toFixed(1)}°</div>
      </div>
      <div className="rounded-xl bg-white/[0.04] p-2 text-center">
        <div className="text-[10px] text-slate-500 uppercase tracking-wider">Media</div>
        <div className={`text-[15px] font-semibold ${Math.abs(avgDelta) < 0.5 ? 'text-emerald-400' : avgDelta > 0 ? 'text-orange-400' : 'text-sky-400'}`}>
          {avg.toFixed(1)}°
        </div>
      </div>
      <div className="rounded-xl bg-white/[0.04] p-2 text-center">
        <div className="text-[10px] text-slate-500 uppercase tracking-wider">Fuori</div>
        <div className={`text-[15px] font-semibold ${pctOutOfRange > 30 ? 'text-red-400' : pctOutOfRange > 10 ? 'text-amber-400' : 'text-emerald-400'}`}>
          {pctOutOfRange.toFixed(0)}%
        </div>
      </div>
    </div>
  );
}

// --- Room Chart ---
function RoomChart({ room, readings, range }: { room: RoomMeta; readings: Reading[]; range: TimeRange }) {
  const chartData = useMemo(() => {
    // Filter out sensor faults (0°C or clearly wrong < 5°C)
    const valid = readings.filter(r => r.temperature != null && r.temperature >= 5);
    const sorted = [...valid].sort((a, b) => new Date(a.measured_at).getTime() - new Date(b.measured_at).getTime());

    const isShort = range === '6h' || range === '24h';
    const fmt = (iso: string) => {
      const d = new Date(iso);
      if (isShort) return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    };

    return sorted.map(r => ({
      time: fmt(r.measured_at),
      temp: r.temperature,
      setpoint: r.setpoint,
    }));
  }, [readings, range]);

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
        Nessun dato disponibile
      </div>
    );
  }

  // Compute Y axis domain — tight around actual data + target band
  const validTemps = chartData.flatMap(d => [d.temp, d.setpoint].filter(v => v != null && v >= 5));
  const allTemps = [...validTemps, room.target - 0.2, room.target + 0.2];
  const yMin = Math.floor(Math.min(...allTemps) - 1);
  const yMax = Math.ceil(Math.max(...allTemps) + 1);

  // Show fewer ticks on longer ranges
  const tickInterval = range === '6h' ? 5 : range === '24h' ? 11 : range === '7d' ? 23 : 47;

  return (
    <div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />

          {/* Target range band (±0.2°C) */}
          <ReferenceArea
            y1={room.target - 0.2}
            y2={room.target + 0.2}
            fill={room.color}
            fillOpacity={0.06}
            strokeOpacity={0}
          />

          {/* Target lines */}
          <ReferenceLine y={room.target - 0.2} stroke={room.color} strokeDasharray="4 4" strokeOpacity={0.3} />
          <ReferenceLine y={room.target + 0.2} stroke={room.color} strokeDasharray="4 4" strokeOpacity={0.3} />

          <XAxis
            dataKey="time"
            tick={{ fontSize: 10, fill: '#64748b' }}
            tickLine={false}
            axisLine={false}
            interval={tickInterval}
          />
          <YAxis
            domain={[yMin, yMax]}
            tick={{ fontSize: 10, fill: '#64748b' }}
            tickLine={false}
            axisLine={false}
            tickCount={6}
          />
          <Tooltip content={<ChartTooltip />} />

          {/* Setpoint line */}
          <Line
            type="stepAfter"
            dataKey="setpoint"
            name="Setpoint"
            stroke={room.color}
            strokeWidth={1.5}
            strokeDasharray="6 3"
            strokeOpacity={0.5}
            dot={false}
            activeDot={false}
          />

          {/* Temperature line */}
          <Line
            type="monotone"
            dataKey="temp"
            name="Temperatura"
            stroke={room.color}
            strokeWidth={2.5}
            dot={false}
            activeDot={{ r: 4, fill: room.color, stroke: '#0f172a', strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
      <StatsCard room={room} readings={readings} />
    </div>
  );
}

// --- Main Page ---
export default function StoricoPage() {
  const [range, setRange] = useState<TimeRange>('24h');
  const [selectedRoom, setSelectedRoom] = useState<string>('leone');
  const [readings, setReadings] = useState<Reading[]>([]);
  const [loading, setLoading] = useState(true);
  const [dbTargets, setDbTargets] = useState<Record<string, number>>({});

  // Load actual targets from DB on mount
  useEffect(() => {
    fetch('/api/rooms')
      .then(r => r.json())
      .then(data => {
        if (data.ok && Array.isArray(data.rooms)) {
          const map: Record<string, number> = {};
          for (const r of data.rooms) map[r.roomId] = r.targetTemp;
          setDbTargets(map);
        }
      })
      .catch(() => {});
  }, []);

  // Merge DB targets into room metadata (DB wins over hardcoded defaults)
  const rooms = useMemo(() =>
    ROOMS.map(r => ({ ...r, target: dbTargets[r.id] ?? r.target })),
    [dbTargets],
  );

  const fetchReadings = useCallback(async (roomId: string, timeRange: TimeRange) => {
    setLoading(true);
    const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supaUrl || !supaKey) { setLoading(false); return; }

    const cfg = RANGE_CONFIG[timeRange];
    const since = new Date(Date.now() - cfg.hours * 3600_000).toISOString();

    try {
      const res = await fetch(
        `${supaUrl}/rest/v1/readings?room_id=eq.${roomId}&measured_at=gte.${since}&order=measured_at.asc&limit=${cfg.limit}&select=room_id,measured_at,temperature,setpoint,mode`,
        { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } },
      );
      const data = await res.json();
      setReadings(Array.isArray(data) ? data : []);
    } catch {
      setReadings([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // Canonical data-fetch effect: re-fetch when filters change.
    // The linter flags setState inside effect bodies, but fetchReadings
    // is async and awaits before any setState (see its definition above).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchReadings(selectedRoom, range);
  }, [selectedRoom, range, fetchReadings]);

  const currentRoom = rooms.find(r => r.id === selectedRoom) || rooms[0];

  return (
    <main className="px-4 pt-safe max-w-lg mx-auto pb-4">
      <div className="pt-6 pb-4">
        <h1 className="text-[28px] font-bold tracking-tight bg-gradient-to-b from-white to-white/70 bg-clip-text text-transparent">
          Storico
        </h1>
      </div>

      {/* Time range selector */}
      <div className="flex gap-1 p-1 rounded-2xl bg-white/[0.05] backdrop-blur-xl border border-white/[0.08] mb-4">
        {(Object.entries(RANGE_CONFIG) as [TimeRange, { label: string }][]).map(([key, { label }]) => (
          <button
            key={key}
            onClick={() => setRange(key)}
            className={`flex-1 py-2 rounded-xl text-[12px] font-semibold transition-all duration-300 ${
              range === key
                ? 'bg-white/[0.12] text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Room selector — horizontal scroll */}
      <div className="flex gap-2 overflow-x-auto pb-3 -mx-4 px-4 scrollbar-hide mb-2">
        {rooms.map((room) => (
          <button
            key={room.id}
            onClick={() => setSelectedRoom(room.id)}
            className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-semibold transition-all duration-200 ${
              selectedRoom === room.id
                ? 'text-white shadow-lg'
                : 'bg-white/[0.04] text-slate-400 hover:text-slate-300 border border-white/[0.06]'
            }`}
            style={selectedRoom === room.id ? { backgroundColor: room.color + '25', borderColor: room.color + '40', border: `1px solid ${room.color}40` } : undefined}
          >
            <span className="text-sm">{room.icon}</span>
            <span className="whitespace-nowrap">{room.name}</span>
          </button>
        ))}
      </div>

      {/* Chart card */}
      <div className="rounded-2xl bg-white/[0.04] backdrop-blur-xl border border-white/[0.06] p-4">
        {/* Room header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">{currentRoom.icon}</span>
            <span className="text-[15px] font-semibold">{currentRoom.name}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: currentRoom.color }} />
            <span className="text-[11px] text-slate-400">Target {currentRoom.target.toFixed(1)}°C</span>
          </div>
        </div>

        {loading ? (
          <div className="h-[220px] rounded-xl bg-white/[0.03] animate-pulse" />
        ) : (
          <RoomChart room={currentRoom} readings={readings} range={range} />
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center justify-center gap-6 mt-4 text-[11px] text-slate-500">
        <div className="flex items-center gap-1.5">
          <span className="w-6 h-[2.5px] rounded-full" style={{ backgroundColor: currentRoom.color }} />
          <span>Temperatura</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-6 h-[2.5px] rounded-full border-b-2 border-dashed" style={{ borderColor: currentRoom.color, opacity: 0.5 }} />
          <span>Setpoint</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-5 h-3 rounded-sm" style={{ backgroundColor: currentRoom.color, opacity: 0.1 }} />
          <span>Target</span>
        </div>
      </div>
    </main>
  );
}
