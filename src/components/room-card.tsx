'use client';

import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { RoomStatus } from '@/lib/types';
import { getTempStatus, getTempStatusColor, getTempStatusGlow } from '@/lib/types';

interface RoomCardProps {
  room: RoomStatus;
}

const MODE_LABELS: Record<string, { label: string; color: string }> = {
  heat: { label: 'Inverno', color: 'bg-orange-500/20 text-orange-300 border-orange-500/30' },
  cool: { label: 'Estate', color: 'bg-sky-500/20 text-sky-300 border-sky-500/30' },
  fan_only: { label: 'Ventola', color: 'bg-slate-500/20 text-slate-300 border-slate-500/30' },
  off: { label: 'Spento', color: 'bg-slate-700/20 text-slate-500 border-slate-700/30' },
  schedule: { label: 'Programma', color: 'bg-purple-500/20 text-purple-300 border-purple-500/30' },
};

export function RoomCard({ room }: RoomCardProps) {
  const status = getTempStatus(room.temperature, room.targetTemp);
  const borderColor = getTempStatusColor(status);
  const glowColor = getTempStatusGlow(status);
  const modeInfo = MODE_LABELS[room.mode] || MODE_LABELS.off;
  const isNurseryPriority = room.priority === 1;

  return (
    <Link href={`/room/${room.roomId}`} className="block">
      <Card
        className={`relative overflow-hidden border-2 ${borderColor} bg-slate-900/60 backdrop-blur-sm p-4 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] ${glowColor} ${glowColor ? 'shadow-lg' : ''}`}
      >
        {/* Priority glow for Nursery */}
        {isNurseryPriority && (
          <div className="absolute inset-0 bg-gradient-to-br from-amber-500/5 to-transparent pointer-events-none" />
        )}

        {/* Header: icon + name + mode badge */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">{room.icon}</span>
            <span className="text-sm font-medium text-slate-200 truncate">
              {room.name}
            </span>
          </div>
          <Badge variant="outline" className={`text-[10px] ${modeInfo.color} border`}>
            {modeInfo.label}
          </Badge>
        </div>

        {/* Temperature display */}
        <div className="flex items-baseline gap-1 mb-1">
          {room.temperature !== null ? (
            <>
              <span className="text-3xl font-light tabular-nums text-slate-50">
                {room.temperature.toFixed(1)}
              </span>
              <span className="text-sm text-slate-400">°C</span>
            </>
          ) : (
            <span className="text-2xl text-slate-600">--.-</span>
          )}
        </div>

        {/* Setpoint + connection */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">
            Target: {room.targetTemp.toFixed(1)}°C
          </span>
          {!room.connectionUp && (
            <span className="text-[10px] text-red-400 flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
              Offline
            </span>
          )}
          {room.connectionUp && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
          )}
        </div>

        {/* Safety range bar for Nursery */}
        {isNurseryPriority && room.temperature !== null && (
          <div className="mt-3 pt-2 border-t border-slate-800/50">
            <SafetyBar
              current={room.temperature}
              min={room.targetTemp - 0.2}
              max={room.targetTemp + 0.2}
            />
          </div>
        )}
      </Card>
    </Link>
  );
}

function SafetyBar({ current, min, max }: { current: number; min: number; max: number }) {
  // Range visualization: 16°C to 26°C bar
  const barMin = 16;
  const barMax = 26;
  const range = barMax - barMin;
  const currentPos = Math.max(0, Math.min(100, ((current - barMin) / range) * 100));
  const safeStart = ((min - barMin) / range) * 100;
  const safeEnd = ((max - barMin) / range) * 100;

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[9px] text-slate-600">
        <span>{barMin}°</span>
        <span className="text-emerald-600">{min}-{max}°C</span>
        <span>{barMax}°</span>
      </div>
      <div className="relative h-1.5 rounded-full bg-slate-800 overflow-hidden">
        {/* Safe zone */}
        <div
          className="absolute h-full bg-emerald-500/30 rounded-full"
          style={{ left: `${safeStart}%`, width: `${safeEnd - safeStart}%` }}
        />
        {/* Current position indicator */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full border-2 border-white bg-slate-950 shadow-sm transition-all duration-500"
          style={{ left: `calc(${currentPos}% - 5px)` }}
        />
      </div>
    </div>
  );
}
