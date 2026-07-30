import {
  ArrowLeft, ArrowLeftRight, Check, ChevronLeft, ChevronRight, CircleDot,
  Clock, Copy, Flag, Lock, Minus, Pause, Play, Plus, Repeat, RotateCcw, RotateCw,
  Send, Settings, Volume2, X,
} from 'lucide-react';

// Only the icons this app actually uses are imported by name above, so the
// bundle doesn't pull in the entire lucide-react icon set (~1000 components).
const ICONS = {
  ArrowLeft, ArrowLeftRight, Check, ChevronLeft, ChevronRight, CircleDot,
  Clock, Copy, Flag, Lock, Minus, Pause, Play, Plus, Repeat, RotateCcw, RotateCw,
  Send, Settings, Volume2, X,
};

// Fallback glyphs in case a name above is ever a typo or gets removed.
const ICON_FALLBACK = {
  Pause: '⏸', Play: '▶', Settings: '⚙', Plus: '+', Minus: '−', RotateCcw: '↺',
  X: '✕', Check: '✓', ChevronLeft: '‹', ChevronRight: '›', Clock: '🕐',
  Flag: '⚑', ArrowLeftRight: '⇄', Volume2: '🔔', RotateCw: '↻', CircleDot: '●',
  Copy: '📋', Send: '➤', Lock: '🔒', ArrowLeft: '←', Repeat: '⟳',
};

export default function Icon({ name, size = 24, className = '', strokeWidth = 2.5 }) {
  const LucideIcon = ICONS[name];
  return (
    <span className={`inline-flex items-center justify-center shrink-0 ${className}`} style={{ width: size, height: size }}>
      {LucideIcon ? (
        <LucideIcon width={size} height={size} stroke="currentColor" strokeWidth={strokeWidth} style={{ display: 'block' }} />
      ) : (
        <span style={{ fontSize: Math.round(size * 0.8), lineHeight: 1 }}>{ICON_FALLBACK[name] || ''}</span>
      )}
    </span>
  );
}
