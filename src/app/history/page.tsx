'use client';

import { useEffect, useState } from 'react';

interface AgentAction {
  room_id: string;
  created_at: string;
  action_type: string;
  old_value: string;
  new_value: string;
  reason: string;
}

const ROOM_NAMES: Record<string, string> = {
  leone: 'Camera Nursery',
  soggiorno: 'Soggiorno',
  camera: 'Camera da letto',
  studio: 'Studio Fabio',
  cucina: 'Cucina',
  bagno1: 'Bagno Vasca',
  bagno2: 'Bagno Doccia',
};

function formatAction(a: AgentAction): { title: string; detail: string; color: string; icon: string } {
  const room = ROOM_NAMES[a.room_id] || a.room_id;

  if (a.action_type === 'target_change') {
    return {
      title: `Target ${room} impostato a ${a.new_value}°C`,
      detail: a.reason?.includes('dashboard') ? 'Modificato manualmente dalla dashboard' : a.reason || '',
      color: 'amber',
      icon: '\u{1F3AF}',
    };
  }

  if (a.action_type === 'mode_change') {
    if (a.new_value === 'heat') {
      // Extract temp from reason like "temp=23.5°C <= onThreshold=23.8°C"
      const tempMatch = a.reason?.match(/temp=([0-9.]+)/);
      const threshMatch = a.reason?.match(/onThreshold=([0-9.]+)/);
      const temp = tempMatch?.[1] || '?';
      const thresh = threshMatch?.[1] || '?';
      return {
        title: `${room} acceso`,
        detail: `Temperatura scesa a ${temp}°C (soglia ${thresh}°C)`,
        color: 'orange',
        icon: '\u{1F525}',
      };
    } else {
      const tempMatch = a.reason?.match(/temp=([0-9.]+)/);
      const threshMatch = a.reason?.match(/offThreshold=([0-9.]+)/);
      const temp = tempMatch?.[1] || '?';
      const thresh = threshMatch?.[1] || '?';
      return {
        title: `${room} spento`,
        detail: `Temperatura salita a ${temp}°C (soglia ${thresh}°C)`,
        color: 'emerald',
        icon: '\u{2744}\u{FE0F}',
      };
    }
  }

  if (a.action_type === 'setpoint_change') {
    return {
      title: `Setpoint ${room}: ${a.old_value}°C \u2192 ${a.new_value}°C`,
      detail: a.reason || '',
      color: 'sky',
      icon: '\u{1F321}\u{FE0F}',
    };
  }

  if (a.action_type === 'fan_change') {
    const fanLabels: Record<string, string> = { '1': 'Min', '2': 'Med', '3': 'Max', '4': 'Auto' };
    return {
      title: `Ventola ${room}: ${fanLabels[a.new_value] || a.new_value}`,
      detail: a.reason || '',
      color: 'sky',
      icon: '\u{1F4A8}',
    };
  }

  return {
    title: `${a.action_type} - ${room}`,
    detail: a.reason || `${a.old_value} \u2192 ${a.new_value}`,
    color: 'slate',
    icon: '\u{2699}\u{FE0F}',
  };
}

const COLOR_MAP: Record<string, { bg: string; text: string; dot: string }> = {
  orange:  { bg: 'bg-orange-500/10 border-orange-500/20', text: 'text-orange-400', dot: 'bg-orange-400' },
  emerald: { bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-400', dot: 'bg-emerald-400' },
  amber:   { bg: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-400', dot: 'bg-amber-400' },
  sky:     { bg: 'bg-sky-500/10 border-sky-500/20', text: 'text-sky-400', dot: 'bg-sky-400' },
  slate:   { bg: 'bg-white/[0.04] border-white/[0.06]', text: 'text-slate-400', dot: 'bg-slate-400' },
};

export default function HistoryPage() {
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!supaUrl || !supaKey) { setLoading(false); return; }

      try {
        const res = await fetch(
          `${supaUrl}/rest/v1/agent_actions?order=created_at.desc&limit=100`,
          { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } },
        );
        const data = await res.json();
        setActions(Array.isArray(data) ? data : []);
      } catch { /* silent */ }
      setLoading(false);
    }
    load();
  }, []);

  // Group actions by date
  const grouped = actions.reduce<Record<string, AgentAction[]>>((acc, a) => {
    const d = new Date(a.created_at);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let label: string;
    if (d.toDateString() === today.toDateString()) {
      label = 'Oggi';
    } else if (d.toDateString() === yesterday.toDateString()) {
      label = 'Ieri';
    } else {
      label = d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    }
    (acc[label] ??= []).push(a);
    return acc;
  }, {});

  return (
    <main className="px-4 pt-safe max-w-lg mx-auto pb-4">
      <div className="pt-6 pb-4">
        <h1 className="text-[28px] font-bold tracking-tight bg-gradient-to-b from-white to-white/70 bg-clip-text text-transparent">
          Log
        </h1>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 rounded-2xl bg-white/[0.03] animate-pulse" />
          ))}
        </div>
      ) : actions.length === 0 ? (
        <p className="text-slate-500 text-sm text-center py-8">Nessuna azione registrata</p>
      ) : (
        <div className="space-y-5">
          {Object.entries(grouped).map(([date, items]) => (
            <div key={date}>
              <h2 className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider mb-2 px-1">{date}</h2>
              <div className="space-y-1.5">
                {items.map((a, i) => {
                  const { title, detail, color, icon } = formatAction(a);
                  const cm = COLOR_MAP[color] || COLOR_MAP.slate;
                  const time = new Date(a.created_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
                  return (
                    <div key={i} className={`rounded-2xl border backdrop-blur-xl px-4 py-3 ${cm.bg}`}>
                      <div className="flex items-start gap-3">
                        <span className="text-base mt-0.5 flex-shrink-0">{icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className={`text-[13px] font-semibold ${cm.text}`}>{title}</span>
                            <span className="text-[11px] text-slate-500 tabular-nums flex-shrink-0">{time}</span>
                          </div>
                          {detail && (
                            <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{detail}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
