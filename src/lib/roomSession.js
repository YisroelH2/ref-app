import { useState, useEffect, useCallback } from 'react';
import { useLocalStorage } from './useLocalStorage.js';
import { getFirebaseServices } from './firebaseClient.js';

const CLIENT_ID_KEY = 'refcourt_client_id_v1';
const SESSION_KEY = 'refcourt_room_session_v1';

function randomId() {
  try {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  } catch (e) {}
  return 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

let cachedClientId = null;

// A stable per-device id, independent of any room — used to tell "my own
// write echoing back" apart from "a real remote change" in useRoomSync, and
// recorded on a room as its hostClientId.
export function getOrCreateClientId() {
  if (cachedClientId) return cachedClientId;
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_KEY);
    if (existing) { cachedClientId = existing; return existing; }
  } catch (e) {}
  const id = randomId();
  try { window.localStorage.setItem(CLIENT_ID_KEY, id); } catch (e) {}
  cachedClientId = id;
  return id;
}

export function generateRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

const defaultSession = () => ({ roomCode: null, role: null });

// Owns Multi-Ref Sync's room membership: hosting/joining/leaving a 4-digit
// room, persisted across reloads the same way every other piece of app
// state is (useLocalStorage), plus live connection status for the Settings
// badge. Instantiated once in the root App() and threaded down as a prop —
// this repo has no context/store infra, so that matches how `settings` and
// `globalTimer` are already shared.
export function useRoomSession() {
  const [session, setSession] = useLocalStorage(SESSION_KEY, defaultSession());
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const clientId = getOrCreateClientId();
  const roomCode = session.roomCode;

  // While a room is active: watch that it still exists (so a guest finds
  // out promptly when the host stops hosting) and mirror live connectivity
  // for the "Connected: Room XXXX" badge.
  useEffect(() => {
    if (!roomCode) { setConnected(false); return; }
    let cancelled = false;
    let unsubMeta = null;
    let unsubConn = null;

    (async () => {
      const { db, dbFns } = await getFirebaseServices();
      if (cancelled || !db) return;

      unsubMeta = dbFns.onValue(dbFns.ref(db, `rooms/${roomCode}/meta`), (snap) => {
        if (!snap.exists()) setSession(defaultSession());
      });
      unsubConn = dbFns.onValue(dbFns.ref(db, '.info/connected'), (snap) => setConnected(!!snap.val()));
    })();

    return () => {
      cancelled = true;
      if (unsubMeta) unsubMeta();
      if (unsubConn) unsubConn();
      setConnected(false);
    };
  }, [roomCode, setSession]);

  const hostRoom = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const { db, dbFns } = await getFirebaseServices();
      if (!db) throw new Error('Sync is not set up yet.');
      let code = null;
      for (let attempt = 0; attempt < 8 && !code; attempt++) {
        const candidate = generateRoomCode();
        const snap = await dbFns.get(dbFns.ref(db, `rooms/${candidate}/meta`));
        if (!snap.exists()) code = candidate;
      }
      if (!code) throw new Error('Could not find an open room code — try again.');
      await dbFns.set(dbFns.ref(db, `rooms/${code}/meta`), {
        createdAt: dbFns.serverTimestamp(),
        hostClientId: clientId,
      });
      setSession({ roomCode: code, role: 'host' });
    } catch (e) {
      setError(e.message || 'Could not start hosting.');
    } finally {
      setBusy(false);
    }
  }, [clientId, setSession]);

  const joinRoom = useCallback(async (code) => {
    const clean = String(code || '').trim();
    if (!/^\d{4}$/.test(clean)) { setError('Enter a 4-digit code.'); return; }
    setBusy(true);
    setError('');
    try {
      const { db, dbFns } = await getFirebaseServices();
      if (!db) throw new Error('Sync is not set up yet.');
      const snap = await dbFns.get(dbFns.ref(db, `rooms/${clean}/meta`));
      if (!snap.exists()) throw new Error('Room not found — check the code.');
      setSession({ roomCode: clean, role: 'guest' });
    } catch (e) {
      setError(e.message || 'Could not join that room.');
    } finally {
      setBusy(false);
    }
  }, [setSession]);

  const leaveRoom = useCallback(async () => {
    const leaving = session;
    setSession(defaultSession());
    setError('');
    if (!leaving.roomCode) return;
    try {
      const { db, dbFns } = await getFirebaseServices();
      if (!db) return;
      if (leaving.role === 'host') {
        await dbFns.remove(dbFns.ref(db, `rooms/${leaving.roomCode}`));
      }
    } catch (e) {
      // Already left locally — nothing actionable if the remote cleanup fails.
    }
  }, [session, setSession]);

  return { roomCode, role: session.role, clientId, connected, busy, error, hostRoom, joinRoom, leaveRoom };
}
