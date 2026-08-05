import { useState, useEffect, useRef, useCallback, forwardRef, Component } from 'react';
import Icon from './components/Icon.jsx';
import IconButton from './components/IconButton.jsx';
import Sheet from './components/Sheet.jsx';
import { useLocalStorage } from './lib/useLocalStorage.js';
import { useRoomSession } from './lib/roomSession.js';
import { useRoomSync } from './lib/useRoomSync.js';
import { useRoomPermissions } from './lib/roomPermissions.js';
import { useConsult } from './lib/consult.js';
import { vibrate } from './lib/haptics.js';
import { TEAM_COLOR_PRESETS, teamColorClasses, displayTeamName } from './lib/teamColors.js';
import ConsultButton from './components/ConsultButton.jsx';
import ConsultOverlay from './components/ConsultOverlay.jsx';
import { isFirebaseConfigured } from './firebaseConfig.js';
import QRCode from 'qrcode';

const APP_VERSION = '4.3.1';



/* ============================== HELPERS ============================== */

function pad2(n) { return String(Math.floor(Math.abs(n))).padStart(2, '0'); }

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(sec)}`;
  return `${pad2(m)}:${pad2(sec)}`;
}

function nextOccurrence(hh, mm) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function resolveClosestHour24(hour12, minute) {
  const h = ((hour12 % 12) + 12) % 12;
  const amTs = nextOccurrence(h, minute);
  const pmTs = nextOccurrence(h + 12, minute);
  return amTs <= pmTs ? h : h + 12;
}

/* ============================== CAMP SCHEDULE ============================== */

// The stock YKP activity blocks — used to seed a fresh device's schedule and
// as the "Reset to YKP Defaults" target in the schedule editor. Actual live
// behavior always reads from settings.schedule (see getDaySlots below), so
// editing this only changes what new devices start with.
const DEFAULT_SCHEDULE_SLOTS = [
  { key: '1st', pill: '1st Activity', label: 'First Activity', startHour: 15, startMinute: 0, endHour: 16, endMinute: 0 },
  { key: '2nd', pill: '2nd Activity', label: 'Second Activity', startHour: 16, startMinute: 10, endHour: 17, endMinute: 10 },
  { key: '3rd', pill: '3rd Activity', label: 'Third Activity', startHour: 17, startMinute: 20, endHour: 18, endMinute: 20 },
  { key: '4th', pill: '4th Activity', label: 'Fourth Activity', startHour: 19, startMinute: 30, endHour: 20, endMinute: 20 },
];

// Friday runs a shorter, earlier slate (early Shabbos prep) — only three
// activities, each 50 minutes with the same 10-minute buffer between them
// as the weekday default, so the wrap-up grace window in detectCurrentActivity
// never bleeds an End Game message into the next slot.
const DEFAULT_FRIDAY_SLOTS = [
  { key: 'fri_1st', pill: '1st Activity', label: 'First Activity', startHour: 14, startMinute: 30, endHour: 15, endMinute: 20 },
  { key: 'fri_2nd', pill: '2nd Activity', label: 'Second Activity', startHour: 15, startMinute: 30, endHour: 16, endMinute: 20 },
  { key: 'fri_3rd', pill: '3rd Activity', label: 'Third Activity', startHour: 16, startMinute: 30, endHour: 17, endMinute: 20 },
];

function defaultSchedule() {
  return {
    default: DEFAULT_SCHEDULE_SLOTS.map((s) => ({ ...s })),
    overrides: { fri: DEFAULT_FRIDAY_SLOTS.map((s) => ({ ...s })) },
  };
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };

// Resolves which list of activity slots is in effect for a given date: a
// day-of-week override (e.g. Friday running on a different clock) if one is
// set, otherwise the schedule's default. This is the single place that knows
// how to read a `settings.schedule` object — everything else (auto-detect,
// the Game Clock presets, the End Game period picker) goes through it so a
// device's own schedule is what actually drives the app, not a hardcoded one.
function getDaySlots(schedule, date) {
  const sched = schedule || defaultSchedule();
  const dayKey = DAY_KEYS[(date || new Date()).getDay()];
  const override = sched.overrides && sched.overrides[dayKey];
  if (override && override.length) return override;
  return sched.default || [];
}

function todayAt(hh, mm) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0).getTime();
}

// How long past an activity's scheduled end time we keep reporting it as the
// "current" activity, so wrapping up and sending the result doesn't get
// misattributed to whatever comes next. Capped at each next activity's actual
// start time, so it never bleeds into a slot that's genuinely underway.
const ACTIVITY_WRAPUP_GRACE_MINS = 20;

function detectCurrentActivity(now) {
  const nowDate = now || new Date();
  const nowMs = nowDate.getTime();
  const slots = getDaySlots(getAppSettings().schedule, nowDate);
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const next = slots[i + 1];
    const end = todayAt(slot.endHour, slot.endMinute);
    const nextStart = next ? todayAt(next.startHour, next.startMinute) : Infinity;
    const wrapUpEnd = Math.min(end + ACTIVITY_WRAPUP_GRACE_MINS * 60000, nextStart);
    if (nowMs < wrapUpEnd) return slot;
  }
  return slots[slots.length - 1] || null;
}

// Unlike detectCurrentActivity(), this has no wrap-up grace period — it's for
// picking which activity a *new* game clock should default to, where we want
// to move on to the next slot the instant one ends rather than lingering on
// the one that just finished (that lingering is deliberate over in
// detectCurrentActivity, for the End Game message, but wrong here — it was
// making a freshly opened "Set Game Clock" suggest the activity that had
// already ended instead of the one about to start).
function detectUpcomingActivity(now) {
  const nowDate = now || new Date();
  const nowMs = nowDate.getTime();
  const slots = getDaySlots(getAppSettings().schedule, nowDate);
  for (const slot of slots) {
    if (nowMs < todayAt(slot.endHour, slot.endMinute)) return slot;
  }
  return null;
}

function formatHM(hh, mm) {
  return new Date(2000, 0, 1, hh, mm).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function pluralizePeriodUnit(unit, count) {
  if (count === 1) return unit;
  if (unit.toLowerCase() === 'half') return 'Halves';
  return `${unit}s`;
}

/* ============================== APP SETTINGS ============================== */

const APP_SETTINGS_KEY = 'refcourt_app_settings_v1';

function defaultAppSettings() {
  return {
    theme: 'dark',
    footballTimeouts: 3,
    volleyballRegularTarget: 16,
    volleyballDecidingTarget: 11,
    whatsappPhone: '',
    volleyballTapToScore: false,
    basketballFoulsEnabled: false,
    selectedCamp: '',
    hockeyDefaultFormat: 'periods',
    basketballDefaultFormat: 'halves',
    schedule: defaultSchedule(),
  };
}

function getAppSettings() {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_KEY);
    return raw ? { ...defaultAppSettings(), ...JSON.parse(raw) } : defaultAppSettings();
  } catch (e) {
    return defaultAppSettings();
  }
}

function useAppSettings() {
  const [settings, setSettings] = useLocalStorage(APP_SETTINGS_KEY, defaultAppSettings());

  useEffect(() => {
    document.documentElement.classList.toggle('light-mode', settings.theme === 'light');
    document.documentElement.classList.toggle('outdoor-mode', settings.theme === 'outdoor');
  }, [settings.theme]);

  return [settings, setSettings];
}

/* ============================== PRIMITIVES ============================== */

function BigButton({ children, onClick, className = '', disabled = false }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`btn-press select-none outline-none disabled:opacity-30 disabled:pointer-events-none ${className}`}
    >
      {children}
    </button>
  );
}



function EndGamePill({ onClick }) {
  return (
    <div className="flex justify-center mb-4 landscape:mb-1">
      <button
        onClick={onClick}
        aria-label="End Game"
        className="btn-press flex items-center gap-2 rounded-full bg-orange-500/90 text-white px-7 landscape:px-5 py-3.5 landscape:py-1.5 text-sm font-extrabold tracking-widest active:bg-orange-600 shadow-lg shadow-orange-500/20 min-h-[52px] landscape:min-h-0"
      >
        <Icon name="Flag" size={18} /> END GAME
      </button>
    </div>
  );
}



function Field({ label, children }) {
  return (
    <div className="mb-5">
      <div className="text-xs font-bold uppercase tracking-wider text-white/40 mb-2">{label}</div>
      {children}
    </div>
  );
}

const TextInput = forwardRef((props, ref) => {
  return (
    <input
      {...props}
      ref={ref}
      className={`w-full rounded-xl bg-white/10 border border-white/10 px-4 py-3 text-lg font-semibold text-white placeholder-white/30 outline-none focus:border-emerald-400/60 ${props.className || ''}`}
    />
  );
});

function Stepper({ value, onChange, min = 0, max = 20 }) {
  return (
    <div className="flex items-center gap-3">
      <IconButton name="Minus" size={18} onClick={() => onChange(Math.max(min, value - 1))} />
      <div className="w-14 text-center text-2xl font-extrabold tabular">{value}</div>
      <IconButton name="Plus" size={18} onClick={() => onChange(Math.min(max, value + 1))} />
    </div>
  );
}

function Segmented({ options, value, onChange }) {
  return (
    <div className="flex rounded-xl bg-white/10 p-1 gap-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`btn-press flex-1 py-2.5 rounded-lg text-sm font-bold ${value === opt.value ? 'bg-white text-black' : 'text-white/60'}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ============================== TEAM COLORS ============================== */

function ColorPicker({ value, onChange }) {
  return (
    <div className="flex flex-wrap gap-3">
      {TEAM_COLOR_PRESETS.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onChange(value === c.id ? null : c.id)}
          aria-label={c.label}
          className={`btn-press w-11 h-11 rounded-full ${c.swatch} border-2 ${value === c.id ? 'border-white ring-2 ring-white/50' : 'border-white/20'}`}
        />
      ))}
    </div>
  );
}

/* ============================== CAMP TEAM ROSTER ============================== */

const CAMP_ROSTERS = {
  ykp8: {
    label: 'YKP 8th Grade',
    teams: [
      { city: 'Klimavitch', counselor: 'Edelkopf', color: 'black' },
      { city: 'Nevel', counselor: 'Wonder', color: 'red' },
      { city: 'Kremenchuk', counselor: 'Fischer', color: 'blue' },
      { city: 'Dnipropetrovsk', counselor: 'Margo', color: 'darkgreen' },
      { city: 'Yekatrinaslav', counselor: 'Wineburg', color: 'yellow' },
      { city: 'Rostov', counselor: 'Naparstak', color: 'brown' },
      { city: 'Otvotsk', counselor: 'Raskin', color: 'orange' },
      { city: 'Nezhin', counselor: 'Sason', color: 'purple' },
      { city: 'Nikolayev', counselor: 'Baumgarten', color: 'grey' },
      { city: 'Poltava', counselor: 'Drizin', color: 'navy' },
    ],
  },
};

function getCampTeams() {
  const roster = CAMP_ROSTERS[getAppSettings().selectedCamp];
  if (!roster) return [];
  return roster.teams.map((t) => ({ ...t, label: `${t.city} - ${t.counselor}` }));
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = [];
  for (let i = 0; i <= m; i++) dp.push([i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function fuzzyDistance(query, text) {
  query = query.toLowerCase();
  text = text.toLowerCase();
  if (!query) return 0;
  if (text.includes(query)) return 0;
  const qLen = query.length;
  let best = Infinity;
  for (let i = 0; i < text.length; i++) {
    for (let len = Math.max(1, qLen - 2); len <= qLen + 2; len++) {
      if (i + len > text.length) continue;
      const d = levenshtein(query, text.slice(i, i + len));
      if (d < best) best = d;
    }
  }
  return best;
}

function searchCampTeams(query) {
  const campTeams = getCampTeams();
  const q = query.trim();
  if (!q) return campTeams;
  const threshold = Math.max(2, Math.ceil(q.length * 0.5));
  return campTeams
    .map((t) => {
      const colorLabel = (TEAM_COLOR_PRESETS.find((c) => c.id === t.color) || {}).label || t.color;
      return {
        team: t,
        score: Math.min(
          fuzzyDistance(q, t.city),
          fuzzyDistance(q, t.counselor),
          fuzzyDistance(q, t.label),
          fuzzyDistance(q, colorLabel)
        ),
      };
    })
    .filter((s) => s.score <= threshold)
    .sort((a, b) => a.score - b.score)
    .map((s) => s.team);
}

function TeamPicker({ label, teamName, teamColor, onSelect, onCustomName, onCustomColor }) {
  const [query, setQuery] = useState(teamName || '');
  const [open, setOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { setQuery(teamName || ''); }, [teamName]);

  const results = open ? searchCampTeams(query) : [];

  const commit = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const exact = getCampTeams().find((t) => t.label.toLowerCase() === trimmed.toLowerCase());
    if (exact) {
      onSelect(exact);
      setQuery(exact.label);
    } else {
      onCustomName(trimmed);
    }
    setOpen(false);
  };

  const clearQuery = () => {
    setQuery('');
    setOpen(true);
    if (inputRef.current) inputRef.current.focus();
  };

  return (
    <Field label={label}>
      <div className="relative">
        <TextInput
          ref={inputRef}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); e.target.blur(); } }}
          onBlur={commit}
          maxLength={20}
          placeholder="Team name..."
          className={query ? 'pr-11' : ''}
        />
        {query && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={clearQuery}
            aria-label="Clear search"
            className="btn-press absolute right-2.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white/15 active:bg-white/25 flex items-center justify-center text-white/60"
          >
            <Icon name="X" size={14} />
          </button>
        )}
      </div>
      {open && results.length > 0 && (
        <div className="mt-2 rounded-xl bg-white/5 border border-white/10 overflow-hidden max-h-64 overflow-y-auto">
          {results.map((t) => (
            <button
              key={t.label}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onSelect(t); setQuery(t.label); setOpen(false); }}
              className="w-full flex items-center gap-3 px-4 py-3 text-left border-b border-white/5 last:border-0 active:bg-white/10"
            >
              <span className={`w-5 h-5 rounded-full shrink-0 ${teamColorClasses(t.color).bg} border border-white/20`} />
              <span className="font-semibold">{t.label}</span>
            </button>
          ))}
        </div>
      )}
      <p className="text-white/30 text-xs mt-2 leading-relaxed">
        These are just suggestions — type any name and hit enter.
      </p>
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setColorOpen((o) => !o)}
          className="btn-press w-full flex items-center gap-2 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5"
        >
          <span className={`w-5 h-5 rounded-full shrink-0 ${teamColorClasses(teamColor).bg} border border-white/20`} />
          <span className="text-sm font-bold text-white/70">Change Color</span>
          <Icon
            name="ChevronRight"
            size={14}
            className={`text-white/30 ml-auto transition-transform ${colorOpen ? 'rotate-90' : ''}`}
          />
        </button>
        {colorOpen && (
          <div className="mt-3">
            <ColorPicker value={teamColor} onChange={onCustomColor} />
          </div>
        )}
      </div>
    </Field>
  );
}

/* ============================== GLOBAL TIMER ============================== */

const TIMER_KEY = 'refcourt_timer_v1';

function defaultTimer() {
  return {
    configured: false,
    mode: 'auto',
    endLabel: '',
    halfMs: 0,
    currentHalf: 1,
    totalHalves: 2,
    periodEndTs: 0,
    isRunning: false,
    pausedRemainingMs: 0,
    finished: false,
    halftimeMins: 5,
    bufferMins: 2,
    activityLabel: '',
    targetEndTs: 0,
  };
}

function useGlobalTimer(roomCode) {
  const [timer, setTimer] = useLocalStorage(TIMER_KEY, defaultTimer());
  // Merge onto defaultTimer() rather than adopting the remote value verbatim
  // — a peer on a different app version (e.g. a stale service-worker cache)
  // could sync a shape missing fields this build expects, and a raw
  // undefined would crash rendering. Merging guarantees every expected key
  // is always present. useCallback keeps this setter's identity stable so
  // useRoomSync's effect (which depends on it) doesn't re-subscribe every render.
  const setTimerSynced = useCallback((v) => setTimer((s) => ({ ...defaultTimer(), ...v })), [setTimer]);
  useRoomSync(roomCode, 'timer', timer, setTimerSynced);
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);

  let remainingMs = 0;
  if (timer.configured && !timer.finished) {
    remainingMs = timer.isRunning ? Math.max(0, timer.periodEndTs - Date.now()) : timer.pausedRemainingMs;
  }

  useEffect(() => {
    if (!timer.configured || !timer.isRunning || timer.finished) return;
    if (remainingMs <= 0) {
      // Use unclamped overshoot (not the clamped remainingMs) so a backgrounded/throttled
      // tab that wakes up long after this half should have ended doesn't get handed a
      // brand-new full-length next half — it looks like the clock silently "reset."
      const overshoot = Math.max(0, Date.now() - timer.periodEndTs);
      if (timer.currentHalf < timer.totalHalves && overshoot < timer.halfMs) {
        vibrate([180, 100, 180]);
        setTimer((t) => {
          const remaining = Math.max(0, t.halfMs - overshoot);
          return {
            ...t,
            currentHalf: t.currentHalf + 1,
            // Always stop at the half boundary — never auto-run into the next half.
            // The ref has to tap to resume, same as a manual pause.
            isRunning: false,
            periodEndTs: Date.now() + remaining,
            pausedRemainingMs: remaining,
          };
        });
      } else {
        vibrate([250, 120, 250, 120, 250]);
        setTimer((t) => ({ ...t, finished: true, isRunning: false, pausedRemainingMs: 0 }));
      }
    }
  }, [remainingMs, timer.configured, timer.isRunning, timer.finished, timer.currentHalf, timer.totalHalves, setTimer]);

  const warnBucketRef = useRef(null);
  useEffect(() => {
    if (!timer.configured || !timer.isRunning || timer.finished) {
      warnBucketRef.current = null;
      return;
    }
    const secs = Math.ceil(remainingMs / 1000);
    if (secs > 0 && secs <= 30 && secs % 5 === 0) {
      if (warnBucketRef.current !== secs) {
        warnBucketRef.current = secs;
        vibrate([90, 50, 90]);
      }
    } else if (secs > 30) {
      warnBucketRef.current = null;
    }
  }, [remainingMs, timer.configured, timer.isRunning, timer.finished]);

  const applyAutoSetup = useCallback((endTs, halftimeMins, bufferMins, activityLabel, skipHalftime, totalPeriods) => {
    const now = Date.now();
    const totalMs = Math.max(60000, endTs - now);
    const ht = skipHalftime ? 0 : Math.max(0, halftimeMins || 0);
    const buf = Math.max(0, bufferMins || 0);
    const deductionMs = (ht + buf) * 60000;
    const playableMs = Math.max(60000, totalMs - deductionMs);
    const totalHalves = skipHalftime ? 1 : Math.max(1, totalPeriods || 2);
    const half = playableMs / totalHalves;
    const label = 'Ends ' + new Date(endTs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    setTimer({
      configured: true,
      mode: 'auto',
      endLabel: label,
      halfMs: half,
      currentHalf: 1,
      totalHalves,
      periodEndTs: now + half,
      isRunning: true,
      pausedRemainingMs: half,
      finished: false,
      halftimeMins: ht,
      bufferMins: buf,
      activityLabel: activityLabel || '',
      targetEndTs: endTs,
    });
  }, [setTimer]);

  const setupAuto = useCallback((hh, mm, halftimeMins, bufferMins, activityLabel, skipHalftime, totalPeriods) => {
    applyAutoSetup(nextOccurrence(hh, mm), halftimeMins, bufferMins, activityLabel, skipHalftime, totalPeriods);
  }, [applyAutoSetup]);

  const setupAutoAt = useCallback((endTs, halftimeMins, bufferMins, activityLabel, skipHalftime, totalPeriods) => {
    applyAutoSetup(endTs, halftimeMins, bufferMins, activityLabel, skipHalftime, totalPeriods);
  }, [applyAutoSetup]);

  const setActivityLabel = useCallback((label) => {
    setTimer((t) => ({ ...t, activityLabel: label }));
  }, [setTimer]);

  // Updates halftime/buffer minutes on an already-configured auto timer without
  // touching currentHalf, periodEndTs, or isRunning — a plain settings edit,
  // not a restart.
  const updateAutoSettings = useCallback((halftimeMins, bufferMins) => {
    setTimer((t) => {
      if (!t.configured || t.mode !== 'auto') return t;
      return { ...t, halftimeMins: Math.max(0, halftimeMins || 0), bufferMins: Math.max(0, bufferMins || 0) };
    });
  }, [setTimer]);

  // Restarts the countdown for the half currently in progress as a single
  // combined block: this half's allotted length plus the buffer minutes,
  // counted straight through with no phase change. Doesn't touch currentHalf/
  // totalHalves — it's a reset of "the rest of the game," not a new game.
  const restartHalfWithBuffer = useCallback(() => {
    setTimer((t) => {
      if (!t.configured || t.mode !== 'auto') return t;
      const duration = Math.max(10000, t.halfMs + (t.bufferMins || 0) * 60000);
      return { ...t, isRunning: true, finished: false, periodEndTs: Date.now() + duration, pausedRemainingMs: duration };
    });
    vibrate(40);
  }, [setTimer]);

  // Re-splits whatever time is left before the original scheduled end across the
  // period(s) still to play, so it's correct whether called early on (still needs
  // to leave room for the remaining periods) or in the final one (just snap to
  // the target). Also re-reserves halftime/buffer minutes that haven't happened
  // yet — halftime is treated as sitting at the game's midpoint (e.g. between
  // quarters 2 and 3 for a 4-quarter game), not strictly after period 1.
  const recalculate = useCallback(() => {
    setTimer((t) => {
      if (!t.targetEndTs || t.mode !== 'auto') return t;
      const now = Date.now();
      const remainingHalves = Math.max(1, t.totalHalves - t.currentHalf + 1);
      const halftimeStillAhead = t.currentHalf <= Math.ceil(t.totalHalves / 2);
      const stillToReserveMins = halftimeStillAhead ? (t.halftimeMins || 0) + (t.bufferMins || 0) : (t.bufferMins || 0);
      const totalRemaining = Math.max(10000, (t.targetEndTs - now) - stillToReserveMins * 60000);
      const newHalfMs = Math.max(10000, totalRemaining / remainingHalves);
      if (t.isRunning) {
        return { ...t, halfMs: newHalfMs, periodEndTs: now + newHalfMs };
      }
      return { ...t, halfMs: newHalfMs, pausedRemainingMs: newHalfMs };
    });
    vibrate(40);
  }, [setTimer]);

  useEffect(() => {
    if (!timer.configured && !timer.activityLabel) {
      const slot = detectCurrentActivity();
      if (slot) {
        setTimer((t) => (t.configured || t.activityLabel ? t : { ...t, activityLabel: slot.label }));
      }
    }
  }, [timer.configured]);

  const setupManual = useCallback((minutes, seconds = 0) => {
    const now = Date.now();
    const totalSeconds = Math.max(0, minutes) * 60 + Math.max(0, Math.min(59, seconds));
    const half = Math.max(1000, totalSeconds * 1000);
    setTimer({
      configured: true,
      mode: 'manual',
      endLabel: `Manual · ${formatClock(totalSeconds)}`,
      halfMs: half,
      currentHalf: 1,
      totalHalves: 1,
      periodEndTs: now + half,
      isRunning: true,
      pausedRemainingMs: half,
      finished: false,
    });
  }, [setTimer]);

  const toggle = useCallback(() => {
    setTimer((t) => {
      if (!t.configured || t.finished) return t;
      if (t.isRunning) {
        return { ...t, isRunning: false, pausedRemainingMs: Math.max(0, t.periodEndTs - Date.now()) };
      }
      return { ...t, isRunning: true, periodEndTs: Date.now() + t.pausedRemainingMs };
    });
  }, [setTimer]);

  const reset = useCallback(() => setTimer(defaultTimer()), [setTimer]);

  return { timer, remainingMs, setupAuto, setupAutoAt, setupManual, setActivityLabel, recalculate, updateAutoSettings, restartHalfWithBuffer, toggle, reset };
}

function TimerSetupSheet({ open, onClose, onSetupAuto, onSetupAutoAt, onSetupManual, onUpdateAutoSettings, initialMode, initialHalftimeMins, initialBufferMins, initialActivityLabel, initialSkipHalftime, totalPeriods = 2, periodUnitLabel = 'Half', isConfigured, onReset }) {
  const [mode, setMode] = useState(initialMode || 'auto');
  const [preset, setPreset] = useState('custom');
  const [activityLabel, setActivityLabelState] = useState('');
  const [hour, setHour] = useState('');
  const [minute, setMinute] = useState('');
  const [minutes, setMinutes] = useState('15');
  const [seconds, setSeconds] = useState('0');
  const [halftimeMins, setHalftimeMins] = useState(String(initialHalftimeMins ?? 5));
  const [bufferMins, setBufferMins] = useState(String(initialBufferMins ?? 2));
  const [skipHalftime, setSkipHalftime] = useState(!!initialSkipHalftime);
  const [todaySlots, setTodaySlots] = useState(() => getDaySlots(getAppSettings().schedule));

  useEffect(() => {
    if (open) {
      const slots = getDaySlots(getAppSettings().schedule);
      setTodaySlots(slots);
      setMode(initialMode || 'auto');
      setHalftimeMins(String(initialHalftimeMins ?? 5));
      setBufferMins(String(initialBufferMins ?? 2));
      setSkipHalftime(!!initialSkipHalftime);
      setHour('');
      setMinute('');

      if (isConfigured) {
        // Re-opening the sheet for a timer that's already running (e.g. via
        // long-press to adjust settings) — show what it's actually set to,
        // not whatever's currently upcoming on the wall clock.
        const matchedSlot = slots.find((s) => s.label === initialActivityLabel);
        setPreset(matchedSlot ? matchedSlot.key : 'custom');
        setActivityLabelState(initialActivityLabel || '');
      } else {
        // Fresh setup — suggest whichever activity is actually current/next
        // on the schedule right now. Deliberately ignores initialActivityLabel
        // here: it can still be lingering on the activity that JUST finished
        // (the End Game message flow keeps it around briefly on purpose), and
        // a freshly opened "Set Game Clock" should point at what's coming up,
        // not what already ended.
        const upcoming = detectUpcomingActivity();
        setPreset(upcoming ? upcoming.key : 'custom');
        setActivityLabelState(upcoming ? upcoming.label : '');
      }
    }
  }, [open, initialMode, initialHalftimeMins, initialBufferMins, initialActivityLabel, initialSkipHalftime, isConfigured]);

  const selectedSlot = todaySlots.find((s) => s.key === preset);

  const start = () => {
    if (mode === 'auto') {
      const ht = Math.max(0, parseInt(halftimeMins, 10) || 0);
      const buf = Math.max(0, parseInt(bufferMins, 10) || 0);
      if (selectedSlot) {
        onSetupAutoAt(todayAt(selectedSlot.endHour, selectedSlot.endMinute), ht, buf, selectedSlot.label, skipHalftime, totalPeriods);
      } else {
        const h12 = parseInt(hour, 10);
        const m = parseInt(minute, 10);
        if (!h12 || h12 < 1 || h12 > 12 || isNaN(m) || m < 0 || m > 59) return;
        const hh = resolveClosestHour24(h12, m);
        onSetupAuto(hh, m, ht, buf, activityLabel, skipHalftime, totalPeriods);
      }
    } else {
      const m = Math.max(0, parseInt(minutes, 10) || 0);
      const s = Math.max(0, Math.min(59, parseInt(seconds, 10) || 0));
      if (m <= 0 && s <= 0) return;
      onSetupManual(m, s);
    }
    onClose();
  };

  const deleteTimer = () => {
    onReset();
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title="Game Clock">
      <Field label="Timer Mode">
        <Segmented
          options={[
            { value: 'auto', label: 'Auto-Split' },
            { value: 'manual', label: 'Manual Countdown' },
          ]}
          value={mode}
          onChange={setMode}
        />
      </Field>

      {mode === 'auto' ? (
        <>
          <p className="text-white/50 text-sm mb-5 leading-relaxed">
            Pick today's activity slot, or go custom for a one-off time. We'll split the remaining time evenly into{' '}
            {skipHalftime ? 'one continuous countdown' : `${totalPeriods} ${pluralizePeriodUnit(periodUnitLabel, totalPeriods).toLowerCase()}`} and start the countdown.
          </p>
          <Field label="Activity">
            <div className="grid grid-cols-3 gap-2">
              {todaySlots.map((slot) => (
                <button
                  key={slot.key}
                  type="button"
                  onClick={() => setPreset(slot.key)}
                  className={`btn-press rounded-xl py-4 text-sm font-bold ${preset === slot.key ? 'bg-white text-black' : 'bg-white/10 text-white/70'}`}
                >
                  {slot.pill}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPreset('custom')}
                className={`btn-press rounded-xl py-4 text-sm font-bold ${preset === 'custom' ? 'bg-white text-black' : 'bg-white/10 text-white/70'}`}
              >
                Custom
              </button>
            </div>
          </Field>

          {selectedSlot ? (
            <div className="rounded-2xl bg-white/5 border border-white/10 py-4 mb-5 text-center">
              <div className="text-[10px] font-bold text-white/30 tracking-widest mb-1">ENDS AT</div>
              <div className="text-3xl font-extrabold tabular">{formatHM(selectedSlot.endHour, selectedSlot.endMinute)}</div>
            </div>
          ) : (
            <Field label="Activity ends at">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] font-bold text-white/30 tracking-widest mb-1 text-center">HOUR</div>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="12"
                    value={hour}
                    onChange={(e) => setHour(e.target.value)}
                    placeholder="7"
                    className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-4 text-3xl font-extrabold text-white text-center outline-none focus:border-emerald-400/60 tabular"
                  />
                </div>
                <div>
                  <div className="text-[10px] font-bold text-white/30 tracking-widest mb-1 text-center">MINUTE</div>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max="59"
                    value={minute}
                    onChange={(e) => setMinute(e.target.value)}
                    placeholder="00"
                    className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-4 text-3xl font-extrabold text-white text-center outline-none focus:border-emerald-400/60 tabular"
                  />
                </div>
              </div>
              <p className="text-white/30 text-xs mt-2 leading-relaxed">
                No need for AM/PM — we'll pick whichever is sooner.
              </p>
            </Field>
          )}
          <button
            type="button"
            onClick={() => setSkipHalftime((s) => !s)}
            className={`btn-press w-full flex items-center justify-between gap-2 rounded-xl px-4 py-3 mb-5 border ${skipHalftime ? 'bg-emerald-400 border-emerald-400 text-black' : 'bg-white/5 border-white/10 text-white/70'}`}
          >
            <span className="text-sm font-bold">Skip Breaks — one straight countdown to the end</span>
            <span className={`shrink-0 w-11 h-6 rounded-full relative transition-colors ${skipHalftime ? 'bg-black/20' : 'bg-white/15'}`}>
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full transition-transform ${skipHalftime ? 'translate-x-5 bg-black' : 'bg-white/70'}`} />
            </span>
          </button>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Halftime (mins)">
              <input
                type="number"
                inputMode="numeric"
                min="0"
                max="60"
                value={halftimeMins}
                onChange={(e) => setHalftimeMins(e.target.value)}
                disabled={skipHalftime}
                className="w-full rounded-xl bg-white/10 border border-white/10 px-3 py-3 text-2xl font-extrabold text-white outline-none focus:border-emerald-400/60 tabular disabled:opacity-30"
              />
            </Field>
            <Field label="End Buffer (mins)">
              <input
                type="number"
                inputMode="numeric"
                min="0"
                max="30"
                value={bufferMins}
                onChange={(e) => setBufferMins(e.target.value)}
                className="w-full rounded-xl bg-white/10 border border-white/10 px-3 py-3 text-2xl font-extrabold text-white outline-none focus:border-emerald-400/60 tabular"
              />
            </Field>
          </div>
          <p className="text-white/30 text-xs mb-2 -mt-3 leading-relaxed">
            {skipHalftime
              ? "We'll subtract just the end buffer from the remaining time and count straight down to it — no breaks."
              : `We'll subtract halftime and the end buffer from the remaining time, then split what's left evenly into ${totalPeriods} ${pluralizePeriodUnit(periodUnitLabel, totalPeriods).toLowerCase()}.`}
          </p>

          {isConfigured && (
            <BigButton
              onClick={() => {
                onUpdateAutoSettings(Math.max(0, parseInt(halftimeMins, 10) || 0), Math.max(0, parseInt(bufferMins, 10) || 0));
                onClose();
              }}
              className="w-full rounded-2xl bg-white/10 py-4 font-bold text-white/70 mb-1"
            >
              Save Halftime/Buffer Only
            </BigButton>
          )}
          {isConfigured && (
            <p className="text-white/30 text-xs mb-3 leading-relaxed">
              Updates these numbers without restarting the clock or touching which {periodUnitLabel.toLowerCase()} you're on. Use "Reset {periodUnitLabel}" on the clock to apply the new buffer to the countdown.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="text-white/50 text-sm mb-5 leading-relaxed">
            Enter how long this period should run. It counts down once — tap it to pause or resume.
          </p>
          <Field label="Length">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[10px] font-bold text-white/30 tracking-widest mb-1 text-center">MINUTES</div>
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="120"
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                  className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-4 text-3xl font-extrabold text-white text-center outline-none focus:border-emerald-400/60 tabular"
                />
              </div>
              <div>
                <div className="text-[10px] font-bold text-white/30 tracking-widest mb-1 text-center">SECONDS</div>
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="59"
                  value={seconds}
                  onChange={(e) => setSeconds(e.target.value)}
                  className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-4 text-3xl font-extrabold text-white text-center outline-none focus:border-emerald-400/60 tabular"
                />
              </div>
            </div>
          </Field>
        </>
      )}

      <BigButton
        onClick={start}
        className="w-full rounded-2xl bg-emerald-400 text-black text-lg font-extrabold py-5"
      >
        Start Countdown
      </BigButton>

      {isConfigured && (
        <BigButton
          onClick={deleteTimer}
          className="w-full rounded-2xl bg-red-500/15 border border-red-500/40 py-4 font-bold text-red-400 mt-3"
        >
          Reset / Delete Timer
        </BigButton>
      )}
    </Sheet>
  );
}

function TimerBar({ globalTimer, periodCount = 2, unitLabel = 'Half', locked = false }) {
  const { timer, remainingMs, toggle, reset } = globalTimer;
  const [setupOpen, setSetupOpen] = useState(false);
  const [driftDismissed, setDriftDismissed] = useState(false);
  const driftShownRef = useRef(false);
  const pressTimerRef = useRef(null);
  const longPressFiredRef = useRef(false);

  const clearPressTimer = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  const handlePillPointerDown = () => {
    if (locked) return;
    longPressFiredRef.current = false;
    clearPressTimer();
    pressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      vibrate(40);
      setSetupOpen(true);
    }, 550);
  };

  const handlePillPointerUp = () => {
    clearPressTimer();
    if (locked) { vibrate(15); return; }
    if (!longPressFiredRef.current) toggle();
  };

  const handlePillPointerLeave = () => {
    clearPressTimer();
  };

  useEffect(() => {
    setDriftDismissed(false);
  }, [timer.currentHalf, timer.configured]);

  const showDrift =
    timer.configured &&
    !timer.finished &&
    timer.mode === 'auto' &&
    timer.currentHalf >= timer.totalHalves &&
    !!timer.targetEndTs &&
    !driftDismissed &&
    Math.abs(timer.periodEndTs - timer.targetEndTs) > 2 * 60000;

  useEffect(() => {
    if (showDrift && !driftShownRef.current) {
      vibrate([60, 40, 60, 40, 60]);
      driftShownRef.current = true;
    } else if (!showDrift) {
      driftShownRef.current = false;
    }
  }, [showDrift]);

  if (!timer.configured) {
    return (
      <>
        <button
          onClick={() => { if (locked) { vibrate(15); return; } setSetupOpen(true); }}
          className={`btn-press w-full flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-white/20 py-4 landscape:py-2 text-white/60 font-bold text-sm mb-4 landscape:mb-1 ${locked ? 'opacity-50' : ''}`}
        >
          <Icon name={locked ? 'Lock' : 'Clock'} size={18} />
          {locked ? 'Game Clock · Host Only' : 'Set Game Clock'}
        </button>
        <TimerSetupSheet
          open={setupOpen}
          onClose={() => setSetupOpen(false)}
          onSetupAuto={globalTimer.setupAuto}
          onSetupAutoAt={globalTimer.setupAutoAt}
          onSetupManual={globalTimer.setupManual}
          onUpdateAutoSettings={globalTimer.updateAutoSettings}
          initialMode={timer.mode}
          initialHalftimeMins={timer.halftimeMins}
          initialBufferMins={timer.bufferMins}
          initialSkipHalftime={timer.totalHalves === 1}
          totalPeriods={periodCount}
          periodUnitLabel={unitLabel}
          initialActivityLabel={timer.activityLabel}
          isConfigured={timer.configured}
          onReset={reset}
        />
      </>
    );
  }

  if (timer.finished) {
    return (
      <div className="flash-red rounded-2xl border-2 border-red-500 py-4 landscape:py-1.5 px-4 landscape:px-3 mb-4 landscape:mb-1 flex items-center justify-between">
        <div>
          <div className="text-red-400 text-xs font-extrabold tracking-widest">TIME'S UP</div>
          <div className="text-2xl landscape:text-lg font-black tabular text-white">00:00</div>
        </div>
        <IconButton name="RotateCcw" onClick={() => { if (locked) { vibrate(15); return; } reset(); }} label="Reset timer" />
      </div>
    );
  }

  const seconds = remainingMs / 1000;
  const isRunning = timer.isRunning;

  return (
    <div className="mb-4 landscape:mb-1">
      <button
        onPointerDown={handlePillPointerDown}
        onPointerUp={handlePillPointerUp}
        onPointerLeave={handlePillPointerLeave}
        onPointerCancel={handlePillPointerLeave}
        onContextMenu={(e) => e.preventDefault()}
        className={`btn-press w-full rounded-2xl border-2 py-4 landscape:py-1.5 px-5 landscape:px-3 flex items-center justify-between transition-colors ${
          isRunning ? 'border-emerald-400/40 bg-emerald-400/5' : 'border-red-500 bg-red-500/10 animate-pulse-fast'
        } ${locked ? 'opacity-60' : ''}`}
      >
        <div className="text-left">
          <div className={`text-xs font-extrabold tracking-widest flex items-center gap-1 ${isRunning ? 'text-emerald-400' : 'text-red-400'}`}>
            {locked && <Icon name="Lock" size={10} />}
            {timer.totalHalves > 1 ? `${unitLabel.toUpperCase()} ${timer.currentHalf} ` : ''}{isRunning ? '· RUNNING' : '· PAUSED'}
          </div>
          <div className={`text-4xl landscape:text-2xl font-black tabular ${isRunning ? 'text-white' : 'text-red-400'}`}>
            {formatClock(seconds)}
          </div>
        </div>
        <Icon name={isRunning ? 'Pause' : 'Play'} size={30} className={isRunning ? 'text-emerald-400' : 'text-red-400'} />
      </button>

      {showDrift && (
        <div className="mt-2 landscape:mt-1 rounded-2xl bg-amber-400/15 border border-amber-400/40 px-4 py-3 landscape:py-2">
          <div className="text-amber-300 text-xs font-bold leading-snug mb-2">
            {timer.periodEndTs > timer.targetEndTs ? 'Running behind schedule' : 'Running ahead of schedule'} — at this pace you'll finish around{' '}
            {new Date(timer.periodEndTs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} instead of{' '}
            {new Date(timer.targetEndTs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
          </div>
          <div className="flex gap-2">
            <BigButton
              onClick={() => { if (locked) { vibrate(15); return; } globalTimer.recalculate(); setDriftDismissed(true); }}
              className="flex-1 rounded-xl bg-amber-400 text-black py-2.5 text-xs font-extrabold"
            >
              Adjust to {new Date(timer.targetEndTs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </BigButton>
            <BigButton
              onClick={() => setDriftDismissed(true)}
              className="flex-1 rounded-xl bg-white/10 py-2.5 text-xs font-bold text-white/60"
            >
              Keep As Is
            </BigButton>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mt-1.5 landscape:mt-0.5 gap-2">
        <div className="text-white/30 text-xs font-semibold flex items-center gap-1 py-1 landscape:py-0.5 px-2 truncate">
          <Icon name="Clock" size={12} /> {timer.endLabel} · hold clock to adjust
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {timer.mode === 'auto' && (
            <button
              onClick={() => { if (locked) { vibrate(15); return; } globalTimer.restartHalfWithBuffer(); }}
              aria-label={`Reset this ${unitLabel.toLowerCase()}'s countdown to the ${unitLabel.toLowerCase()} length plus buffer`}
              className="btn-press flex items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-bold text-white/60"
            >
              <Icon name="Repeat" size={11} /> Reset {unitLabel}
            </button>
          )}
          {timer.mode === 'auto' && !!timer.targetEndTs && (
            <button
              onClick={() => { if (locked) { vibrate(15); return; } globalTimer.recalculate(); }}
              className="btn-press flex items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-bold text-white/60"
            >
              <Icon name="RotateCw" size={11} /> Recalculate
            </button>
          )}
        </div>
      </div>
      <TimerSetupSheet
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onSetupAuto={globalTimer.setupAuto}
        onSetupAutoAt={globalTimer.setupAutoAt}
        onSetupManual={globalTimer.setupManual}
        onUpdateAutoSettings={globalTimer.updateAutoSettings}
        initialMode={timer.mode}
        initialHalftimeMins={timer.halftimeMins}
        initialBufferMins={timer.bufferMins}
        initialSkipHalftime={timer.totalHalves === 1}
        totalPeriods={periodCount}
        periodUnitLabel={unitLabel}
        initialActivityLabel={timer.activityLabel}
        isConfigured={timer.configured}
        onReset={reset}
      />
    </div>
  );
}

/* ============================== HEADER ============================== */

function LiveClock({ className }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className={className}>{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>;
}

function Header({ title, onBack, onSettings, extra }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-4 landscape:mb-1 landscape:py-1 landscape:px-3">
      <div className="flex items-center gap-2 min-w-0">
        {onBack && <IconButton name="ChevronLeft" onClick={onBack} label="Back" />}
        <h1 className="text-2xl landscape:text-lg font-extrabold tracking-tight truncate">{title}</h1>
      </div>
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {extra}
        <LiveClock className="hidden sm:inline-block text-white/40 text-sm font-bold tabular mr-1" />
        {onSettings && <IconButton name="Settings" onClick={onSettings} label="Settings" />}
      </div>
    </div>
  );
}

// Wraps ConsultButton so it's fully absent (not just disabled) unless
// Multi-Ref Sync is actually configured and this device is in a live room —
// matches the gating idiom already used for the sync UI itself.
function ConsultSlot({ roomSession, consult, sport, teamAName, teamBName, teamAColor, teamBColor }) {
  if (!isFirebaseConfigured || !roomSession.roomCode) return null;
  return (
    <ConsultButton
      consult={consult.consult}
      sendConsult={consult.sendConsult}
      sending={consult.sending}
      sport={sport}
      teamAName={teamAName}
      teamBName={teamBName}
      teamAColor={teamAColor}
      teamBColor={teamBColor}
    />
  );
}

/* ============================== SHARED SCORE HALF ============================== */

function ScoreHalf({ name, score, onScore, onUndo, footer, scoreClassName = 'text-8xl', color, locked = false, hostLocked = false }) {
  const c = teamColorClasses(color);
  const disabled = locked || hostLocked;
  const tap = () => { if (disabled) { vibrate(15); return; } onScore(); };
  return (
    // A plain div (not <button>) — `footer` can itself contain interactive
    // buttons (e.g. Football's per-timeout dots), and nesting a <button>
    // inside a <button> is invalid HTML that browsers silently reflow,
    // breaking focus order and screen-reader semantics.
    <div
      role="button"
      tabIndex={0}
      onClick={tap}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tap(); } }}
      aria-disabled={disabled}
      className={`btn-press flex-1 rounded-3xl ${c.bg} border-2 ${c.border} flex flex-col items-center justify-center gap-2 landscape:gap-1 relative overflow-hidden py-4 landscape:py-2 px-4 landscape:px-3 landscape:h-full landscape:min-h-[104px] ${disabled ? 'opacity-40 saturate-[.4]' : ''}`}
    >
      <div className={`${c.sub} text-xs font-extrabold tracking-widest self-start flex items-center gap-1`}>
        {disabled && <Icon name="Lock" size={11} />}
        {locked ? 'FIELDING · LOCKED' : hostLocked ? 'HOST ONLY' : 'TAP TO SCORE'}
      </div>
      <div className={`text-lg landscape:text-sm font-bold ${c.text} opacity-70 text-center truncate max-w-full`}>{name}</div>
      <div className={`${scoreClassName} landscape:text-4xl font-black tabular ${c.text}`}>{score}</div>
      {footer}
      <div
        role="button"
        onClick={(e) => { e.stopPropagation(); if (disabled) { vibrate(15); return; } onUndo(); }}
        className={`btn-press absolute bottom-3 landscape:bottom-1.5 right-3 landscape:right-1.5 w-11 h-11 landscape:w-9 landscape:h-9 rounded-full ${c.overlay} ${c.text} flex items-center justify-center`}
      >
        <Icon name="Minus" size={18} />
      </div>
    </div>
  );
}

/* ============================== SHARED END GAME ============================== */

function EndGameSheet({ open, onClose, sportLabel, teamA: teamARaw, teamB: teamBRaw, scoreA, scoreB, globalTimer, winnerOverride, onReset, resetLabel = 'Reset/Delete Game' }) {
  const teamA = displayTeamName(teamARaw, 'A');
  const teamB = displayTeamName(teamBRaw, 'B');
  const [appSettings] = useLocalStorage(APP_SETTINGS_KEY, defaultAppSettings());
  const todaySlots = getDaySlots(appSettings.schedule);
  const todayLabels = todaySlots.map((s) => s.label);
  const [activityPeriod, setActivityPeriodState] = useState(todayLabels[0] || '');
  const [periodExpanded, setPeriodExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sentToBentzi, setSentToBentzi] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (open) {
      setCopied(false);
      setPeriodExpanded(false);
      setSentToBentzi(false);
      setConfirmReset(false);
      const syncedLabel = globalTimer && globalTimer.timer.activityLabel;
      const detected = detectCurrentActivity();
      setActivityPeriodState(syncedLabel || (detected ? detected.label : todayLabels[0] || ''));
    }
  }, [open]);

  const setActivityPeriod = (label) => {
    setActivityPeriodState(label);
    if (globalTimer) globalTimer.setActivityLabel(label);
  };

  const winnerName = winnerOverride !== undefined ? winnerOverride : (scoreA > scoreB ? teamA : scoreB > scoreA ? teamB : null);
  const message = winnerName
    ? `${winnerName} wins ${sportLabel} ${activityPeriod}.`
    : `${sportLabel} ${activityPeriod} ended in a tie, ${scoreA}-${scoreB}.`;

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message);
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = message;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e2) {}
    }
    setCopied(true);
    vibrate(30);
    setTimeout(() => setCopied(false), 1500);
  };

  const sendWhatsApp = () => {
    const phone = (appSettings.whatsappPhone || '').replace(/\D/g, '');
    const url = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
      : `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
    setSentToBentzi(true);
  };

  const handleResetClick = () => {
    if (!confirmReset) {
      setConfirmReset(true);
      vibrate(15);
      return;
    }
    onReset();
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="End Game"
      footer={
        <div className="flex gap-3">
          <BigButton
            onClick={copyMessage}
            className="flex-1 rounded-2xl bg-white/10 py-4 font-extrabold text-sm flex items-center justify-center gap-2"
          >
            <Icon name={copied ? 'Check' : 'Copy'} size={18} /> {copied ? 'Copied!' : 'Copy'}
          </BigButton>
          <BigButton
            onClick={sendWhatsApp}
            className="flex-[1.6] rounded-2xl bg-emerald-400 text-black py-4 font-extrabold text-sm flex items-center justify-center gap-2"
          >
            <Icon name="Send" size={18} /> Send to Bentzi
          </BigButton>
        </div>
      }
    >
      <div className="rounded-2xl bg-white/5 border border-white/10 p-5 mb-6 text-center">
        <div className="text-xs font-extrabold tracking-widest text-white/40 mb-2">FINAL SCORE</div>
        <div className="text-lg font-bold mb-3">{teamA} {scoreA} — {scoreB} {teamB}</div>
        <div className="text-emerald-400 font-extrabold text-xl leading-snug">{message}</div>
      </div>

      <Field label="Activity Period">
        <button
          type="button"
          onClick={() => setPeriodExpanded((e) => !e)}
          className="btn-press w-full flex items-center justify-between rounded-xl bg-white/10 px-4 py-3"
        >
          <span className="text-sm font-bold truncate">{activityPeriod || 'Set period…'}</span>
          <span className="shrink-0 flex items-center gap-1 text-xs text-white/40 font-bold ml-2">
            Change <Icon name={periodExpanded ? 'ChevronUp' : 'ChevronDown'} size={14} />
          </span>
        </button>
        {periodExpanded && (
          <div className="mt-3">
            <div className="grid grid-cols-2 gap-2 mb-3">
              {todayLabels.map((p) => (
                <button
                  key={p}
                  onClick={() => setActivityPeriod(p)}
                  className={`btn-press rounded-xl py-3 text-sm font-bold ${activityPeriod === p ? 'bg-white text-black' : 'bg-white/10 text-white/70'}`}
                >
                  {p}
                </button>
              ))}
            </div>
            <TextInput
              value={activityPeriod}
              onChange={(e) => setActivityPeriod(e.target.value)}
              placeholder="Custom period name..."
              maxLength={30}
            />
          </div>
        )}
      </Field>

      {onReset && (
        <div className="mt-3">
          {confirmReset && (
            <p className="text-red-400 text-xs font-bold mb-2 text-center leading-relaxed">
              {sentToBentzi
                ? 'This erases the final score for good — reset anyway?'
                : "You haven't sent this to Bentzi yet — resetting will erase the final score for good."}
            </p>
          )}
          <div className="flex gap-3">
            {confirmReset && (
              <BigButton
                onClick={() => setConfirmReset(false)}
                className="flex-1 rounded-2xl bg-white/10 py-4 font-bold text-white"
              >
                Cancel
              </BigButton>
            )}
            <BigButton
              onClick={handleResetClick}
              className={`${confirmReset ? 'flex-[1.6]' : 'w-full'} rounded-2xl bg-red-500/15 border border-red-500/40 py-4 font-bold text-red-400 flex items-center justify-center gap-2`}
            >
              <Icon name={confirmReset ? 'AlertTriangle' : 'RotateCcw'} size={18} /> {confirmReset ? 'Confirm Reset' : resetLabel}
            </BigButton>
          </div>
        </div>
      )}
    </Sheet>
  );
}

/* ============================== HOME ============================== */

const SPORTS = [
  { id: 'volleyball', label: 'Volleyball', emoji: '🏐', ring: 'ring-yellow-400/40', glow: 'hover:shadow-yellow-400/20' },
  { id: 'football', label: 'Football', emoji: '🏈', ring: 'ring-orange-500/40', glow: 'hover:shadow-orange-500/20' },
  { id: 'soccer', label: 'Soccer', emoji: '⚽', ring: 'ring-emerald-400/40', glow: 'hover:shadow-emerald-400/20' },
  { id: 'baseball', label: 'Baseball', emoji: '⚾', ring: 'ring-red-500/40', glow: 'hover:shadow-red-500/20' },
  { id: 'hockey', label: 'Hockey', emoji: '🏒', ring: 'ring-sky-400/40', glow: 'hover:shadow-sky-400/20' },
  { id: 'basketball', label: 'Basketball', emoji: '🏀', ring: 'ring-amber-500/40', glow: 'hover:shadow-amber-500/20' },
];

function VibrationTest() {
  const [result, setResult] = useState(null);

  const test = () => {
    if (!('vibrate' in navigator)) {
      setResult('unsupported');
      return;
    }
    const ok = navigator.vibrate(300);
    setResult(ok ? 'sent' : 'blocked');
  };

  return (
    <button
      onClick={test}
      className="btn-press mt-4 mx-auto flex items-center gap-2 rounded-full bg-white/5 border border-white/10 px-4 py-2 text-[11px] font-bold text-white/40"
    >
      <Icon name="Volume2" size={13} />
      Test Vibration
      {result === 'sent' && <span className="text-emerald-400">· sent — feel it?</span>}
      {result === 'blocked' && <span className="text-red-400">· blocked by browser</span>}
      {result === 'unsupported' && <span className="text-red-400">· not supported here</span>}
    </button>
  );
}

/* ============================== ACTIVITY SCHEDULE EDITOR ============================== */

let scheduleSlotSeq = 0;
function newSlot() {
  scheduleSlotSeq += 1;
  return { key: `custom_${Date.now()}_${scheduleSlotSeq}`, label: 'New Activity', pill: 'New Activity', startHour: 9, startMinute: 0, endHour: 10, endMinute: 0 };
}

function timeInputValue(h, m) { return `${pad2(h)}:${pad2(m)}`; }
function parseTimeInputValue(v) {
  const [h, m] = (v || '0:0').split(':').map((n) => parseInt(n, 10) || 0);
  return { h, m };
}

function SlotEditorRow({ slot, onChange, onRemove }) {
  return (
    <div className="rounded-xl bg-white/5 border border-white/10 p-2.5 mb-2">
      <div className="flex items-center gap-2 mb-2">
        <input
          type="text"
          value={slot.label}
          onChange={(e) => onChange({ ...slot, label: e.target.value, pill: e.target.value })}
          placeholder="Activity name"
          maxLength={30}
          className="flex-1 min-w-0 rounded-lg bg-white/10 border border-white/10 px-3 py-2.5 text-sm font-bold text-white outline-none focus:border-emerald-400/60"
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove activity"
          className="btn-press shrink-0 w-9 h-9 rounded-lg bg-white/5 flex items-center justify-center text-red-400"
        >
          <Icon name="Trash2" size={14} />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="time"
          value={timeInputValue(slot.startHour, slot.startMinute)}
          onChange={(e) => { const { h, m } = parseTimeInputValue(e.target.value); onChange({ ...slot, startHour: h, startMinute: m }); }}
          className="flex-1 min-w-0 rounded-lg bg-white/10 border border-white/10 px-2 py-2.5 text-sm font-bold text-white outline-none focus:border-emerald-400/60 tabular"
        />
        <span className="text-white/30 text-xs shrink-0">–</span>
        <input
          type="time"
          value={timeInputValue(slot.endHour, slot.endMinute)}
          onChange={(e) => { const { h, m } = parseTimeInputValue(e.target.value); onChange({ ...slot, endHour: h, endMinute: m }); }}
          className="flex-1 min-w-0 rounded-lg bg-white/10 border border-white/10 px-2 py-2.5 text-sm font-bold text-white outline-none focus:border-emerald-400/60 tabular"
        />
      </div>
    </div>
  );
}

function SlotListEditor({ slots, onChange }) {
  const updateAt = (i, next) => onChange(slots.map((s, idx) => (idx === i ? next : s)));
  const removeAt = (i) => onChange(slots.filter((_, idx) => idx !== i));
  const add = () => onChange([...slots, newSlot()]);
  return (
    <div>
      {slots.map((slot, i) => (
        <SlotEditorRow key={slot.key} slot={slot} onChange={(next) => updateAt(i, next)} onRemove={() => removeAt(i)} />
      ))}
      {slots.length === 0 && (
        <p className="text-white/30 text-xs mb-2">No activities yet — add your first one below.</p>
      )}
      <button
        type="button"
        onClick={add}
        className="btn-press w-full rounded-lg bg-white/5 border border-dashed border-white/20 py-2.5 text-xs font-bold text-white/50 flex items-center justify-center gap-1"
      >
        <Icon name="Plus" size={14} /> Add Activity
      </button>
    </div>
  );
}

function DayOverrideRow({ dayKey, label, defaultSlots, overrideSlots, onSetOverride }) {
  const [expanded, setExpanded] = useState(false);
  const hasOverride = !!overrideSlots;
  const summary = hasOverride ? `${overrideSlots.length} custom` : 'Same as default';

  return (
    <div className="rounded-xl bg-white/5 border border-white/10 mb-2 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="btn-press w-full flex items-center justify-between px-4 py-3"
      >
        <span className="text-sm font-bold">{label}</span>
        <span className="flex items-center gap-2 text-xs text-white/40 font-bold">
          {summary}
          <Icon name={expanded ? 'ChevronUp' : 'ChevronDown'} size={14} />
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-4">
          <button
            type="button"
            onClick={() => onSetOverride(hasOverride ? null : defaultSlots.map((s) => ({ ...s, key: `${dayKey}_${s.key}` })))}
            className={`btn-press w-full flex items-center justify-between gap-2 rounded-xl px-4 py-3 mb-3 border ${hasOverride ? 'bg-emerald-400 border-emerald-400 text-black' : 'bg-white/5 border-white/10 text-white/70'}`}
          >
            <span className="text-sm font-bold">Different schedule for {label}</span>
            <span className={`shrink-0 w-11 h-6 rounded-full relative transition-colors ${hasOverride ? 'bg-black/20' : 'bg-white/15'}`}>
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full transition-transform ${hasOverride ? 'translate-x-5 bg-black' : 'bg-white/70'}`} />
            </span>
          </button>
          {hasOverride && <SlotListEditor slots={overrideSlots} onChange={onSetOverride} />}
        </div>
      )}
    </div>
  );
}

function ScheduleSheet({ open, onClose, settings, setSettings }) {
  const schedule = settings.schedule || defaultSchedule();

  const updateDefault = (slots) => setSettings((s) => ({ ...s, schedule: { ...(s.schedule || defaultSchedule()), default: slots } }));

  const setOverride = (dayKey, slotsOrNull) => setSettings((s) => {
    const cur = s.schedule || defaultSchedule();
    const overrides = { ...cur.overrides };
    if (slotsOrNull) overrides[dayKey] = slotsOrNull;
    else delete overrides[dayKey];
    return { ...s, schedule: { ...cur, overrides } };
  });

  const resetToDefaults = () => setSettings((s) => ({ ...s, schedule: defaultSchedule() }));
  const clearAll = () => setSettings((s) => ({ ...s, schedule: { default: [], overrides: {} } }));

  return (
    <Sheet open={open} onClose={onClose} title="Activity Schedule">
      <p className="text-white/50 text-sm mb-5 leading-relaxed">
        These activity blocks power the Game Clock auto-split and the End Game period picker. Set your everyday times below, then open a day to give it its own schedule — handy for Friday.
      </p>

      <Field label="Default Schedule">
        <SlotListEditor slots={schedule.default || []} onChange={updateDefault} />
      </Field>

      <Field label="Day Overrides">
        {DAY_KEYS.map((dayKey) => (
          <DayOverrideRow
            key={dayKey}
            dayKey={dayKey}
            label={DAY_LABELS[dayKey]}
            defaultSlots={schedule.default || []}
            overrideSlots={schedule.overrides && schedule.overrides[dayKey]}
            onSetOverride={(slots) => setOverride(dayKey, slots)}
          />
        ))}
      </Field>

      <div className="flex gap-3 mb-3">
        <button
          type="button"
          onClick={resetToDefaults}
          className="btn-press flex-1 rounded-xl bg-white/10 py-3 text-xs font-bold text-white/70"
        >
          Reset to YKP Defaults
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="btn-press flex-1 rounded-xl bg-white/10 py-3 text-xs font-bold text-red-400"
        >
          Clear All
        </button>
      </div>

      <BigButton onClick={onClose} className="w-full rounded-2xl bg-emerald-400 text-black py-4 font-extrabold text-lg">
        Done
      </BigButton>
    </Sheet>
  );
}

// `bare` skips the "Multi-Ref Sync" section label — used when this is
// already the sole content of a sheet titled "Multi-Ref Sync" (the small
// per-game button below), so the heading isn't repeated right under itself.
// Defined at module scope (not inside MultiRefSyncField) so it keeps a
// stable identity across renders — an inline-defined component there would
// get recreated every render, forcing React to unmount/remount its children
// (including the join-code input) on every keystroke.
function SyncSectionWrap({ bare, children }) {
  return bare ? <div className="mb-5">{children}</div> : <Field label="Multi-Ref Sync">{children}</Field>;
}

const HOST_ONLY_LOCK_ROWS = [
  { key: 'score', label: 'Lock Score Adjustments' },
  { key: 'timer', label: 'Lock Start/Stop Timer' },
  { key: 'possession', label: 'Lock Server/Possession' },
  { key: 'period', label: 'Lock Period/Half & Timeouts' },
];

// A toggle row shared by the master "Host-Only Control" switch and its
// per-category sub-toggles — same on/off pill visual, different size.
function PermissionToggleRow({ label, on, onToggle, disabled, small = false, icon }) {
  return (
    <button
      type="button"
      onClick={() => { if (!disabled) onToggle(); }}
      disabled={disabled}
      className={`btn-press w-full flex items-center justify-between gap-2 ${disabled ? 'opacity-60' : ''}`}
    >
      <span className={`flex items-center gap-2 font-bold ${small ? 'text-xs text-white/70' : 'text-sm'}`}>
        {icon}
        {label}
      </span>
      <span className={`shrink-0 rounded-full relative transition-colors ${on ? 'bg-emerald-400' : 'bg-white/15'} ${small ? 'w-9 h-5' : 'w-11 h-6'}`}>
        <span
          className={`absolute top-0.5 left-0.5 rounded-full transition-transform bg-black ${small ? 'w-4 h-4' : 'w-5 h-5'} ${
            on ? (small ? 'translate-x-4' : 'translate-x-5') : ''
          } ${!on ? 'bg-white/70' : ''}`}
        />
      </span>
    </button>
  );
}

// Host-Only Control: a master switch plus a collapsed sub-menu of
// per-category toggles, visible to every connected device but only
// writable by the host (roomPermissions.setHostOnly/setLock are already
// no-ops for non-hosts, this just also disables the UI so it reads as
// read-only rather than silently failing).
function HostOnlyControls({ roomSession, permissions }) {
  const isHost = roomSession.role === 'host';
  const p = permissions.permissions;

  return (
    <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-3 mt-2">
      <PermissionToggleRow
        label="Host-Only Control"
        icon={<Icon name="Lock" size={14} />}
        on={p.hostOnly}
        onToggle={() => permissions.setHostOnly(!p.hostOnly)}
        disabled={!isHost}
      />
      {!isHost && (
        <p className="text-white/30 text-xs mt-2 leading-relaxed">Only the host can change this.</p>
      )}
      {p.hostOnly && (
        <div className="mt-3 pt-3 border-t border-white/10 space-y-2.5">
          {HOST_ONLY_LOCK_ROWS.map((row) => (
            <PermissionToggleRow
              key={row.key}
              label={row.label}
              on={!!p.locks[row.key]}
              onToggle={() => permissions.setLock(row.key, !p.locks[row.key])}
              disabled={!isHost}
              small
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Renders entirely offline — `qrcode` draws to a data URL locally, no
// network request — so it still works over a weak camp wifi/cell signal.
function RoomQrCode({ url }) {
  const [dataUrl, setDataUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: '#000000ff', light: '#ffffffff' } })
      .then((d) => { if (!cancelled) setDataUrl(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [url]);

  if (!dataUrl) return null;
  return (
    <div className="flex justify-center py-3">
      <img src={dataUrl} alt="Scan to join this game" width={180} height={180} className="rounded-xl border-4 border-white" />
    </div>
  );
}

function MultiRefSyncField({ roomSession, permissions, bare = false }) {
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  if (!isFirebaseConfigured) {
    return (
      <SyncSectionWrap bare={bare}>
        <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
          <span className="text-white/40 text-sm font-semibold">Not set up yet</span>
        </div>
      </SyncSectionWrap>
    );
  }

  if (roomSession.roomCode) {
    const shareUrl = `${window.location.origin}${window.location.pathname}?game=${roomSession.roomCode}`;
    const copyLink = async () => {
      try {
        await navigator.clipboard.writeText(shareUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch (e) {}
    };
    const refWord = roomSession.presenceCount === 1 ? 'Ref' : 'Refs';
    return (
      <SyncSectionWrap bare={bare}>
        <div className="rounded-xl bg-white/10 px-4 py-3 flex items-center gap-3">
          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${roomSession.connected ? 'bg-emerald-400' : 'bg-yellow-400 animate-pulse'}`} />
          <div className="min-w-0">
            <div className="text-sm font-bold truncate">
              {roomSession.connected ? 'Connected' : 'Reconnecting…'}: Room {roomSession.roomCode} ({roomSession.presenceCount} {refWord})
            </div>
            <div className="text-white/40 text-xs font-semibold">
              {roomSession.role === 'host' ? 'Hosting' : 'Joined as guest'}
            </div>
          </div>
        </div>

        {permissions && <HostOnlyControls roomSession={roomSession} permissions={permissions} />}

        <button
          type="button"
          onClick={copyLink}
          className="btn-press w-full flex items-center justify-between gap-2 rounded-xl bg-white/10 px-4 py-3 mt-2"
        >
          <span className="text-sm font-bold text-white/70 truncate">{shareUrl}</span>
          <Icon name={copied ? 'Check' : 'Copy'} size={16} className={`shrink-0 ${copied ? 'text-emerald-400' : 'text-white/40'}`} />
        </button>

        <button
          type="button"
          onClick={() => setQrOpen((o) => !o)}
          className="btn-press w-full flex items-center justify-between gap-2 rounded-xl bg-white/10 px-4 py-3 mt-2"
        >
          <span className="text-sm font-bold text-white/70 flex items-center gap-2">
            <Icon name="QrCode" size={16} className="text-white/40" /> Show QR Code
          </span>
          <Icon name={qrOpen ? 'ChevronUp' : 'ChevronDown'} size={14} className="text-white/40" />
        </button>
        {qrOpen && <RoomQrCode url={shareUrl} />}

        <button
          type="button"
          onClick={roomSession.leaveRoom}
          disabled={roomSession.busy}
          className="btn-press w-full rounded-xl bg-white/10 text-red-400 py-3 font-bold text-sm mt-3 disabled:opacity-40"
        >
          {roomSession.role === 'host' ? 'Stop Hosting' : 'Leave Game'}
        </button>
      </SyncSectionWrap>
    );
  }

  return (
    <SyncSectionWrap bare={bare}>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={roomSession.hostRoom}
          disabled={roomSession.busy}
          className="btn-press rounded-xl bg-white/10 py-3 font-bold text-sm disabled:opacity-40"
        >
          Host Game
        </button>
        <button
          type="button"
          onClick={() => setJoinOpen((o) => !o)}
          className={`btn-press rounded-xl py-3 font-bold text-sm ${joinOpen ? 'bg-white text-black' : 'bg-white/10'}`}
        >
          Join Game
        </button>
      </div>

      {joinOpen && (
        <div className="flex gap-2 mt-2">
          <TextInput
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="4-digit code"
            inputMode="numeric"
            maxLength={4}
            className="text-center tracking-[0.3em]"
          />
          <button
            type="button"
            onClick={() => roomSession.joinRoom(joinCode)}
            disabled={roomSession.busy || joinCode.length !== 4}
            className="btn-press shrink-0 rounded-xl bg-emerald-400 text-black px-5 font-extrabold text-sm disabled:opacity-40"
          >
            Join
          </button>
        </div>
      )}

      {roomSession.error && (
        <p className="text-red-400 text-xs mt-2 font-semibold">{roomSession.error}</p>
      )}
      <p className="text-white/30 text-xs mt-2 leading-relaxed">
        Host a game to get a 4-digit code other refs can join — scores, the game clock, and period changes stay in sync on every connected device.
      </p>
    </SyncSectionWrap>
  );
}

// Compact entry point for per-game settings sheets: a small status pill that
// opens the same Multi-Ref Sync controls as App Settings in a nested sheet,
// so a ref can host/join without leaving the game they're scoring.
function MultiRefSyncButton({ roomSession, permissions }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-press w-full flex items-center justify-center gap-2 rounded-xl bg-white/5 border border-white/10 py-2.5 text-xs font-bold text-white/50 mb-3"
      >
        {roomSession.roomCode ? (
          <>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${roomSession.connected ? 'bg-emerald-400' : 'bg-yellow-400 animate-pulse'}`} />
            Multi-Ref Sync · Room {roomSession.roomCode} ({roomSession.presenceCount})
          </>
        ) : (
          <>
            <Icon name="Repeat" size={12} />
            Multi-Ref Sync
          </>
        )}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Multi-Ref Sync">
        <MultiRefSyncField roomSession={roomSession} permissions={permissions} bare />
      </Sheet>
    </>
  );
}

function AppSettingsSheet({ open, onClose, settings, setSettings, roomSession, permissions }) {
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const schedule = settings.schedule || defaultSchedule();
  const activeCount = (schedule.default || []).length;
  const overrideDays = Object.keys(schedule.overrides || {}).filter((k) => (schedule.overrides[k] || []).length > 0);
  const scheduleSummary = `${activeCount} activit${activeCount === 1 ? 'y' : 'ies'}${overrideDays.length ? ` · ${overrideDays.map((k) => DAY_LABELS[k]).join(', ')} differs` : ''}`;

  return (
    <Sheet open={open} onClose={onClose} title="App Settings">
      <MultiRefSyncField roomSession={roomSession} permissions={permissions} />

      <Field label="Camp Roster">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSettings((s) => ({ ...s, selectedCamp: '' }))}
            className={`btn-press rounded-xl py-3 px-4 text-sm font-bold ${settings.selectedCamp === '' ? 'bg-white text-black' : 'bg-white/10 text-white/70'}`}
          >
            None
          </button>
          {Object.entries(CAMP_ROSTERS).map(([key, camp]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSettings((s) => ({ ...s, selectedCamp: key }))}
              className={`btn-press rounded-xl py-3 px-4 text-sm font-bold ${settings.selectedCamp === key ? 'bg-white text-black' : 'bg-white/10 text-white/70'}`}
            >
              {camp.label}
            </button>
          ))}
        </div>
        <p className="text-white/30 text-xs mt-2 leading-relaxed">
          Picking a camp fills team pickers with its roster as suggestions. Leave on "None" to keep the roster empty.
        </p>
      </Field>

      <Field label="Activity Schedule">
        <button
          type="button"
          onClick={() => setScheduleOpen(true)}
          className="btn-press w-full flex items-center justify-between rounded-xl bg-white/10 px-4 py-3"
        >
          <span className="text-sm font-bold">{scheduleSummary}</span>
          <Icon name="ChevronRight" size={16} className="text-white/40" />
        </button>
        <p className="text-white/30 text-xs mt-2 leading-relaxed">
          Powers the Game Clock auto-split and the End Game period picker. Stored on this device — give any day (like Friday) its own times, or build your own list from scratch.
        </p>
      </Field>
      <ScheduleSheet open={scheduleOpen} onClose={() => setScheduleOpen(false)} settings={settings} setSettings={setSettings} />

      <Field label="Sports Director WhatsApp Phone #">
        <TextInput
          type="tel"
          inputMode="tel"
          value={settings.whatsappPhone}
          onChange={(e) => setSettings((s) => ({ ...s, whatsappPhone: e.target.value }))}
          placeholder="e.g. 15551234567 (with country code)"
          maxLength={20}
        />
        <p className="text-white/30 text-xs mt-2 leading-relaxed">
          Include the country code, digits only (no spaces or dashes). "Send to Bentzi" will message this number directly — leave blank to pick a contact each time.
        </p>
      </Field>

      <Field label="Appearance">
        <Segmented
          options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'outdoor', label: 'Outdoor' }]}
          value={settings.theme}
          onChange={(v) => setSettings((s) => ({ ...s, theme: v }))}
        />
        <p className="text-white/30 text-xs mt-2 leading-relaxed">
          Outdoor boosts contrast on faint text and panels for readability in direct sunlight.
        </p>
      </Field>

      <Field label="Football · Default Timeouts">
        <Stepper
          value={settings.footballTimeouts}
          min={1}
          max={6}
          onChange={(v) => setSettings((s) => ({ ...s, footballTimeouts: v }))}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Volleyball · Sets 1-2">
          <input
            type="number"
            inputMode="numeric"
            min="1"
            max="99"
            value={settings.volleyballRegularTarget}
            onChange={(e) => {
              const v = e.target.value;
              setSettings((s) => ({ ...s, volleyballRegularTarget: v === '' ? '' : Math.max(1, Math.min(99, parseInt(v, 10) || 1)) }));
            }}
            className="w-full rounded-xl bg-white/10 border border-white/10 px-3 py-3 text-2xl font-extrabold text-white outline-none focus:border-emerald-400/60 tabular"
          />
        </Field>
        <Field label="Volleyball · Set 3+">
          <input
            type="number"
            inputMode="numeric"
            min="1"
            max="99"
            value={settings.volleyballDecidingTarget}
            onChange={(e) => {
              const v = e.target.value;
              setSettings((s) => ({ ...s, volleyballDecidingTarget: v === '' ? '' : Math.max(1, Math.min(99, parseInt(v, 10) || 1)) }));
            }}
            className="w-full rounded-xl bg-white/10 border border-white/10 px-3 py-3 text-2xl font-extrabold text-white outline-none focus:border-emerald-400/60 tabular"
          />
        </Field>
      </div>
      <p className="text-white/30 text-xs mt-2 mb-5 leading-relaxed">
        These are the starting defaults for new games — each sport's own settings can still override them for that game.
      </p>

      <Field label="Volleyball · Tap Server to Score">
        <Segmented
          options={[{ value: false, label: 'Off' }, { value: true, label: 'On' }]}
          value={settings.volleyballTapToScore}
          onChange={(v) => setSettings((s) => ({ ...s, volleyballTapToScore: v }))}
        />
        <p className="text-white/30 text-xs mt-2 leading-relaxed">
          When on, tapping the team that's already serving adds a point. Tapping the other team still just switches serve (side out) — tap it again once they're serving to score.
        </p>
      </Field>

      <Field label="Basketball · Track Fouls">
        <Segmented
          options={[{ value: false, label: 'Off' }, { value: true, label: 'On' }]}
          value={settings.basketballFoulsEnabled}
          onChange={(v) => setSettings((s) => ({ ...s, basketballFoulsEnabled: v }))}
        />
        <p className="text-white/30 text-xs mt-2 leading-relaxed">
          When on, each Basketball team gets a small foul counter under their scoring buttons.
        </p>
      </Field>

      <Field label="Basketball · Default Format">
        <Segmented
          options={[{ value: 'halves', label: '2 Halves' }, { value: 'quarters', label: '4 Quarters' }]}
          value={settings.basketballDefaultFormat}
          onChange={(v) => setSettings((s) => ({ ...s, basketballDefaultFormat: v }))}
        />
        <p className="text-white/30 text-xs mt-2 leading-relaxed">
          What new Basketball games start in, and what the game clock splits into. Each game's own settings can still switch it just for that game.
        </p>
      </Field>

      <Field label="Hockey · Default Format">
        <Segmented
          options={[{ value: 'periods', label: '3 Periods' }, { value: 'halves', label: '2 Halves' }]}
          value={settings.hockeyDefaultFormat}
          onChange={(v) => setSettings((s) => ({ ...s, hockeyDefaultFormat: v }))}
        />
        <p className="text-white/30 text-xs mt-2 leading-relaxed">
          What new Hockey games start in, and what the game clock splits into. Most refs run halves — switch this once here instead of every game.
        </p>
      </Field>

      <BigButton onClick={onClose} className="w-full rounded-2xl bg-emerald-400 text-black py-4 font-extrabold text-lg mt-2">
        Done
      </BigButton>
    </Sheet>
  );
}

function Home({ onSelect, settings, setSettings, roomSession, permissions }) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="px-5 pt-6 pb-8 max-w-md mx-auto flex flex-col min-h-[100dvh]">
      <div className="flex items-center justify-between mb-1">
        <div className="text-3xl font-black tracking-tight">YKP-Refs</div>
        <LiveClock className="text-white/40 text-sm font-bold tabular" />
      </div>
      <div className="text-white/40 text-sm font-semibold mb-7">Camp Sports Referee Toolkit</div>

      <div className="grid grid-cols-2 gap-4">
        {SPORTS.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`btn-press aspect-square rounded-3xl bg-zinc-900 ring-1 ${s.ring} flex flex-col items-center justify-center gap-2 shadow-lg ${s.glow}`}
          >
            <div className="text-6xl leading-none emoji-safe">{s.emoji}</div>
            <div className="text-base font-extrabold">{s.label}</div>
          </button>
        ))}
      </div>

      <div className="mt-8 text-center text-white/25 text-xs font-semibold">
        Tap a sport to start tracking · Set your end time to run the game clock
      </div>
      <div className="mt-2 text-center text-white/15 text-[10px] font-bold tracking-widest">
        v{APP_VERSION}
      </div>
      <div className="flex justify-center">
        <VibrationTest />
      </div>

      <div className="flex-1" />

      <button
        onClick={() => setSettingsOpen(true)}
        className="btn-press w-full mt-6 flex items-center justify-center gap-2 rounded-2xl bg-zinc-900 border border-white/10 py-4 text-white/60 font-bold text-sm"
      >
        <Icon name="Settings" size={16} />
        App Settings
      </button>

      <AppSettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        setSettings={setSettings}
        roomSession={roomSession}
        permissions={permissions}
      />

      <div className="mt-4 text-center text-white/15 text-[10px] font-semibold">
        &copy; {new Date().getFullYear()} Yisroel Haskelevich
      </div>
    </div>
  );
}

/* ============================== VOLLEYBALL ============================== */

const VB_KEY = 'refcourt_volleyball_v1';

function defaultVolleyball() {
  const s = getAppSettings();
  return {
    teamA: '', teamB: '', colorA: null, colorB: null, scoreA: 0, scoreB: 0, serving: 'A', streak: 0,
    set: 1,
    liveSet: 1,
    matchFinished: false,
    regularTarget: s.volleyballRegularTarget,
    decidingTarget: s.volleyballDecidingTarget,
    setHistory: [],
    usedPointServeA: false,
    usedPointServeB: false,
  };
}

function volleyballTarget(s) {
  return s.set >= 3 ? (s.decidingTarget || 11) : (s.regularTarget || 16);
}

function pointServeEligibility(s) {
  const target = volleyballTarget(s);
  const aEligible = s.serving === 'A' && !s.usedPointServeA && (s.scoreA + 1 >= target) && ((s.scoreA + 1) - s.scoreB >= 2);
  const bEligible = s.serving === 'B' && !s.usedPointServeB && (s.scoreB + 1 >= target) && ((s.scoreB + 1) - s.scoreA >= 2);
  return { aEligible, bEligible };
}

function VolleyballSetTracker({ vb, teamADisplay, teamBDisplay, onAdvanceSet, onViewSet, locked }) {
  const setHistory = vb.setHistory || [];
  const setsWonA = setHistory.filter((e) => e && e.winner === teamADisplay).length;
  const setsWonB = setHistory.filter((e) => e && e.winner === teamBDisplay).length;
  const matchOver = setsWonA >= 2 || setsWonB >= 2;
  const isLive = vb.set === vb.liveSet && !vb.matchFinished;

  return (
    <div className="rounded-2xl bg-zinc-900 border border-white/10 p-4 landscape:p-2 mb-4 landscape:mb-2 shrink-0">
      <div className="grid grid-cols-3 gap-2 mb-3 landscape:mb-1.5">
        {[1, 2, 3].map((n) => {
          const entry = setHistory[n - 1];
          const isLiveSlot = vb.liveSet === n;
          const isViewing = vb.set === n;
          const reachable = !!entry || isLiveSlot;
          return (
            <button
              key={n}
              type="button"
              disabled={!reachable}
              onClick={() => onViewSet(n)}
              className={`btn-press rounded-xl py-3 landscape:py-1.5 text-center border ${
                isViewing ? 'border-emerald-400 bg-emerald-400/10' : 'border-white/10 bg-white/5'
              } ${!reachable ? 'opacity-30' : ''}`}
            >
              <div className="text-[9px] font-bold text-white/40 tracking-widest mb-1">SET {n}</div>
              {entry ? (
                <div className="text-xs font-extrabold truncate px-1">{entry.winner || 'Tie'}</div>
              ) : isLiveSlot ? (
                <div className="text-xs font-extrabold text-emerald-400">LIVE</div>
              ) : (
                <div className="text-xs text-white/20">—</div>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-bold text-white/50">
          {matchOver
            ? `${setsWonA > setsWonB ? teamADisplay : teamBDisplay} wins the match ${Math.max(setsWonA, setsWonB)}-${Math.min(setsWonA, setsWonB)}`
            : `Sets · ${teamADisplay} ${setsWonA} – ${setsWonB} ${teamBDisplay}`}
        </div>
        {!matchOver && isLive && (
          <button
            onClick={() => { if (locked) { vibrate(15); return; } onAdvanceSet(); }}
            className={`btn-press shrink-0 rounded-xl bg-white/10 px-3 py-2 text-xs font-bold text-white flex items-center gap-1 ${locked ? 'opacity-40' : ''}`}
          >
            {locked && <Icon name="Lock" size={11} />}
            {vb.set < 3 ? 'Next Set' : 'End Set 3'} <Icon name="ChevronRight" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function Volleyball({ globalTimer, onBack, roomSession, permissions, consult }) {
  const [vb, setVb] = useLocalStorage(VB_KEY, defaultVolleyball());
  const canScore = permissions.canControl('score');
  const canPossession = permissions.canControl('possession');
  const canPeriod = permissions.canControl('period');
  // Merge synced data onto defaultVolleyball() — see useGlobalTimer for why.
  const setVbSynced = useCallback((v) => setVb((s) => ({ ...defaultVolleyball(), ...v })), [setVb]);
  useRoomSync(roomSession.roomCode, 'volleyball', vb, setVbSynced);
  const [appSettings] = useLocalStorage(APP_SETTINGS_KEY, defaultAppSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [endGameOpen, setEndGameOpen] = useState(false);

  const point = () => {
    if (!canScore) { vibrate(15); return; }
    setVb((s) => {
      if (s.set !== s.liveSet || s.matchFinished) return s;
      const { aEligible, bEligible } = pointServeEligibility(s);
      return {
        ...s,
        scoreA: s.serving === 'A' ? s.scoreA + 1 : s.scoreA,
        scoreB: s.serving === 'B' ? s.scoreB + 1 : s.scoreB,
        streak: s.streak + 1,
        usedPointServeA: s.usedPointServeA || aEligible,
        usedPointServeB: s.usedPointServeB || bEligible,
      };
    });
  };

  const sideOut = () => {
    if (!canPossession) { vibrate(15); return; }
    setVb((s) => {
      if (s.set !== s.liveSet || s.matchFinished) return s;
      const { aEligible, bEligible } = pointServeEligibility(s);
      return {
        ...s,
        serving: s.serving === 'A' ? 'B' : 'A',
        streak: 0,
        usedPointServeA: s.usedPointServeA || aEligible,
        usedPointServeB: s.usedPointServeB || bEligible,
      };
    });
    vibrate(40);
  };

  const undo = (team) => {
    if (!canScore) { vibrate(15); return; }
    setVb((s) => {
      if (s.set !== s.liveSet || s.matchFinished) return s;
      return { ...s, [team === 'A' ? 'scoreA' : 'scoreB']: Math.max(0, (team === 'A' ? s.scoreA : s.scoreB) - 1) };
    });
  };

  const advanceSet = () => {
    if (!canPeriod) { vibrate(15); return; }
    setVb((s) => {
    if (s.set !== s.liveSet || s.matchFinished) return s;
    // Snapshot everything about this set as it stood right now — team names, colors,
    // and final score — so navigating back to view it later is correct regardless of
    // how many more times sides get swapped afterward.
    const winner = s.scoreA > s.scoreB
      ? displayTeamName(s.teamA, 'A')
      : s.scoreB > s.scoreA ? displayTeamName(s.teamB, 'B') : null;
    const setHistory = [...(s.setHistory || [])];
    setHistory[s.set - 1] = {
      winner,
      teamA: displayTeamName(s.teamA, 'A'),
      teamB: displayTeamName(s.teamB, 'B'),
      colorA: s.colorA,
      colorB: s.colorB,
      scoreA: s.scoreA,
      scoreB: s.scoreB,
      serving: s.serving,
      streak: s.streak,
      usedPointServeA: s.usedPointServeA,
      usedPointServeB: s.usedPointServeB,
    };
    if (s.set >= 3) {
      // No set 4 to move to — freeze the final score instead of resetting it
      // like a normal set change, so the last set's result stays on screen.
      return { ...s, matchFinished: true, setHistory };
    }
    const nextSet = s.set + 1;
    return {
      ...s,
      teamA: s.teamB, teamB: s.teamA,
      colorA: s.colorB, colorB: s.colorA,
      serving: s.serving === 'A' ? 'B' : 'A',
      scoreA: 0, scoreB: 0, streak: 0,
      usedPointServeA: false, usedPointServeB: false,
      set: nextSet,
      liveSet: nextSet,
      setHistory,
    };
    });
  };

  const viewSet = (n) => setVb((s) => ({ ...s, set: Math.max(1, Math.min(s.liveSet, n)) }));

  // Undoes an accidental "Next Set": only valid while viewing the set that was
  // just finalized (the one directly before the current live set), since that's
  // the only history entry that can be restored without losing progress made
  // in a newer live set.
  const continueEditingSet = () => {
    if (!canPeriod) { vibrate(15); return; }
    setVb((s) => {
    if (s.matchFinished && s.set === s.liveSet) {
      // Undo "End Set 3": score was frozen in place, not reset, so just
      // un-finish the match and drop the history entry that was just saved.
      const setHistory = [...s.setHistory];
      setHistory[s.set - 1] = undefined;
      return { ...s, matchFinished: false, setHistory };
    }
    if (s.set !== s.liveSet - 1) return s;
    const entry = (s.setHistory || [])[s.set - 1];
    if (!entry) return s;
    const setHistory = [...s.setHistory];
    setHistory[s.set - 1] = undefined;
    return {
      ...s,
      teamA: s.teamB, teamB: s.teamA,
      colorA: s.colorB, colorB: s.colorA,
      scoreA: entry.scoreA, scoreB: entry.scoreB,
      serving: entry.serving ?? s.serving,
      streak: entry.streak ?? 0,
      usedPointServeA: entry.usedPointServeA ?? false,
      usedPointServeB: entry.usedPointServeB ?? false,
      liveSet: s.set,
      setHistory,
    };
    });
  };

  const switchSides = () => {
    if (!canPossession) { vibrate(15); return; }
    setVb((s) => ({
      ...s,
      teamA: s.teamB, teamB: s.teamA,
      colorA: s.colorB, colorB: s.colorA,
      scoreA: s.scoreB, scoreB: s.scoreA,
      serving: s.serving === 'A' ? 'B' : 'A',
    }));
  };

  const setServer = (team) => setVb((s) => ({ ...s, serving: team, streak: 0 }));

  const tapTeam = (team) => {
    if (vb.set !== vb.liveSet || vb.matchFinished) return;
    if (appSettings.volleyballTapToScore && vb.serving === team) {
      point();
    } else {
      if (!canPossession) { vibrate(15); return; }
      setServer(team);
    }
  };

  const isLive = vb.set === vb.liveSet && !vb.matchFinished;
  const historyEntry = (vb.setHistory || [])[vb.set - 1];

  const teamADisplay = displayTeamName(vb.teamA, 'A');
  const teamBDisplay = displayTeamName(vb.teamB, 'B');

  const viewScoreA = isLive ? vb.scoreA : (historyEntry ? historyEntry.scoreA : 0);
  const viewScoreB = isLive ? vb.scoreB : (historyEntry ? historyEntry.scoreB : 0);
  const viewTeamAName = isLive ? teamADisplay : (historyEntry ? historyEntry.teamA : teamADisplay);
  const viewTeamBName = isLive ? teamBDisplay : (historyEntry ? historyEntry.teamB : teamBDisplay);
  const viewColorA = isLive ? vb.colorA : (historyEntry ? historyEntry.colorA : vb.colorA);
  const viewColorB = isLive ? vb.colorB : (historyEntry ? historyEntry.colorB : vb.colorB);

  const spTarget = volleyballTarget(vb);
  const setDoneA = isLive && vb.scoreA >= spTarget && (vb.scoreA - vb.scoreB) >= 2;
  const setDoneB = isLive && vb.scoreB >= spTarget && (vb.scoreB - vb.scoreA) >= 2;
  const setWinnerName = setDoneA ? teamADisplay : setDoneB ? teamBDisplay : null;

  const { aEligible, bEligible } = pointServeEligibility(vb);
  const pointServeActive = isLive && !setWinnerName && (aEligible || bEligible);
  const winByTwo = Math.min(vb.scoreA, vb.scoreB) >= spTarget - 1;
  const serverName = displayTeamName(vb.serving === 'A' ? vb.teamA : vb.teamB, vb.serving);
  const bannerText = pointServeActive ? `${serverName} POINT SERVE${winByTwo ? ' (WIN BY 2)' : ''}` : null;

  const setPointRef = useRef(false);
  useEffect(() => {
    if (pointServeActive && !setPointRef.current) vibrate(40);
    setPointRef.current = pointServeActive;
  }, [pointServeActive]);

  const setWinRef = useRef(false);
  useEffect(() => {
    if (setWinnerName && !setWinRef.current) vibrate([50, 50, 50, 50, 100]);
    setWinRef.current = !!setWinnerName;
  }, [setWinnerName]);

  const setHistoryList = vb.setHistory || [];
  const setsWonA = setHistoryList.filter((e) => e && e.winner === teamADisplay).length;
  const setsWonB = setHistoryList.filter((e) => e && e.winner === teamBDisplay).length;
  let matchWinnerOverride;
  if (setsWonA >= 2 || setsWonB >= 2 || setsWonA !== setsWonB) {
    matchWinnerOverride = setsWonA > setsWonB ? teamADisplay : teamBDisplay;
  }

  return (
    <div className="px-5 pt-6 pb-8 landscape:px-3 landscape:pt-2 landscape:pb-2 max-w-md landscape:max-w-none mx-auto flex flex-col min-h-[100dvh] landscape:min-h-dvh">
      <EndGamePill onClick={() => setEndGameOpen(true)} />
      <Header title="Volleyball" onBack={onBack} onSettings={() => setSettingsOpen(true)} extra={<ConsultSlot roomSession={roomSession} consult={consult} sport="volleyball" teamAName={teamADisplay} teamBName={teamBDisplay} teamAColor={vb.colorA} teamBColor={vb.colorB} />} />

      <VolleyballSetTracker vb={vb} teamADisplay={teamADisplay} teamBDisplay={teamBDisplay} onAdvanceSet={advanceSet} onViewSet={viewSet} locked={!canPeriod} />

      <div className="flex items-center justify-end mb-2 landscape:mb-1 px-1 shrink-0">
        <div className="text-white/40 text-xs font-extrabold tracking-widest">STREAK {vb.streak}</div>
      </div>

      {setWinnerName ? (
        <div className="mb-3 landscape:mb-1.5 rounded-2xl bg-emerald-400 text-black text-center py-2.5 landscape:py-1.5 font-extrabold text-sm tracking-widest animate-pulse-fast shrink-0">
          {setWinnerName.toUpperCase()} WINS THE SET
        </div>
      ) : bannerText && (
        <div className="mb-3 landscape:mb-1.5 rounded-2xl bg-yellow-400 text-black text-center py-2.5 landscape:py-1.5 font-extrabold text-sm tracking-widest animate-pulse-fast shrink-0">
          {bannerText}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 landscape:gap-2 mb-4 landscape:mb-2 flex-1 landscape:min-h-0">
        {['A', 'B'].map((team) => {
          const serving = isLive && vb.serving === team;
          const name = team === 'A' ? viewTeamAName : viewTeamBName;
          const score = team === 'A' ? viewScoreA : viewScoreB;
          const color = team === 'A' ? viewColorA : viewColorB;
          const c = teamColorClasses(color);
          return (
            <button
              key={team}
              onClick={() => tapTeam(team)}
              className={`btn-press rounded-3xl flex flex-col items-center justify-center py-8 landscape:py-2 gap-2 landscape:gap-1 transition-colors ${c.bg} ${
                serving ? 'border-4 border-emerald-400 ring-4 ring-emerald-400/40' : `border-2 ${c.border}`
              }`}
            >
              {serving && (
                <div className="flex items-center gap-1 text-emerald-400 text-xs font-extrabold tracking-widest mb-1 landscape:mb-0">
                  <Icon name="CircleDot" size={12} /> SERVING
                </div>
              )}
              <div className={`text-lg landscape:text-sm font-bold ${c.text} opacity-70 truncate max-w-full px-2`}>{name}</div>
              <div className={`text-7xl landscape:text-5xl font-black tabular ${c.text}`}>{score}</div>
              {isLive && (
                <div
                  role="button"
                  onClick={(e) => { e.stopPropagation(); undo(team); }}
                  className={`btn-press mt-2 landscape:mt-1 w-10 h-10 landscape:w-8 landscape:h-8 rounded-full ${c.overlay} ${c.text} flex items-center justify-center`}
                >
                  <Icon name="Minus" size={16} />
                </div>
              )}
            </button>
          );
        })}
      </div>

      {isLive ? (
        <div className="grid grid-cols-2 gap-3 landscape:gap-2 shrink-0">
          <BigButton onClick={sideOut} className={`rounded-3xl bg-red-500/15 border-2 border-red-500 py-7 landscape:py-3 text-red-400 font-extrabold text-xl landscape:text-base flex flex-col landscape:flex-row items-center gap-1 landscape:gap-2 justify-center ${!canPossession ? 'opacity-40 saturate-[.4]' : ''}`}>
            <Icon name={canPossession ? 'ArrowLeftRight' : 'Lock'} size={26} />
            Side Out
          </BigButton>
          <BigButton onClick={point} className={`rounded-3xl bg-emerald-400 py-7 landscape:py-3 text-black font-extrabold text-xl landscape:text-base flex flex-col landscape:flex-row items-center gap-1 landscape:gap-2 justify-center ${!canScore ? 'opacity-40 saturate-[.4]' : ''}`}>
            <Icon name={canScore ? 'Plus' : 'Lock'} size={26} />
            Point
          </BigButton>
        </div>
      ) : vb.matchFinished && vb.set === vb.liveSet ? (
        <div className="flex gap-2 shrink-0">
          <BigButton
            onClick={continueEditingSet}
            className={`basis-[30%] grow rounded-3xl bg-yellow-400/15 border-2 border-yellow-400 py-6 landscape:py-3 text-yellow-400 font-extrabold text-xs flex flex-col items-center justify-center gap-1 ${!canPeriod ? 'opacity-40' : ''}`}
          >
            <Icon name={canPeriod ? 'RotateCcw' : 'Lock'} size={18} />
            Continue Set
          </BigButton>
          <BigButton
            onClick={() => setEndGameOpen(true)}
            className="basis-[70%] grow rounded-3xl bg-emerald-400 py-6 landscape:py-3 text-black font-extrabold text-sm flex items-center justify-center gap-2"
          >
            <Icon name="Flag" size={18} />
            Match Over · End Game
          </BigButton>
        </div>
      ) : vb.set === vb.liveSet - 1 ? (
        <div className="flex gap-2 shrink-0">
          <BigButton
            onClick={() => viewSet(vb.liveSet)}
            className="basis-[70%] grow rounded-3xl bg-white/10 border-2 border-white/20 py-6 landscape:py-3 text-white font-extrabold text-sm flex items-center justify-center gap-2"
          >
            <Icon name="ArrowLeft" size={18} />
            Set {vb.set} (Final) · Return to Live
          </BigButton>
          <BigButton
            onClick={continueEditingSet}
            className={`basis-[30%] grow rounded-3xl bg-yellow-400/15 border-2 border-yellow-400 py-6 landscape:py-3 text-yellow-400 font-extrabold text-xs flex flex-col items-center justify-center gap-1 ${!canPeriod ? 'opacity-40' : ''}`}
          >
            <Icon name={canPeriod ? 'RotateCcw' : 'Lock'} size={18} />
            Continue Set
          </BigButton>
        </div>
      ) : (
        <BigButton
          onClick={() => viewSet(vb.liveSet)}
          className="rounded-3xl bg-white/10 border-2 border-white/20 py-6 landscape:py-3 text-white font-extrabold text-base flex items-center justify-center gap-2 shrink-0"
        >
          <Icon name="ArrowLeft" size={18} />
          Viewing Set {vb.set} (Final) · Tap to Return to Live Set
        </BigButton>
      )}

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Volleyball Settings">
        <TeamPicker
          label="Team A"
          teamName={vb.teamA}
          teamColor={vb.colorA}
          onSelect={(t) => setVb((s) => ({ ...s, teamA: t.label, colorA: t.color }))}
          onCustomName={(v) => setVb((s) => ({ ...s, teamA: v }))}
          onCustomColor={(c) => setVb((s) => ({ ...s, colorA: c }))}
        />
        <TeamPicker
          label="Team B"
          teamName={vb.teamB}
          teamColor={vb.colorB}
          onSelect={(t) => setVb((s) => ({ ...s, teamB: t.label, colorB: t.color }))}
          onCustomName={(v) => setVb((s) => ({ ...s, teamB: v }))}
          onCustomColor={(c) => setVb((s) => ({ ...s, colorB: c }))}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Sets 1-2 Target">
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max="99"
              value={vb.regularTarget ?? 16}
              onChange={(e) => {
                const v = e.target.value;
                setVb((s) => ({ ...s, regularTarget: v === '' ? '' : Math.max(1, Math.min(99, parseInt(v, 10) || 1)) }));
              }}
              className="w-full rounded-xl bg-white/10 border border-white/10 px-3 py-3 text-2xl font-extrabold text-white outline-none focus:border-emerald-400/60 tabular"
            />
          </Field>
          <Field label="Set 3+ Target">
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max="99"
              value={vb.decidingTarget ?? 11}
              onChange={(e) => {
                const v = e.target.value;
                setVb((s) => ({ ...s, decidingTarget: v === '' ? '' : Math.max(1, Math.min(99, parseInt(v, 10) || 1)) }));
              }}
              className="w-full rounded-xl bg-white/10 border border-white/10 px-3 py-3 text-2xl font-extrabold text-white outline-none focus:border-emerald-400/60 tabular"
            />
          </Field>
        </div>
        <p className="text-white/30 text-xs mt-2 mb-3 leading-relaxed">
          We'll flag "Point Serve" when the serving team can win the set on this serve (once per team per set) — adding "(Win By 2)" once both teams are close enough that the win-by-two rule is in play, so it's clear that's what's needed, not a claim they're already 2 ahead. Use "Next Set" at the top of the screen to end a set — sides switch automatically.
        </p>
        <BigButton onClick={switchSides} className={`w-full rounded-2xl bg-white/10 py-4 font-bold text-white mb-3 flex items-center justify-center gap-2 ${!canPossession ? 'opacity-40' : ''}`}>
          <Icon name={canPossession ? 'ArrowLeftRight' : 'Lock'} size={18} /> Switch Sides
        </BigButton>
        <BigButton
          onClick={() => { if (!canScore) { vibrate(15); return; } setVb(defaultVolleyball()); }}
          className="w-full rounded-2xl bg-red-500/15 border border-red-500/40 py-4 font-bold text-red-400 mb-3"
        >
          {!canScore && <Icon name="Lock" size={14} className="inline mr-1.5 -mt-0.5" />}Reset Match
        </BigButton>
        <MultiRefSyncButton roomSession={roomSession} permissions={permissions} />
        <BigButton onClick={() => setSettingsOpen(false)} className="w-full rounded-2xl bg-emerald-400 text-black py-4 font-extrabold text-lg">
          Done
        </BigButton>
      </Sheet>

      <EndGameSheet
        open={endGameOpen}
        onClose={() => setEndGameOpen(false)}
        sportLabel="Volleyball"
        teamA={vb.teamA}
        teamB={vb.teamB}
        scoreA={vb.scoreA}
        scoreB={vb.scoreB}
        globalTimer={globalTimer}
        winnerOverride={matchWinnerOverride}
        onReset={() => setVb(defaultVolleyball())}
        resetLabel="Reset/Delete Match"
      />
    </div>
  );
}

/* ============================== FOOTBALL ============================== */

const FB_KEY = 'refcourt_football_v1';

function defaultFootball() {
  const to = getAppSettings().footballTimeouts;
  return {
    teamA: '', teamB: '', scoreA: 0, scoreB: 0,
    colorA: null, colorB: null,
    timeoutMode: 'half', timeoutCount: to,
    timeoutsA: to, timeoutsB: to,
    half: 1,
  };
}

function Football({ globalTimer, onBack, roomSession, permissions, consult }) {
  const [fb, setFb] = useLocalStorage(FB_KEY, defaultFootball());
  const canScore = permissions.canControl('score');
  const canTimer = permissions.canControl('timer');
  const canPeriod = permissions.canControl('period');
  // Merge synced data onto defaultFootball() — see useGlobalTimer for why.
  const setFbSynced = useCallback((v) => setFb((s) => ({ ...defaultFootball(), ...v })), [setFb]);
  useRoomSync(roomSession.roomCode, 'football', fb, setFbSynced);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [endGameOpen, setEndGameOpen] = useState(false);

  const addPoint = (team) => {
    if (!canScore) { vibrate(15); return; }
    setFb((s) => ({ ...s, [team === 'A' ? 'scoreA' : 'scoreB']: (team === 'A' ? s.scoreA : s.scoreB) + 1 }));
    vibrate(30);
  };

  const undo = (team) => {
    if (!canScore) { vibrate(15); return; }
    setFb((s) => ({ ...s, [team === 'A' ? 'scoreA' : 'scoreB']: Math.max(0, (team === 'A' ? s.scoreA : s.scoreB) - 1) }));
  };

  const useTimeout = (team) => {
    if (!canPeriod) { vibrate(15); return; }
    setFb((s) => {
      const key = team === 'A' ? 'timeoutsA' : 'timeoutsB';
      if (s[key] <= 0) return s;
      vibrate(50);
      return { ...s, [key]: s[key] - 1 };
    });
  };

  const restoreTimeout = (team) => {
    if (!canPeriod) { vibrate(15); return; }
    setFb((s) => {
      const key = team === 'A' ? 'timeoutsA' : 'timeoutsB';
      if (s[key] >= s.timeoutCount) return s;
      return { ...s, [key]: s[key] + 1 };
    });
  };

  // Not gated by canPeriod itself — it's also called by the timer-finished
  // auto-advance effect below, which must keep firing on every device
  // regardless of lock state (it's a local reaction to synced timer state,
  // not a control a guest is exercising). The chevron buttons that let a
  // ref manually change halves check canPeriod before calling this.
  const changeHalf = (delta) => {
    setFb((s) => {
      const half = Math.max(1, s.half + delta);
      if (delta > 0 && s.timeoutMode === 'half') {
        return { ...s, half, timeoutsA: s.timeoutCount, timeoutsB: s.timeoutCount };
      }
      return { ...s, half };
    });
  };

  // Auto-advance to the next half the moment the game clock hits 00:00, so the
  // ref doesn't have to also remember to tap the chevron.
  // Seed with the timer's current state (not a hardcoded false) — otherwise
  // mounting on a screen while the shared clock is already left over
  // "finished" from a different game reads as "it just finished here" and
  // spuriously auto-advances this sport's own half/period counter by one.
  const timerJustFinishedRef = useRef(globalTimer.timer.finished);
  useEffect(() => {
    const finished = globalTimer.timer.finished;
    if (finished && !timerJustFinishedRef.current) {
      changeHalf(1);
    }
    timerJustFinishedRef.current = finished;
  }, [globalTimer.timer.finished]);

  const TimeoutFooter = ({ team }) => {
    const remaining = team === 'A' ? fb.timeoutsA : fb.timeoutsB;
    const color = team === 'A' ? fb.colorA : fb.colorB;
    const c = teamColorClasses(color);
    const light = c.text === 'text-black';
    const dotFill = light ? 'bg-black border-black' : 'bg-white border-white';
    const dotEmpty = light ? 'border-black/30' : 'border-white/30';
    return (
      <div className="w-full mt-1 landscape:mt-0.5 px-1 flex justify-start">
        <div className="flex items-center gap-0.5 rounded-2xl bg-black/20 pl-2.5 pr-1 py-1 landscape:py-0.5">
          <span className={`text-[9px] font-bold ${c.sub} tracking-widest mr-1`}>TO</span>
          {Array.from({ length: fb.timeoutCount }).map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={(e) => { e.stopPropagation(); i < remaining ? useTimeout(team) : restoreTimeout(team); }}
              className={`btn-press flex items-center justify-center w-8 h-8 landscape:w-6 landscape:h-6 shrink-0 ${!canPeriod ? 'opacity-40' : ''}`}
            >
              <span className={`block w-4 h-4 landscape:w-3 landscape:h-3 rounded-full border ${i < remaining ? dotFill : `${dotEmpty} bg-transparent`}`} />
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="px-5 pt-6 pb-8 landscape:px-3 landscape:pt-2 landscape:pb-2 max-w-md landscape:max-w-none mx-auto flex flex-col min-h-[100dvh] landscape:min-h-dvh">
      <EndGamePill onClick={() => setEndGameOpen(true)} />
      <Header title="Football" onBack={onBack} onSettings={() => setSettingsOpen(true)} extra={<ConsultSlot roomSession={roomSession} consult={consult} sport="football" teamAName={displayTeamName(fb.teamA, 'A')} teamBName={displayTeamName(fb.teamB, 'B')} teamAColor={fb.colorA} teamBColor={fb.colorB} />} />
      <TimerBar globalTimer={globalTimer} locked={!canTimer} />

      <div className="flex flex-col landscape:flex-row gap-3 landscape:gap-2 flex-1 mb-4 landscape:mb-2 landscape:min-h-0" style={{ minHeight: '48vh' }}>
        <ScoreHalf
          name={displayTeamName(fb.teamA, 'A')}
          score={fb.scoreA}
          onScore={() => addPoint('A')}
          onUndo={() => undo('A')}
          scoreClassName="text-7xl"
          footer={<TimeoutFooter team="A" />}
          color={fb.colorA}
          hostLocked={!canScore}
        />
        <ScoreHalf
          name={displayTeamName(fb.teamB, 'B')}
          score={fb.scoreB}
          onScore={() => addPoint('B')}
          onUndo={() => undo('B')}
          scoreClassName="text-7xl"
          footer={<TimeoutFooter team="B" />}
          color={fb.colorB}
          hostLocked={!canScore}
        />
      </div>

      <div className="rounded-2xl bg-zinc-900 border border-white/10 py-4 landscape:py-2 px-5 flex items-center justify-between shrink-0">
        <IconButton name="ChevronLeft" onClick={() => { if (!canPeriod) { vibrate(15); return; } changeHalf(-1); }} label="Previous half" />
        <div className="text-center">
          <div className="text-xs font-extrabold tracking-widest text-white/40">HALF</div>
          <div className="text-3xl landscape:text-xl font-black tabular">
            {fb.half}
            <span className="text-white/30 text-lg">/2</span>
          </div>
        </div>
        <IconButton name="ChevronRight" onClick={() => { if (!canPeriod) { vibrate(15); return; } changeHalf(1); }} label="Next half" />
      </div>

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Football Settings">
        <TeamPicker
          label="Team A"
          teamName={fb.teamA}
          teamColor={fb.colorA}
          onSelect={(t) => setFb((s) => ({ ...s, teamA: t.label, colorA: t.color }))}
          onCustomName={(v) => setFb((s) => ({ ...s, teamA: v }))}
          onCustomColor={(c) => setFb((s) => ({ ...s, colorA: c }))}
        />
        <TeamPicker
          label="Team B"
          teamName={fb.teamB}
          teamColor={fb.colorB}
          onSelect={(t) => setFb((s) => ({ ...s, teamB: t.label, colorB: t.color }))}
          onCustomName={(v) => setFb((s) => ({ ...s, teamB: v }))}
          onCustomColor={(c) => setFb((s) => ({ ...s, colorB: c }))}
        />
        <Field label="Timeouts Reset">
          <Segmented
            options={[{ value: 'half', label: 'Per Half' }, { value: 'game', label: 'Per Game' }]}
            value={fb.timeoutMode}
            onChange={(v) => setFb((s) => ({ ...s, timeoutMode: v }))}
          />
        </Field>
        <Field label="Timeouts per team">
          <Stepper
            value={fb.timeoutCount}
            min={1}
            max={6}
            onChange={(v) => setFb((s) => ({ ...s, timeoutCount: v, timeoutsA: v, timeoutsB: v }))}
          />
        </Field>
        <BigButton
          onClick={() => { if (!canScore) { vibrate(15); return; } setFb(defaultFootball()); }}
          className="w-full rounded-2xl bg-red-500/15 border border-red-500/40 py-4 font-bold text-red-400 mt-2 mb-3"
        >
          {!canScore && <Icon name="Lock" size={14} className="inline mr-1.5 -mt-0.5" />}Reset Game
        </BigButton>
        <MultiRefSyncButton roomSession={roomSession} permissions={permissions} />
        <BigButton onClick={() => setSettingsOpen(false)} className="w-full rounded-2xl bg-emerald-400 text-black py-4 font-extrabold text-lg">
          Done
        </BigButton>
      </Sheet>

      <EndGameSheet
        open={endGameOpen}
        onClose={() => setEndGameOpen(false)}
        sportLabel="Football"
        teamA={fb.teamA}
        teamB={fb.teamB}
        scoreA={fb.scoreA}
        scoreB={fb.scoreB}
        globalTimer={globalTimer}
        onReset={() => setFb(defaultFootball())}
      />
    </div>
  );
}

/* ============================== UNIVERSAL TRACKER ============================== */

const UNIVERSAL_CONFIG = {
  soccer: { title: 'Soccer', unit: 'Half', maxUnit: 2, icon: '⚽', accent: 'emerald-400' },
  hockey: { title: 'Hockey', unit: 'Period', maxUnit: 3, icon: '🏒', accent: 'sky-400' },
  baseball: { title: 'Baseball', unit: 'Inning', maxUnit: 9, icon: '⚾', accent: 'red-400' },
};

function defaultUniversal() {
  return { teamA: '', teamB: '', scoreA: 0, scoreB: 0, colorA: null, colorB: null, period: 1, half: 'Top', topTeam: 'A', balls: 0, strikes: 0, outs: 0, hockeyFormat: getAppSettings().hockeyDefaultFormat || 'periods' };
}

function hockeyMaxUnit(hockeyFormat) {
  return hockeyFormat === 'halves' ? 2 : 3;
}

const AT_BAT_BANNER_STYLES = {
  'WALK!': 'bg-emerald-400 text-black',
  'STRIKE OUT!': 'bg-yellow-400 text-black',
  'SIDE RETIRED!': 'bg-red-500 text-white',
};

function advanceHalfInning(s) {
  if (s.half === 'Top') return { ...s, half: 'Bottom' };
  return { ...s, half: 'Top', period: s.period + 1 };
}

function Universal({ sport, globalTimer, onBack, roomSession, permissions, consult }) {
  const cfg = UNIVERSAL_CONFIG[sport];
  const key = `refcourt_${sport}_v1`;
  const [g, setG] = useLocalStorage(key, defaultUniversal());
  const canScore = permissions.canControl('score');
  const canPossession = permissions.canControl('possession');
  const canTimer = permissions.canControl('timer');
  const canPeriod = permissions.canControl('period');
  // Merge synced data onto defaultUniversal() — see useGlobalTimer for why.
  const setGSynced = useCallback((v) => setG((s) => ({ ...defaultUniversal(), ...v })), [setG]);
  useRoomSync(roomSession.roomCode, sport, g, setGSynced);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [endGameOpen, setEndGameOpen] = useState(false);

  const addPoint = (team) => {
    if (!canScore) { vibrate(15); return; }
    setG((s) => ({ ...s, [team === 'A' ? 'scoreA' : 'scoreB']: (team === 'A' ? s.scoreA : s.scoreB) + 1 }));
    vibrate(30);
  };
  const undo = (team) => {
    if (!canScore) { vibrate(15); return; }
    setG((s) => ({ ...s, [team === 'A' ? 'scoreA' : 'scoreB']: Math.max(0, (team === 'A' ? s.scoreA : s.scoreB) - 1) }));
  };

  // Not gated by canPeriod itself — also called by the timer-finished
  // auto-advance effect below (see Football's changeHalf for why). The
  // chevron buttons that let a ref manually change periods check canPeriod
  // before calling this.
  const changePeriod = (delta) => {
    setG((s) => {
      const next = s.period + delta;
      const currentMax = sport === 'hockey' ? hockeyMaxUnit(s.hockeyFormat) : cfg.maxUnit;
      const clamped = (sport === 'soccer' || sport === 'hockey') ? Math.min(currentMax, Math.max(1, next)) : Math.max(1, next);
      return { ...s, period: clamped };
    });
  };

  // Auto-advance to the next period/half the moment the game clock hits 00:00
  // (baseball tracks innings independently of the clock, so it's excluded).
  // Seed with the timer's current state (not a hardcoded false) — otherwise
  // mounting on a screen while the shared clock is already left over
  // "finished" from a different game reads as "it just finished here" and
  // spuriously auto-advances this sport's own half/period counter by one.
  const timerJustFinishedRef = useRef(globalTimer.timer.finished);
  useEffect(() => {
    if (sport !== 'hockey' && sport !== 'soccer') return;
    const finished = globalTimer.timer.finished;
    if (finished && !timerJustFinishedRef.current) {
      changePeriod(1);
    }
    timerJustFinishedRef.current = finished;
  }, [globalTimer.timer.finished, sport]);

  const toggleHalf = () => {
    if (!canPossession) { vibrate(15); return; }
    setG((s) => ({ ...s, half: s.half === 'Top' ? 'Bottom' : 'Top' }));
  };
  const swapTopBottom = () => {
    if (!canPossession) { vibrate(15); return; }
    setG((s) => ({ ...s, topTeam: s.topTeam === 'A' ? 'B' : 'A' }));
  };

  const topTeam = g.topTeam || 'A';
  const battingTeam = g.half === 'Top' ? topTeam : (topTeam === 'A' ? 'B' : 'A');
  const battingTeamName = displayTeamName(battingTeam === 'A' ? g.teamA : g.teamB, battingTeam);

  const [bannerQueue, setBannerQueue] = useState([]);
  const [banner, setBanner] = useState(null);
  const pushBanner = (text) => setBannerQueue((q) => [...q, text]);

  useEffect(() => {
    if (!banner && bannerQueue.length > 0) {
      setBanner(bannerQueue[0]);
      setBannerQueue((q) => q.slice(1));
    }
  }, [banner, bannerQueue]);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 1500);
    return () => clearTimeout(t);
  }, [banner]);

  const addBall = () => {
    if (!canScore) { vibrate(15); return; }
    vibrate(20);
    setG((s) => {
      const balls = (s.balls || 0) + 1;
      if (balls >= 4) {
        pushBanner('WALK!');
        return { ...s, balls: 0, strikes: 0 };
      }
      return { ...s, balls };
    });
  };

  const addStrike = () => {
    if (!canScore) { vibrate(15); return; }
    vibrate(20);
    setG((s) => {
      const strikes = (s.strikes || 0) + 1;
      if (strikes >= 3) {
        pushBanner('STRIKE OUT!');
        const outs = (s.outs || 0) + 1;
        if (outs >= 3) {
          pushBanner('SIDE RETIRED!');
          return advanceHalfInning({ ...s, balls: 0, strikes: 0, outs: 0 });
        }
        return { ...s, balls: 0, strikes: 0, outs };
      }
      return { ...s, strikes };
    });
  };

  const addOut = () => {
    if (!canScore) { vibrate(15); return; }
    vibrate(20);
    setG((s) => {
      const outs = (s.outs || 0) + 1;
      if (outs >= 3) {
        pushBanner('SIDE RETIRED!');
        return advanceHalfInning({ ...s, balls: 0, strikes: 0, outs: 0 });
      }
      return { ...s, balls: 0, strikes: 0, outs };
    });
  };

  const removeOut = () => {
    if (!canScore) { vibrate(15); return; }
    vibrate(20);
    setG((s) => ({ ...s, outs: Math.max(0, (s.outs || 0) - 1) }));
  };

  const resetCount = () => {
    if (!canScore) { vibrate(15); return; }
    setG((s) => ({ ...s, balls: 0, strikes: 0 }));
  };

  const periodUnit = sport === 'hockey' && g.hockeyFormat === 'halves' ? 'Half' : cfg.unit;
  const periodMaxUnit = sport === 'hockey' ? hockeyMaxUnit(g.hockeyFormat) : cfg.maxUnit;

  return (
    <div className="px-5 pt-6 pb-8 landscape:px-3 landscape:pt-2 landscape:pb-2 max-w-md landscape:max-w-none mx-auto flex flex-col min-h-[100dvh] landscape:min-h-dvh">
      {banner && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 pointer-events-none">
          <div className={`pop-in rounded-3xl px-10 landscape:px-6 py-8 landscape:py-4 text-4xl landscape:text-2xl font-black tracking-wide text-center shadow-2xl ${AT_BAT_BANNER_STYLES[banner] || 'bg-white text-black'}`}>
            {banner}
          </div>
        </div>
      )}
      <EndGamePill onClick={() => setEndGameOpen(true)} />
      <Header title={cfg.title} onBack={onBack} onSettings={() => setSettingsOpen(true)} extra={<ConsultSlot roomSession={roomSession} consult={consult} sport={sport} teamAName={displayTeamName(g.teamA, 'A')} teamBName={displayTeamName(g.teamB, 'B')} />} />
      {sport !== 'baseball' && <TimerBar globalTimer={globalTimer} periodCount={periodMaxUnit} unitLabel={periodUnit} locked={!canTimer} />}

      <div className="flex flex-col landscape:flex-row gap-3 landscape:gap-2 flex-1 mb-4 landscape:mb-2 landscape:min-h-0" style={{ minHeight: '48vh' }}>
        <ScoreHalf
          name={displayTeamName(g.teamA, 'A')}
          score={g.scoreA}
          onScore={() => addPoint('A')}
          onUndo={() => undo('A')}
          color={g.colorA}
          locked={sport === 'baseball' && battingTeam !== 'A'}
          hostLocked={!canScore}
        />
        <ScoreHalf
          name={displayTeamName(g.teamB, 'B')}
          score={g.scoreB}
          onScore={() => addPoint('B')}
          onUndo={() => undo('B')}
          color={g.colorB}
          locked={sport === 'baseball' && battingTeam !== 'B'}
          hostLocked={!canScore}
        />
      </div>

      <div className="rounded-2xl bg-zinc-900 border border-white/10 py-4 landscape:py-2 px-5 flex items-center justify-between shrink-0">
        <IconButton name="ChevronLeft" onClick={() => { if (!canPeriod) { vibrate(15); return; } changePeriod(-1); }} label="Previous period" />
        <div className="text-center">
          <div className="text-xs font-extrabold tracking-widest text-white/40">{periodUnit.toUpperCase()}</div>
          <div className="text-3xl landscape:text-xl font-black tabular">
            {g.period}
            <span className="text-white/30 text-lg">/{periodMaxUnit}</span>
          </div>
        </div>
        <IconButton name="ChevronRight" onClick={() => { if (!canPeriod) { vibrate(15); return; } changePeriod(1); }} label="Next period" />
      </div>

      {sport === 'baseball' && (
        <button
          onClick={toggleHalf}
          className={`btn-press w-full mt-3 landscape:mt-1.5 rounded-2xl bg-zinc-900 border-2 border-white/10 py-5 landscape:py-2 px-5 flex items-center justify-center gap-2 active:bg-white/10 shrink-0 ${!canPossession ? 'opacity-50' : ''}`}
        >
          <Icon name={canPossession ? 'ArrowLeftRight' : 'Lock'} size={20} className="text-white/40" />
          <span className="text-lg landscape:text-sm font-extrabold tracking-wide">
            {g.half.toUpperCase()} &middot; {battingTeamName} BATTING
          </span>
        </button>
      )}

      {sport === 'baseball' && (
        <div className="rounded-2xl bg-zinc-900 border border-white/10 py-4 landscape:py-2 px-4 mt-3 landscape:mt-1.5 shrink-0">
          <div className="grid grid-cols-3 gap-2 mb-4 landscape:mb-2">
            {[
              { key: 'balls', label: 'BALLS (B)', count: g.balls || 0, max: 4, dot: 'bg-emerald-400 border-emerald-400' },
              { key: 'strikes', label: 'STRIKES (S)', count: g.strikes || 0, max: 3, dot: 'bg-yellow-400 border-yellow-400' },
              { key: 'outs', label: 'OUTS (O)', count: g.outs || 0, max: 3, dot: 'bg-red-500 border-red-500' },
            ].map((c) => (
              <div key={c.key} className="flex flex-col items-center gap-2 landscape:gap-1">
                <div className="text-[9px] font-extrabold tracking-widest text-white/40 text-center">{c.label}</div>
                <div className="flex gap-1.5 landscape:gap-1">
                  {Array.from({ length: c.max }).map((_, i) => (
                    <div key={i} className={`w-4 h-4 landscape:w-3 landscape:h-3 rounded-full border-2 ${i < c.count ? c.dot : 'border-white/25 bg-transparent'}`} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className={`grid grid-cols-3 gap-2 mb-2 landscape:mb-1.5 ${!canScore ? 'opacity-40' : ''}`}>
            <BigButton onClick={addBall} className="rounded-2xl bg-emerald-400/15 border-2 border-emerald-400/40 text-emerald-400 py-5 landscape:py-2.5 font-extrabold text-sm">
              +BALL
            </BigButton>
            <BigButton onClick={addStrike} className="rounded-2xl bg-yellow-400/15 border-2 border-yellow-400/40 text-yellow-400 py-5 landscape:py-2.5 font-extrabold text-sm">
              +STRIKE
            </BigButton>
            <div className="grid grid-cols-2 gap-1">
              <BigButton onClick={removeOut} className="rounded-2xl bg-red-500/15 border-2 border-red-500/40 text-red-400 py-5 landscape:py-2.5 font-extrabold text-sm flex items-center justify-center">
                <Icon name="Minus" size={16} />
              </BigButton>
              <BigButton onClick={addOut} className="rounded-2xl bg-red-500/15 border-2 border-red-500/40 text-red-400 py-5 landscape:py-2.5 font-extrabold text-sm">
                +OUT
              </BigButton>
            </div>
          </div>

          <BigButton
            onClick={resetCount}
            className="w-full rounded-xl bg-white/5 border border-white/10 py-2.5 landscape:py-1.5 text-white/40 font-bold text-xs flex items-center justify-center gap-1.5"
          >
            <Icon name="RotateCcw" size={12} /> RESET COUNT
          </BigButton>
        </div>
      )}

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title={`${cfg.title} Settings`}>
        <TeamPicker
          label="Team A"
          teamName={g.teamA}
          teamColor={g.colorA}
          onSelect={(t) => setG((s) => ({ ...s, teamA: t.label, colorA: t.color }))}
          onCustomName={(v) => setG((s) => ({ ...s, teamA: v }))}
          onCustomColor={(c) => setG((s) => ({ ...s, colorA: c }))}
        />
        <TeamPicker
          label="Team B"
          teamName={g.teamB}
          teamColor={g.colorB}
          onSelect={(t) => setG((s) => ({ ...s, teamB: t.label, colorB: t.color }))}
          onCustomName={(v) => setG((s) => ({ ...s, teamB: v }))}
          onCustomColor={(c) => setG((s) => ({ ...s, colorB: c }))}
        />
        {sport === 'hockey' && (
          <Field label="Format">
            <Segmented
              options={[{ value: 'periods', label: 'Periods (3)' }, { value: 'halves', label: 'Halves (2)' }]}
              value={g.hockeyFormat || 'periods'}
              onChange={(v) => setG((s) => ({ ...s, hockeyFormat: v, period: 1 }))}
            />
          </Field>
        )}
        {sport === 'baseball' && (
          <BigButton
            onClick={swapTopBottom}
            className={`w-full rounded-2xl bg-white/10 py-4 font-bold text-white mt-2 mb-3 flex items-center justify-center gap-2 ${!canPossession ? 'opacity-40' : ''}`}
          >
            <Icon name={canPossession ? 'ArrowLeftRight' : 'Lock'} size={18} /> Swap Top/Bottom Teams
          </BigButton>
        )}
        <BigButton
          onClick={() => { if (!canScore) { vibrate(15); return; } setG(defaultUniversal()); }}
          className="w-full rounded-2xl bg-red-500/15 border border-red-500/40 py-4 font-bold text-red-400 mt-2 mb-3"
        >
          {!canScore && <Icon name="Lock" size={14} className="inline mr-1.5 -mt-0.5" />}Reset Game
        </BigButton>
        <MultiRefSyncButton roomSession={roomSession} permissions={permissions} />
        <BigButton onClick={() => setSettingsOpen(false)} className="w-full rounded-2xl bg-emerald-400 text-black py-4 font-extrabold text-lg">
          Done
        </BigButton>
      </Sheet>

      <EndGameSheet
        open={endGameOpen}
        onClose={() => setEndGameOpen(false)}
        sportLabel={cfg.title}
        teamA={g.teamA}
        teamB={g.teamB}
        scoreA={g.scoreA}
        scoreB={g.scoreB}
        globalTimer={globalTimer}
        onReset={() => setG(defaultUniversal())}
      />
    </div>
  );
}

/* ============================== BASKETBALL ============================== */

const BK_KEY = 'refcourt_basketball_v1';

function defaultBasketball() {
  return { teamA: '', teamB: '', scoreA: 0, scoreB: 0, colorA: null, colorB: null, half: 1, periodMode: getAppSettings().basketballDefaultFormat || 'halves', history: [], foulsA: 0, foulsB: 0 };
}

function basketballPeriodLabel(bk) {
  const quarters = ['1st', '2nd', '3rd', '4th'];
  const halves = ['1st Half', '2nd Half'];
  if (bk.periodMode === 'quarters') {
    return `${quarters[bk.half - 1] || bk.half + 'th'} Quarter`;
  }
  return halves[bk.half - 1] || `Half ${bk.half}`;
}

function HistoryLogRow({ h, hc, hname, whenLabel, onDismiss }) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const stateRef = useRef(null);

  const onPointerDown = (e) => {
    stateRef.current = { startX: e.clientX, startY: e.clientY, axis: null };
  };
  const onPointerMove = (e) => {
    const st = stateRef.current;
    if (!st) return;
    const ddx = e.clientX - st.startX;
    const ddy = e.clientY - st.startY;
    if (!st.axis) {
      if (Math.abs(ddx) < 8 && Math.abs(ddy) < 8) return;
      st.axis = Math.abs(ddx) > Math.abs(ddy) ? 'x' : 'y';
      if (st.axis === 'x') {
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      }
    }
    if (st.axis !== 'x') return;
    e.stopPropagation();
    setDx(ddx);
  };
  const onPointerUp = (e) => {
    const st = stateRef.current;
    stateRef.current = null;
    if (st && st.axis === 'x') {
      e.stopPropagation();
      if (Math.abs(dx) > 70) {
        setDragging(false);
        setDx(dx > 0 ? 600 : -600);
        setTimeout(onDismiss, 180);
        return;
      }
    }
    setDragging(false);
    setDx(0);
  };

  return (
    <div
      className="relative mb-1 last:mb-0 touch-pan-y"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className={`flex items-center gap-2 py-2 px-2 rounded-lg border-l-4 ${hc.border} ${hc.bg}/15 bg-zinc-900`}
        style={{
          transform: `translateX(${dx}px)`,
          opacity: Math.max(0, 1 - Math.abs(dx) / 140),
          transition: dragging ? 'none' : 'transform 0.18s ease, opacity 0.18s ease',
        }}
      >
        <span className={`w-3 h-3 rounded-full shrink-0 ${hc.bg} border border-white/20`} />
        <span className="text-xs font-semibold flex-1 truncate">{hname}</span>
        <span className="text-xs font-extrabold">+{h.pts}</span>
        <span className="text-[10px] text-white/40 tabular shrink-0">{whenLabel}</span>
      </div>
    </div>
  );
}

function BasketballHistoryPanel({ open, onClose, history, bk, onDismissEntry }) {
  const [dragY, setDragY] = useState(0);
  const draggingRef = useRef(false);
  const startYRef = useRef(0);

  if (!open) return null;

  const onPointerDown = (e) => {
    draggingRef.current = true;
    startYRef.current = e.clientY;
  };
  const onPointerMove = (e) => {
    if (!draggingRef.current) return;
    setDragY(Math.min(0, e.clientY - startYRef.current));
  };
  const endDrag = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (dragY < -36) onClose();
    setDragY(0);
  };

  return (
    <div className="fixed inset-x-0 top-20 z-50 flex justify-center px-5 pointer-events-none">
      <div
        className="pop-in pointer-events-auto w-full max-w-sm rounded-2xl bg-zinc-900 border border-white/20 shadow-2xl p-3"
        style={{ transform: `translateY(${dragY}px)`, transition: draggingRef.current ? 'none' : 'transform 0.2s ease' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-white/20" />
        <div className="flex items-center justify-between mb-2 px-1">
          <div className="text-[10px] font-extrabold tracking-widest text-white/40">RECENT SCORING</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close history"
            className="btn-press w-6 h-6 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center text-white/50 shrink-0"
          >
            <Icon name="X" size={12} />
          </button>
        </div>
        {history.length === 0 ? (
          <div className="text-white/30 text-xs px-1 py-2">No scores yet</div>
        ) : (
          [...history].slice(-5).reverse().map((h, i) => {
            const hc = teamColorClasses(h.team === 'A' ? bk.colorA : bk.colorB);
            const hname = displayTeamName(h.team === 'A' ? bk.teamA : bk.teamB, h.team);
            const whenLabel = h.clockLabel ? `${h.clockLabel} · ${h.periodLabel}` : (h.periodLabel || '—');
            return (
              <HistoryLogRow
                key={i}
                h={h}
                hc={hc}
                hname={hname}
                whenLabel={whenLabel}
                onDismiss={() => onDismissEntry(h)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function Basketball({ globalTimer, onBack, roomSession, permissions, consult }) {
  const [bk, setBk] = useLocalStorage(BK_KEY, defaultBasketball());
  const canScore = permissions.canControl('score');
  const canTimer = permissions.canControl('timer');
  const canPeriod = permissions.canControl('period');
  // Merge synced data onto defaultBasketball() — see useGlobalTimer for why.
  const setBkSynced = useCallback((v) => setBk((s) => ({ ...defaultBasketball(), ...v })), [setBk]);
  useRoomSync(roomSession.roomCode, 'basketball', bk, setBkSynced);
  const [appSettings] = useLocalStorage(APP_SETTINGS_KEY, defaultAppSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [endGameOpen, setEndGameOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    if (!historyOpen) return;
    const t = setTimeout(() => setHistoryOpen(false), 6000);
    return () => clearTimeout(t);
  }, [historyOpen]);

  const addScore = (team, pts) => {
    if (!canScore) { vibrate(15); return; }
    const periodLabel = basketballPeriodLabel(bk);
    const clockLabel = globalTimer && globalTimer.timer.configured && !globalTimer.timer.finished
      ? formatClock(globalTimer.remainingMs / 1000)
      : null;
    setBk((s) => ({
      ...s,
      [team === 'A' ? 'scoreA' : 'scoreB']: (team === 'A' ? s.scoreA : s.scoreB) + pts,
      history: [...s.history, { team, pts, clockLabel, periodLabel }].slice(-30),
    }));
    vibrate(30);
  };

  const adjustFouls = (team, delta) => {
    if (!canScore) { vibrate(15); return; }
    setBk((s) => ({ ...s, [team === 'A' ? 'foulsA' : 'foulsB']: Math.max(0, (team === 'A' ? s.foulsA : s.foulsB) + delta) }));
  };

  const undoLast = () => {
    if (!canScore) { vibrate(15); return; }
    setBk((s) => {
      if (s.history.length === 0) return s;
      const last = s.history[s.history.length - 1];
      return {
        ...s,
        [last.team === 'A' ? 'scoreA' : 'scoreB']: Math.max(0, (last.team === 'A' ? s.scoreA : s.scoreB) - last.pts),
        history: s.history.slice(0, -1),
      };
    });
  };

  const dismissHistoryEntry = (entry) => {
    if (!canScore) { vibrate(15); return; }
    setBk((s) => ({ ...s, history: s.history.filter((e) => e !== entry) }));
  };

  const setHalf = (half) => {
    if (!canPeriod) { vibrate(15); return; }
    setBk((s) => ({ ...s, half }));
  };

  // Not gated by canScore itself — also called by the timer-finished
  // auto-advance effect below (see Football's changeHalf for why).
  const advanceHalf = () => setBk((s) => {
    const max = s.periodMode === 'quarters' ? 4 : 2;
    return { ...s, half: Math.min(max, s.half + 1) };
  });

  // Auto-advance to the next half/quarter the moment the game clock hits 00:00.
  // Seed with the timer's current state (not a hardcoded false) — otherwise
  // mounting on a screen while the shared clock is already left over
  // "finished" from a different game reads as "it just finished here" and
  // spuriously auto-advances this sport's own half/period counter by one.
  const timerJustFinishedRef = useRef(globalTimer.timer.finished);
  useEffect(() => {
    const finished = globalTimer.timer.finished;
    if (finished && !timerJustFinishedRef.current) {
      advanceHalf();
    }
    timerJustFinishedRef.current = finished;
  }, [globalTimer.timer.finished]);

  // Corrects this team's score by reversing their most recent logged shot
  // (not necessarily the overall last shot — the other team may have scored
  // since). Falls back to a flat -1 only if there's no logged shot for this
  // team to reverse, so it can never drift out of sync with the shot log
  // undoLast() reads — otherwise "Undo Last Score" would go on to reverse a
  // shot this button already reversed, double-subtracting.
  const undo = (team) => {
    if (!canScore) { vibrate(15); return; }
    setBk((s) => {
      const scoreKey = team === 'A' ? 'scoreA' : 'scoreB';
      const lastIdx = s.history.map((h) => h.team).lastIndexOf(team);
      if (lastIdx === -1) {
        return { ...s, [scoreKey]: Math.max(0, s[scoreKey] - 1) };
      }
      const entry = s.history[lastIdx];
      return {
        ...s,
        [scoreKey]: Math.max(0, s[scoreKey] - entry.pts),
        history: s.history.filter((_, i) => i !== lastIdx),
      };
    });
  };

  const lastAction = bk.history[bk.history.length - 1];

  const TeamSide = ({ team }) => {
    const name = displayTeamName(team === 'A' ? bk.teamA : bk.teamB, team);
    const score = team === 'A' ? bk.scoreA : bk.scoreB;
    const color = team === 'A' ? bk.colorA : bk.colorB;
    const c = teamColorClasses(color);
    return (
      <div className={`relative flex-1 rounded-3xl ${c.bg} border-2 ${c.border} flex flex-col items-center justify-center gap-3 landscape:gap-1.5 py-4 landscape:py-2 px-3 landscape:h-full landscape:min-h-[128px]`}>
        <div
          role="button"
          onClick={() => undo(team)}
          aria-label={`Subtract 1 from ${name}`}
          className={`btn-press absolute top-3 landscape:top-1.5 left-3 w-10 h-10 landscape:w-8 landscape:h-8 rounded-full ${c.overlay} ${c.text} flex items-center justify-center ${!canScore ? 'opacity-40' : ''}`}
        >
          <Icon name="Minus" size={16} />
        </div>
        <div
          role="button"
          onClick={(e) => { e.stopPropagation(); setHistoryOpen(true); }}
          aria-label="Show scoring history"
          className={`btn-press absolute top-3 landscape:top-1.5 right-3 w-10 h-10 landscape:w-8 landscape:h-8 rounded-full ${c.overlay} ${c.text} flex items-center justify-center`}
        >
          <Icon name="Clock" size={16} />
        </div>
        <div className={`text-lg landscape:text-sm font-bold ${c.text} opacity-70 truncate max-w-full`}>{name}</div>
        <div className={`text-7xl landscape:text-5xl font-black tabular ${c.text}`}>{score}</div>
        <div className={`grid grid-cols-3 landscape:flex landscape:flex-row gap-2 landscape:gap-1.5 w-full ${!canScore ? 'opacity-40 saturate-[.4]' : ''}`}>
          <BigButton onClick={() => addScore(team, 1)} className={`relative rounded-2xl ${c.overlay} ${c.text} py-5 landscape:py-3 font-extrabold text-lg landscape:text-base flex-1 flex items-center justify-center`}>
            <span>+1</span>
            <span className={`absolute bottom-1.5 landscape:bottom-0.5 text-[9px] font-bold ${c.sub} tracking-widest`}>FT</span>
          </BigButton>
          <BigButton onClick={() => addScore(team, 2)} className={`rounded-2xl ${c.overlay} ${c.text} py-5 landscape:py-3 font-extrabold text-lg landscape:text-base flex-1 flex items-center justify-center`}>
            +2
          </BigButton>
          <BigButton onClick={() => addScore(team, 3)} className={`rounded-2xl ${c.overlay} ${c.text} border-2 border-white/30 py-5 landscape:py-3 font-extrabold text-lg landscape:text-base flex-1 flex items-center justify-center`}>
            +3
          </BigButton>
        </div>
        {appSettings.basketballFoulsEnabled && (
          <div className="w-full flex items-center justify-between px-1">
            <span className={`text-[10px] font-bold ${c.sub} tracking-widest`}>FOULS</span>
            <div className="flex items-center gap-2">
              <IconButton name="Minus" size={12} onClick={(e) => { e.stopPropagation(); adjustFouls(team, -1); }} label="Remove foul" />
              <span className={`text-sm font-extrabold tabular w-4 text-center ${c.text}`}>{team === 'A' ? bk.foulsA : bk.foulsB}</span>
              <IconButton name="Plus" size={12} onClick={(e) => { e.stopPropagation(); adjustFouls(team, 1); }} label="Add foul" />
            </div>
          </div>
        )}
      </div>
    );
  };

  const periodOptions = bk.periodMode === 'quarters'
    ? [{ value: 1, label: '1st' }, { value: 2, label: '2nd' }, { value: 3, label: '3rd' }, { value: 4, label: '4th' }]
    : [{ value: 1, label: '1st Half' }, { value: 2, label: '2nd Half' }];

  return (
    <div className="px-5 pt-6 pb-8 landscape:px-3 landscape:pt-2 landscape:pb-2 max-w-md landscape:max-w-none mx-auto flex flex-col min-h-[100dvh] landscape:min-h-dvh">
      <EndGamePill onClick={() => setEndGameOpen(true)} />

      <BasketballHistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        history={bk.history}
        onDismissEntry={dismissHistoryEntry}
        bk={bk}
      />

      <Header title="Basketball" onBack={onBack} onSettings={() => setSettingsOpen(true)} extra={<ConsultSlot roomSession={roomSession} consult={consult} sport="basketball" />} />
      <TimerBar
        globalTimer={globalTimer}
        periodCount={bk.periodMode === 'quarters' ? 4 : 2}
        unitLabel={bk.periodMode === 'quarters' ? 'Quarter' : 'Half'}
        locked={!canTimer}
      />

      <div className="flex flex-col landscape:flex-row gap-3 landscape:gap-2 flex-1 mb-4 landscape:mb-2 landscape:min-h-0">
        <TeamSide team="A" />
        <TeamSide team="B" />
      </div>

      <div className="rounded-2xl bg-zinc-900 border border-white/10 py-4 landscape:py-2 px-5 mb-3 landscape:mb-1.5 shrink-0">
        <div className="text-xs font-extrabold tracking-widest text-white/40 text-center mb-2 landscape:mb-1">
          {bk.periodMode === 'quarters' ? 'QUARTER' : 'HALF'}
        </div>
        <Segmented options={periodOptions} value={bk.half} onChange={setHalf} />
      </div>

      <BigButton
        onClick={undoLast}
        disabled={!lastAction}
        className="w-full rounded-2xl bg-white/10 py-4 landscape:py-2 font-bold text-white/80 flex items-center justify-center gap-2 shrink-0"
      >
        <Icon name="RotateCcw" size={18} />
        {lastAction ? `Undo +${lastAction.pts} · ${displayTeamName(lastAction.team === 'A' ? bk.teamA : bk.teamB, lastAction.team)}` : 'Undo Last Score'}
      </BigButton>

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Basketball Settings">
        <TeamPicker
          label="Team A"
          teamName={bk.teamA}
          teamColor={bk.colorA}
          onSelect={(t) => setBk((s) => ({ ...s, teamA: t.label, colorA: t.color }))}
          onCustomName={(v) => setBk((s) => ({ ...s, teamA: v }))}
          onCustomColor={(c) => setBk((s) => ({ ...s, colorA: c }))}
        />
        <TeamPicker
          label="Team B"
          teamName={bk.teamB}
          teamColor={bk.colorB}
          onSelect={(t) => setBk((s) => ({ ...s, teamB: t.label, colorB: t.color }))}
          onCustomName={(v) => setBk((s) => ({ ...s, teamB: v }))}
          onCustomColor={(c) => setBk((s) => ({ ...s, colorB: c }))}
        />
        <Field label="Periods">
          <Segmented
            options={[{ value: 'halves', label: 'Halves' }, { value: 'quarters', label: 'Quarters' }]}
            value={bk.periodMode}
            onChange={(v) => setBk((s) => ({ ...s, periodMode: v, half: 1 }))}
          />
        </Field>
        <BigButton
          onClick={() => { if (!canScore) { vibrate(15); return; } setBk(defaultBasketball()); }}
          className="w-full rounded-2xl bg-red-500/15 border border-red-500/40 py-4 font-bold text-red-400 mt-2 mb-3"
        >
          {!canScore && <Icon name="Lock" size={14} className="inline mr-1.5 -mt-0.5" />}Reset Game
        </BigButton>
        <MultiRefSyncButton roomSession={roomSession} permissions={permissions} />
        <BigButton onClick={() => setSettingsOpen(false)} className="w-full rounded-2xl bg-emerald-400 text-black py-4 font-extrabold text-lg">
          Done
        </BigButton>
      </Sheet>

      <EndGameSheet
        open={endGameOpen}
        onClose={() => setEndGameOpen(false)}
        sportLabel="Basketball"
        teamA={bk.teamA}
        teamB={bk.teamB}
        scoreA={bk.scoreA}
        scoreB={bk.scoreB}
        globalTimer={globalTimer}
        onReset={() => setBk(defaultBasketball())}
      />
    </div>
  );
}

/* ============================== SPLASH ============================== */

function SplashScreen({ onDone }) {
  const doneRef = useRef(false);
  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  }, [onDone]);

  useEffect(() => {
    const t = setTimeout(finish, 1000);
    return () => clearTimeout(t);
  }, [finish]);

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black overflow-hidden splash-overlay flex flex-col items-center justify-center"
      onClick={finish}
      onTouchStart={finish}
      role="button"
      aria-label="Skip intro animation"
    >
      <img src="./icon-512.png" alt="" className="w-32 h-32 rounded-3xl" />
    </div>
  );
}

/* ============================== APP ============================== */

// Guards against a bad screen render leaving the whole app permanently
// blank — most likely trigger is Multi-Ref Sync adopting a shape it
// doesn't recognize (e.g. a peer on a stale cached build). Keyed by
// `screen` in App() below so navigating back to Home clears the error.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] caught:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="h-dvh flex flex-col items-center justify-center gap-4 bg-black text-white px-6 text-center">
          <div className="text-lg font-extrabold">Something went wrong</div>
          <p className="text-white/50 text-sm max-w-xs">
            {String((this.state.error && this.state.error.message) || this.state.error)}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn-press rounded-xl bg-emerald-400 text-black px-6 py-3 font-extrabold"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [screen, setScreen] = useLocalStorage('refcourt_screen_v1', 'home');
  const roomSession = useRoomSession();
  const globalTimer = useGlobalTimer(roomSession.roomCode);
  const permissions = useRoomPermissions(roomSession.roomCode, roomSession.role, roomSession.clientId);
  const consult = useConsult(roomSession.roomCode, roomSession.clientId, roomSession.role);
  const [settings, setSettings] = useAppSettings();

  useEffect(() => {
    window.history.replaceState({ screen: 'home' }, '');
    if (screen !== 'home') {
      window.history.pushState({ screen }, '');
    }
  }, []);

  useEffect(() => {
    const onPopState = (e) => {
      setScreen((e.state && e.state.screen) || 'home');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [setScreen]);

  // Auto-join Multi-Ref Sync when the app is opened via a shared
  // ?game=XXXX link — read once on mount, then strip it from the URL so
  // reloading or sharing the plain URL afterward doesn't re-trigger it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gameParam = params.get('game');
    if (gameParam) {
      if (/^\d{4}$/.test(gameParam)) roomSession.joinRoom(gameParam);
      params.delete('game');
      const q = params.toString();
      window.history.replaceState(window.history.state, '', window.location.pathname + (q ? `?${q}` : '') + window.location.hash);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goTo = (s) => {
    setScreen(s);
    window.history.pushState({ screen: s }, '');
  };

  const goHome = () => window.history.back();

  let content;
  if (screen === 'home') content = <Home onSelect={goTo} settings={settings} setSettings={setSettings} roomSession={roomSession} permissions={permissions} />;
  else if (screen === 'volleyball') content = <Volleyball globalTimer={globalTimer} onBack={goHome} roomSession={roomSession} permissions={permissions} consult={consult} />;
  else if (screen === 'football') content = <Football globalTimer={globalTimer} onBack={goHome} roomSession={roomSession} permissions={permissions} consult={consult} />;
  else if (screen === 'basketball') content = <Basketball globalTimer={globalTimer} onBack={goHome} roomSession={roomSession} permissions={permissions} consult={consult} />;
  else if (UNIVERSAL_CONFIG[screen]) content = <Universal sport={screen} globalTimer={globalTimer} onBack={goHome} roomSession={roomSession} permissions={permissions} consult={consult} />;
  else content = <Home onSelect={goTo} settings={settings} setSettings={setSettings} roomSession={roomSession} permissions={permissions} />;

  return (
    <>
      <div className="h-dvh overflow-y-auto overscroll-y-contain">
        <ErrorBoundary key={screen}>{content}</ErrorBoundary>
      </div>
      {isFirebaseConfigured && roomSession.roomCode && (
        <ConsultOverlay consult={consult.consult} respond={consult.respond} nudge={consult.nudge} clientId={roomSession.clientId} />
      )}
      {showSplash && <SplashScreen onDone={() => setShowSplash(false)} />}
    </>
  );
}

export default App;
