import { useState } from 'react';
import Icon from './Icon.jsx';
import Sheet from './Sheet.jsx';

// Fallback preset set for any sport without a dedicated list below.
const DEFAULT_PRESETS = [
  { type: 'inout', prompt: 'In / Out?', options: ['IN', 'OUT', 'IDK'] },
  { type: 'foul', prompt: 'Foul?', options: ['FOUL', 'NO FOUL', 'IDK'] },
  { type: 'custom', prompt: 'Quick Check', options: ['YES', 'NO'] },
];

// Presets tailored to the calls each sport actually needs. Entries flagged
// `dynamicTeams` get their options filled in at render time from the live
// team names (see `presets` below) instead of a fixed options list.
const SPORT_PRESETS = {
  volleyball: [
    { type: 'inout', prompt: 'In / Out?', options: ['IN', 'OUT', 'IDK'] },
    { type: 'carry', prompt: 'Carry?', options: ['YES', 'NO'] },
    { type: 'serve', prompt: "Who's Serve?", dynamicTeams: true },
  ],
  basketball: [
    { type: 'foul', prompt: 'Foul?', options: ['FOUL', 'NO FOUL', 'IDK'] },
    { type: 'travel', prompt: 'Travel?', options: ['YES', 'NO', 'IDK'] },
    { type: 'value', prompt: '2 or 3?', options: ['2', '3'] },
  ],
  football: [
    { type: 'down', prompt: 'Down?', options: ['1', '2', '3', '4'] },
    { type: 'pi', prompt: 'PI?', options: ['YES', 'NO'] },
    { type: 'offsides', prompt: 'Offsides — Which Team?', dynamicTeams: true },
    { type: 'targeting', prompt: 'Targeting?', options: ['YES', 'NO'] },
    { type: 'catch', prompt: 'Catch — In / Out?', options: ['IN', 'OUT'] },
  ],
  soccer: [
    { type: 'handball', prompt: 'Handball?', options: ['YES', 'NO', 'IDK'] },
    { type: 'foul', prompt: 'Foul?', options: ['YES', 'NO', 'IDK'] },
    { type: 'goal', prompt: 'Goal?', options: ['YES', 'NO', 'IDK'] },
  ],
  hockey: [
    { type: 'highstick', prompt: 'High Stick?', options: ['YES', 'NO', 'IDK'] },
    { type: 'goal', prompt: 'Goal?', options: ['YES', 'NO', 'IDK'] },
  ],
  baseball: [
    { type: 'safeout', prompt: 'Safe / Out?', options: ['SAFE', 'OUT', 'IDK'] },
    { type: 'fairfoul', prompt: 'Fair / Foul?', options: ['FAIR', 'FOUL', 'IDK'] },
    { type: 'doublehomer', prompt: 'Double or Homer?', options: ['DOUBLE', 'HOMER'] },
    { type: 'checkswing', prompt: 'Check Swing?', options: ['STRIKE', 'NO SWING'] },
    { type: 'outs', prompt: 'Outs?', options: ['1', '2'] },
  ],
};

// Compact "Ref Consult" trigger for the main game bar — only ever rendered
// while in an active, connected room (the caller gates that), so it's
// fully absent rather than disabled when Multi-Ref Sync isn't live.
export default function ConsultButton({ consult, sendConsult, sending, sport, teamAName, teamBName }) {
  const [open, setOpen] = useState(false);
  const blocked = sending || (consult && consult.status === 'pending');
  const presets = (SPORT_PRESETS[sport] || DEFAULT_PRESETS).map((preset) =>
    preset.dynamicTeams
      ? { ...preset, options: [teamAName || 'Team A', teamBName || 'Team B'] }
      : preset
  );

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
          {presets.map((preset) => (
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
