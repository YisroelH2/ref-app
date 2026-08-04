import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { vibrate } from '../lib/haptics.js';
import { teamColorClasses } from '../lib/teamColors.js';

// How long a question has to sit unanswered before the sender can nudge —
// long enough that it's clearly not just "still typing a response," short
// enough to matter mid-game.
const NUDGE_DELAY_MS = 6000;

// Renders whichever face of the shared rooms/{roomCode}/consult record is
// relevant to *this* device: the incoming question + response buttons for
// every other connected ref, or a small answered-toast for the sender (and
// a lighter confirmation for whoever responded). Auto-clearing the record
// itself (so all screens dismiss together ~3s after an answer) is handled
// by useConsult, not here — this only decides what to show for the record
// that currently exists.
export default function ConsultOverlay({ consult, respond, nudge, clientId }) {
  const vibratedKeyRef = useRef(null);
  // Local-only: lets the receiving ref set aside a question they're not
  // ready to answer (e.g. mid-tap on something else) without blocking their
  // whole screen. Purely client-side — the sender keeps waiting either way,
  // and this never writes to the shared record, so it can't affect other
  // devices or count as an answer.
  const [dismissedId, setDismissedId] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!consult) { vibratedKeyRef.current = null; return; }
    // Keyed on nudgedAt too — a nudge re-fires this same effect so the
    // receiver feels a second buzz and, if they'd set the question aside,
    // gets the full prompt back in front of them.
    const key = `${consult.id}:${consult.status}:${consult.nudgedAt || 0}`;
    if (vibratedKeyRef.current === key) return;
    vibratedKeyRef.current = key;
    if (consult.status === 'pending' && consult.senderId !== clientId) {
      vibrate([80, 60, 80, 60, 120]);
      setDismissedId((d) => (d === consult.id ? null : d));
    } else if (consult.status === 'answered') {
      vibrate(consult.senderId === clientId ? [60, 50, 120] : 40);
    }
  }, [consult, clientId]);

  // Only ticks while there's actually a pending question of this device's
  // own to time — not a permanent interval running for the life of the app.
  useEffect(() => {
    if (!consult || consult.status !== 'pending' || consult.senderId !== clientId) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [consult, clientId]);

  if (!consult) return null;

  const isSender = consult.senderId === clientId;
  const isResponder = consult.responderId === clientId;

  if (consult.status === 'pending') {
    if (isSender) {
      const since = consult.nudgedAt || consult.createdAt || now;
      const canNudge = typeof since === 'number' && now - since >= NUDGE_DELAY_MS;
      return (
        <div className="fixed inset-x-0 top-4 z-[60] flex justify-center pointer-events-none px-4">
          <div className="pop-in pointer-events-auto rounded-2xl bg-white/10 border border-white/15 backdrop-blur px-5 py-2.5 text-xs font-bold text-white/70 flex items-center gap-3">
            <span className="flex items-center gap-2">
              <Icon name="MessageCircle" size={14} />
              Waiting for a response to "{consult.prompt}"…
            </span>
            {canNudge && (
              <button
                type="button"
                onClick={nudge}
                className="btn-press shrink-0 rounded-full bg-yellow-400 text-black px-3 py-1.5 text-[11px] font-extrabold"
              >
                Nudge
              </button>
            )}
          </div>
        </div>
      );
    }
    if (dismissedId === consult.id) {
      return (
        <div className="fixed inset-x-0 top-4 z-[60] flex justify-center px-4">
          <button
            type="button"
            onClick={() => setDismissedId(null)}
            className="pop-in btn-press rounded-2xl bg-yellow-400 text-black border border-yellow-300 px-5 py-2.5 text-xs font-extrabold flex items-center gap-2 shadow-lg"
          >
            <Icon name="MessageCircle" size={14} />
            Ref Consult waiting: "{consult.prompt}" · tap to answer
          </button>
        </div>
      );
    }
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-6">
        <div className="pop-in w-full max-w-xs rounded-3xl bg-zinc-900 border border-white/15 shadow-2xl p-6 text-center relative">
          <button
            type="button"
            onClick={() => setDismissedId(consult.id)}
            aria-label="Answer later"
            className="btn-press absolute top-3 right-3 w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white/50"
          >
            <Icon name="X" size={14} />
          </button>
          <div className="text-xs font-extrabold tracking-widest text-white/40 mb-2 flex items-center justify-center gap-1.5">
            <Icon name="MessageCircle" size={14} /> REF CONSULT
          </div>
          <div className="text-2xl font-black mb-5">{consult.prompt}</div>
          <div className="flex flex-col gap-2.5">
            {(consult.options || []).map((opt) => {
              const label = typeof opt === 'string' ? opt : opt.label;
              const color = typeof opt === 'string' ? null : opt.color;
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => respond(label)}
                  className="btn-press w-full rounded-2xl bg-white/10 py-4 font-extrabold text-lg active:bg-white/20 flex items-center justify-center gap-2.5"
                >
                  {color && <span className={`w-4 h-4 rounded-full shrink-0 ${teamColorClasses(color).bg} border border-white/20`} />}
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // status === 'answered'
  const message = isSender
    ? `Partner called: ${consult.answer}`
    : isResponder
      ? `You answered: ${consult.answer}`
      : `Answered: ${consult.answer}`;

  return (
    <div className="fixed inset-x-0 top-4 z-[60] flex justify-center pointer-events-none px-4">
      <div className={`pop-in rounded-2xl border backdrop-blur px-5 py-3 text-sm font-extrabold flex items-center gap-2 ${
        isSender ? 'bg-emerald-400 text-black border-emerald-400' : 'bg-white/10 text-white border-white/15'
      }`}>
        <Icon name="Check" size={16} />
        {message}
      </div>
    </div>
  );
}
