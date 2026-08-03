import { useState, useEffect, useRef, useCallback } from 'react';
import { getFirebaseServices } from './firebaseClient.js';
import { getOrCreateClientId } from './roomSession.js';

const EDIT_TS_KEY = 'refcourt_sync_ts_v1';
const PUSH_DEBOUNCE_MS = 150;

function readEditTsMap() {
  try {
    const raw = window.localStorage.getItem(EDIT_TS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function writeEditTs(path, ts) {
  try {
    const map = readEditTsMap();
    map[path] = ts;
    window.localStorage.setItem(EDIT_TS_KEY, JSON.stringify(map));
  } catch (e) {}
}

// Mirrors a useLocalStorage-backed [state, setState] pair to
// rooms/{roomCode}/state/{path} in the Realtime Database. A true no-op
// (no Firebase import, no subscriptions, no extra renders) whenever
// roomCode is falsy, so ordinary offline local play is byte-for-byte
// unchanged when Multi-Ref Sync has never been touched.
//
// Local localStorage stays the instant, authoritative store for this
// device regardless of connectivity — this hook only relays it outward and
// applies newer remote snapshots inward, using a per-path last-edit
// timestamp (persisted so it survives reloads) to decide who's newer.
export function useRoomSync(roomCode, path, state, setState) {
  const clientIdRef = useRef(null);
  if (clientIdRef.current === null) clientIdRef.current = getOrCreateClientId();

  const latestStateRef = useRef(state);
  latestStateRef.current = state;

  const suppressNextPushRef = useRef(false);
  const debounceTimerRef = useRef(null);
  const targetRef = useRef(null); // { dbFns, nodeRef }
  const [ready, setReady] = useState(false);

  const flushNow = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const target = targetRef.current;
    if (!target) return;
    // Firebase's set() throws synchronously on values containing `undefined`
    // and can also reject (e.g. rules/network) — swallow either so a bad
    // local write only skips that sync tick instead of surfacing as an
    // unhandled rejection or crashing the caller.
    try {
      Promise.resolve(
        target.dbFns.set(target.nodeRef, {
          data: latestStateRef.current,
          _origin: clientIdRef.current,
          _ts: Date.now(),
        })
      ).catch((err) => console.warn('[useRoomSync] push failed', err));
    } catch (err) {
      console.warn('[useRoomSync] push failed', err);
    }
  }, []);

  // Subscribe to the room path and seed-or-adopt once on (re)connect: if the
  // remote snapshot is newer than the last edit we made to this path, adopt
  // it; otherwise our local copy is newer (or nothing's there yet), so we
  // reassert it. `ready` gates the push effect below so a debounced push
  // can't race ahead of this initial decision and clobber a fresher remote
  // value before it's had a chance to be adopted.
  useEffect(() => {
    setReady(false);
    if (!roomCode) { targetRef.current = null; return; }
    let cancelled = false;
    let unsub = null;

    (async () => {
      const { db, dbFns } = await getFirebaseServices();
      if (cancelled || !db) return;
      const nodeRef = dbFns.ref(db, `rooms/${roomCode}/state/${path}`);
      targetRef.current = { dbFns, nodeRef };

      const snap = await dbFns.get(nodeRef);
      if (cancelled) return;
      const remote = snap.val();
      const localTs = readEditTsMap()[path] || 0;

      if (remote && typeof remote._ts === 'number' && remote._ts > localTs) {
        suppressNextPushRef.current = true;
        writeEditTs(path, remote._ts);
        setState(remote.data);
      } else {
        writeEditTs(path, Date.now());
        try {
          Promise.resolve(
            dbFns.set(nodeRef, { data: latestStateRef.current, _origin: clientIdRef.current, _ts: Date.now() })
          ).catch((err) => console.warn('[useRoomSync] initial push failed', err));
        } catch (err) {
          console.warn('[useRoomSync] initial push failed', err);
        }
      }

      if (cancelled) return;
      setReady(true);

      unsub = dbFns.onValue(nodeRef, (s) => {
        const val = s.val();
        if (!val || val._origin === clientIdRef.current) return;
        const localTsNow = readEditTsMap()[path] || 0;
        if (typeof val._ts === 'number' && val._ts <= localTsNow) return;
        suppressNextPushRef.current = true;
        writeEditTs(path, val._ts || Date.now());
        setState(val.data);
      });
    })();

    return () => {
      cancelled = true;
      if (unsub) unsub();
      targetRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, path, setState]);

  // Push local changes out, debounced so rapid taps collapse into one
  // write. Skips the echo right after adopting a remote update, and stays
  // silent until `ready` so it never races the initial seed-or-adopt above.
  useEffect(() => {
    if (!roomCode || !ready) return;
    if (suppressNextPushRef.current) { suppressNextPushRef.current = false; return; }

    writeEditTs(path, Date.now());
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      flushNow();
    }, PUSH_DEBOUNCE_MS);
  }, [state, roomCode, path, ready, flushNow]);

  // Flush any pending debounced write on true unmount (e.g. navigating back
  // to Home mid-tap) so the last action before leaving the screen isn't lost.
  useEffect(() => {
    return () => flushNow();
  }, [flushNow]);
}
