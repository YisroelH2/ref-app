import { useState } from 'react';
import Icon from './Icon.jsx';
import Sheet from './Sheet.jsx';

const CONSULT_PRESETS = [
  { type: 'inout', prompt: 'In / Out?', options: ['IN', 'OUT', 'IDK'] },
  { type: 'foul', prompt: 'Foul?', options: ['FOUL', 'NO FOUL', 'IDK'] },
  { type: 'custom', prompt: 'Quick Check', options: ['YES', 'NO'] },
];

// Compact "Ref Consult" trigger for the main game bar — only ever rendered
// while in an active, connected room (the caller gates that), so it's
// fully absent rather than disabled when Multi-Ref Sync isn't live.
export default function ConsultButton({ consult, sendConsult, sending }) {
  const [open, setOpen] = useState(false);
  const blocked = sending || (consult && consult.status === 'pending');

  const send = (preset) => {
    sendConsult(preset.type, preset.prompt, preset.options);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ref Consult"
        className="btn-press flex items-center justify-center gap-1.5 rounded-full bg-white/10 border border-white/10 px-3.5 py-2 text-xs font-bold text-white/60"
      >
        <Icon name="MessageCircle" size={15} />
        Consult
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Ref Consult">
        <p className="text-white/40 text-xs mb-4 leading-relaxed">
          Sends a quick one-tap question to every other connected ref in this room.
        </p>
        <div className="flex flex-col gap-2.5">
          {CONSULT_PRESETS.map((preset) => (
            <button
              key={preset.type}
              type="button"
              onClick={() => send(preset)}
              disabled={blocked}
              className="btn-press w-full rounded-2xl bg-white/10 py-4 font-extrabold text-base disabled:opacity-30"
            >
              {preset.prompt}
            </button>
          ))}
        </div>
        {blocked && (
          <p className="text-yellow-400/80 text-xs mt-3 font-semibold text-center">
            Waiting on the current question to be answered…
          </p>
        )}
      </Sheet>
    </>
  );
}
