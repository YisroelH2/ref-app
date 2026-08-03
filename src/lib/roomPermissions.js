import { useState, useEffect, useCallback } from 'react';
import { getFirebaseServices } from './firebaseClient.js';

const defaultPermissions = () => ({
  hostOnly: false,
  hostId: null,
  locks: { score: false, timer: false, possession: false, period: false },
});

// Host-Only Control state for a room, mirrored from
// rooms/{roomCode}/permissions. Read by every connected device (host and
// guests both subscribe so a guest joining after the host already set locks
// picks up the current state immediately via onValue, not just live
// changes); only the host is allowed to write. There's no server-side rules
// enforcement for that in this app (no database.rules.json is checked into
// the repo) — this is a client-side UI gate, not a security boundary.
export function useRoomPermissions(roomCode, role, hostClientId) {
  const [permissions, setPermissions] = useState(defaultPermissions());

  useEffect(() => {
    if (!roomCode) { setPermissions(defaultPermissions()); return; }
    let cancelled = false;
    let unsub = null;

    (async () => {
      const { db, dbFns } = await getFirebaseServices();
      if (cancelled || !db) return;
      unsub = dbFns.onValue(dbFns.ref(db, `rooms/${roomCode}/permissions`), (snap) => {
        const val = snap.val();
        setPermissions(val
          ? { ...defaultPermissions(), ...val, locks: { ...defaultPermissions().locks, ...(val.locks || {}) } }
          : defaultPermissions());
      });
    })();

    return () => {
      cancelled = true;
      if (unsub) unsub();
      setPermissions(defaultPermissions());
    };
  }, [roomCode]);

  const setHostOnly = useCallback((on) => {
    if (role !== 'host' || !roomCode) return;
    (async () => {
      const { db, dbFns } = await getFirebaseServices();
      if (!db) return;
      try {
        await dbFns.set(dbFns.ref(db, `rooms/${roomCode}/permissions`), {
          hostOnly: on,
          hostId: hostClientId,
          // Turning the master switch on locks every category by default —
          // the host can then selectively unlock individual ones.
          locks: on
            ? { score: true, timer: true, possession: true, period: true }
            : { score: false, timer: false, possession: false, period: false },
        });
      } catch (e) {}
    })();
  }, [role, roomCode, hostClientId]);

  const setLock = useCallback((category, on) => {
    if (role !== 'host' || !roomCode) return;
    (async () => {
      const { db, dbFns } = await getFirebaseServices();
      if (!db) return;
      try {
        await dbFns.set(dbFns.ref(db, `rooms/${roomCode}/permissions/locks/${category}`), on);
      } catch (e) {}
    })();
  }, [role, roomCode]);

  const canControl = useCallback((category) => {
    if (!roomCode) return true;
    if (role === 'host') return true;
    if (!permissions.hostOnly) return true;
    return !permissions.locks[category];
  }, [roomCode, role, permissions]);

  return { permissions, setHostOnly, setLock, canControl };
}
