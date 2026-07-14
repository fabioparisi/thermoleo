'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { getTempStatus, getTempStatusColor } from '@/lib/types';
import type { RoomStatus } from '@/lib/types';

export default function RoomDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [room, setRoom] = useState<RoomStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState(22);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const fetchRoom = useCallback(async () => {
    try {
      const res = await fetch('/api/rooms');
      const data = await res.json();
      if (data.ok) {
        const found = data.rooms.find((r: RoomStatus) => r.roomId === params.id);
        if (found) {
          setRoom(found);
          setTarget(found.targetTemp);
        }
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    fetchRoom();
  }, [fetchRoom]);

  const saveTarget = async (value: number) => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(`/api/rooms/${params.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetTemp: value }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="px-4 pt-6 max-w-lg mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="w-32 h-6 rounded bg-slate-800" />
          <div className="w-full h-40 rounded-xl bg-slate-800" />
        </div>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="px-4 pt-6 max-w-lg mx-auto text-center text-slate-500">
        Stanza non trovata
      </div>
    );
  }

  const status = getTempStatus(room.temperature, room.targetTemp);
  const borderColor = getTempStatusColor(status);

  return (
    <div className="px-4 pt-6 max-w-lg mx-auto space-y-4">
      {/* Back + title */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="p-2 rounded-lg bg-slate-800/50 hover:bg-slate-700/50 transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-slate-400">
            <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
          </svg>
        </button>
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <span>{room.icon}</span>
            <span>{room.name}</span>
          </h1>
          {!room.connectionUp && (
            <Badge variant="destructive" className="text-[10px] mt-0.5">Offline</Badge>
          )}
        </div>
      </div>

      {/* Current temperature card */}
      <Card className={`border-2 ${borderColor} bg-slate-900/60 p-6 text-center`}>
        <p className="text-xs text-slate-500 mb-1">Temperatura attuale</p>
        <div className="flex items-baseline justify-center gap-1">
          <span className="text-5xl font-light tabular-nums">
            {room.temperature !== null ? room.temperature.toFixed(1) : '--.-'}
          </span>
          <span className="text-xl text-slate-400">°C</span>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Target: {room.targetTemp.toFixed(1)}°C (banda {(room.targetTemp - 0.2).toFixed(1)}-{(room.targetTemp + 0.2).toFixed(1)})
        </p>
      </Card>

      {/* Target temperature control */}
      <Card className="bg-slate-900/60 border-slate-800/50 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-400">Temperatura target</p>
          <span className="text-2xl font-light tabular-nums text-amber-400">
            {target.toFixed(1)}°C
          </span>
        </div>
        <Slider
          value={[target]}
          onValueChange={(v) => setTarget(Array.isArray(v) ? v[0] : v)}
          onValueCommitted={(v) => saveTarget(Array.isArray(v) ? v[0] : v)}
          min={18}
          max={28}
          step={0.5}
          className="py-2"
        />
        <div className="flex justify-between text-[10px] text-slate-600">
          <span>18°C</span>
          <span>23°C</span>
          <span>28°C</span>
        </div>
        <p className="text-[10px] text-slate-600 text-center">
          L&apos;agente mantiene la temperatura tra {(target - 0.2).toFixed(1)} e {(target + 0.2).toFixed(1)}°C
        </p>
      </Card>

      {/* Current device state (read-only info) */}
      <Card className="bg-slate-900/60 border-slate-800/50 p-4 space-y-2">
        <p className="text-sm text-slate-400 mb-1">Stato agente</p>
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Modalita</span>
          <span className="text-slate-300 capitalize">{room.mode === 'heat' ? 'Riscaldamento' : room.mode === 'off' ? 'Spento' : room.mode}</span>
        </div>
        {room.fanSpeed !== null && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">Ventola</span>
            <span className="text-slate-300">{room.fanSpeed === 4 ? 'Auto' : ['Min', 'Med', 'Max'][room.fanSpeed - 1] ?? room.fanSpeed}</span>
          </div>
        )}
        {room.setpoint !== null && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">Setpoint fancoil</span>
            <span className="text-slate-300">{room.setpoint.toFixed(1)}°C</span>
          </div>
        )}
        {room.humidity !== null && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">Umidita</span>
            <span className="text-slate-300">{room.humidity}%</span>
          </div>
        )}
      </Card>

      {/* Save indicator */}
      {saving && (
        <div className="text-center text-xs text-amber-400 animate-pulse">
          Salvataggio...
        </div>
      )}
      {saved && (
        <div className="text-center text-xs text-emerald-400">
          Salvato — l&apos;agente applichera il nuovo target al prossimo ciclo
        </div>
      )}
    </div>
  );
}
