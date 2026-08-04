export const TEAM_COLOR_PRESETS = [
  { id: 'red', label: 'Red', swatch: 'bg-red-500', bg: 'bg-red-500', border: 'border-red-400', text: 'text-white', sub: 'text-white/50', overlay: 'bg-black/25' },
  { id: 'blue', label: 'Blue', swatch: 'bg-blue-500', bg: 'bg-blue-500', border: 'border-blue-400', text: 'text-white', sub: 'text-white/50', overlay: 'bg-black/25' },
  { id: 'green', label: 'Green', swatch: 'bg-emerald-500', bg: 'bg-emerald-500', border: 'border-emerald-400', text: 'text-white', sub: 'text-white/50', overlay: 'bg-black/25' },
  { id: 'yellow', label: 'Yellow', swatch: 'bg-yellow-400', bg: 'bg-yellow-400', border: 'border-yellow-300', text: 'text-black', sub: 'text-black/50', overlay: 'bg-white/35' },
  { id: 'orange', label: 'Orange', swatch: 'bg-orange-500', bg: 'bg-orange-500', border: 'border-orange-400', text: 'text-white', sub: 'text-white/50', overlay: 'bg-black/25' },
  { id: 'purple', label: 'Purple', swatch: 'bg-purple-500', bg: 'bg-purple-500', border: 'border-purple-400', text: 'text-white', sub: 'text-white/50', overlay: 'bg-black/25' },
  { id: 'pink', label: 'Pink', swatch: 'bg-pink-500', bg: 'bg-pink-500', border: 'border-pink-400', text: 'text-white', sub: 'text-white/50', overlay: 'bg-black/25' },
  { id: 'sky', label: 'Sky', swatch: 'bg-sky-400', bg: 'bg-sky-400', border: 'border-sky-300', text: 'text-black', sub: 'text-black/50', overlay: 'bg-white/35' },
  { id: 'white', label: 'White', swatch: 'bg-white', bg: 'bg-white', border: 'border-zinc-300', text: 'text-black', sub: 'text-black/50', overlay: 'bg-white/35' },
  { id: 'black', label: 'Black', swatch: 'bg-zinc-800', bg: 'bg-zinc-800', border: 'border-zinc-600', text: 'text-white', sub: 'text-white/50', overlay: 'bg-black/25' },
  { id: 'brown', label: 'Brown', swatch: 'bg-amber-800', bg: 'bg-amber-800', border: 'border-amber-700', text: 'text-white', sub: 'text-white/50', overlay: 'bg-black/25' },
  { id: 'grey', label: 'Grey', swatch: 'bg-gray-500', bg: 'bg-gray-500', border: 'border-gray-400', text: 'text-white', sub: 'text-white/50', overlay: 'bg-black/25' },
  { id: 'navy', label: 'Navy Blue', swatch: 'bg-blue-900', bg: 'bg-blue-900', border: 'border-blue-800', text: 'text-white', sub: 'text-white/50', overlay: 'bg-black/25' },
  { id: 'darkgreen', label: 'Dark Green', swatch: 'bg-green-800', bg: 'bg-green-800', border: 'border-green-700', text: 'text-white', sub: 'text-white/50', overlay: 'bg-black/25' },
];

const DEFAULT_TEAM_COLOR = { bg: 'bg-zinc-900', border: 'border-white/10', text: 'text-white', sub: 'text-white/20', overlay: 'bg-white/10' };

export function teamColorClasses(colorId) {
  const preset = TEAM_COLOR_PRESETS.find((c) => c.id === colorId);
  if (!preset) return DEFAULT_TEAM_COLOR;
  return { bg: preset.bg, border: preset.border, text: preset.text, sub: preset.sub, overlay: preset.overlay };
}

export function displayTeamName(name, which) {
  return name && name.trim() ? name : (which === 'A' ? 'Team A' : 'Team B');
}
