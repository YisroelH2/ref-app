import { useState, useEffect, useRef, useCallback } from 'react';
import { getFirebaseServices } from './firebaseClient.js';

function randomConsultId() {
  try {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  } catch (e) {}
  return 'q' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// One broadcast "Quick Consult" question per room, mirrored at
// rooms/{roomCode}/consult. Any connected device can send one (blocked while
// another is already pending, room-wide); every *other* device sees it as an
// incoming overlay; the first response wins and is written back to the same
// node, which is what lets the sender's device show the answer. Any device
// that observes status === 'answered' clears the node ~3s later so the
// popup disappears everywhere without a central coordinator.
export function useConsult(roomCode, clientId, role) {
  const [consult, setConsult] = useState(null);
  const nodeRef = useRef(null);
  const dbFnsRef = useRef(null);
  const clearedIdRef = useRef(null);
  const clearTimerRef = useRef(null);

  useEffect(() => {
    if (!roomCode) { setConsult(null); return; }
    let cancelled = false;
    let unsub = null;

    (async () => {
      const { db, dbFns } = await getFirebaseServices();
      if (cancelled || !db) return;
      const ref = dbFns.ref(db, `rooms/${roomCode}/consult`);
      nodeRef.current = ref;
      dbFnsRef.current = dbFns;
      unsub = dbFns.onValue(ref, (snap) => {
        setConsult(snap.val());
      });
    })();

    return () => {
      cancelled = true;
      if (unsub) unsub();
      nodeRef.current = null;
      dbFnsRef.current = null;
      if (clearTimerRef.current) { clearTimeout(clearTimerRef.current); clearTimerRef.current = null; }
      setConsult(null);
    };
  }, [roomCode]);

  // Any device that sees an answered record clears it ~3s later so both
  // screens' popups dismiss together. Guarded so each record is only
  // scheduled for removal once, even though every connected device runs
  // this same effect independently.
  useEffect(() => {
    if (!consult || consult.status !== 'answered' || !nodeRef.current) return;
    if (clearedIdRef.current === consult.id) return;
    clearedIdRef.current = consult.id;
    clearTimerRef.current = setTimeout(() => {
      const ref = nodeRef.current;
      const dbFns = dbFnsRef.current;
      if (ref && dbFns) dbFns.remove(ref).catch(() => {});
    }, 3000);
    return () => {
      if (clearTimerRef.current) { clearTimeout(clearTimerRef.current); clearTimerRef.current = null; }
    };
  }, [consult]);

  const sendConsult = useCallback((questionType, prompt, options) => {
    if (!roomCode || !nodeRef.current || !dbFnsRef.current) return;
    if (consult && consult.status === 'pending') return; // one active consult per room
    const dbFns = dbFnsRef.current;
    const ref = nodeRef.current;
    const record = {
      id: randomConsultId(),
      questionType,
      prompt,
      options,
      senderId: clientId,
      senderRole: role,
      createdAt: dbFns.serverTimestamp(),
      status: 'pending',
      answer: null,
      responderId: null,
      answeredAt: null,
    };
    dbFns.onDisconnect(ref).remove();
    dbFns.set(ref, record).catch(() => {});
  }, [roomCode, clientId, role, consult]);

  const respond = useCallback((answer) => {
    if (!nodeRef.current || !dbFnsRef.current || !consult) return;
    if (consult.status !== 'pending' || consult.senderId === clientId) return;
    const dbFns = dbFnsRef.current;
    dbFns.update(nodeRef.current, {
      status: 'answered',
      answer,
      responderId: clientId,
      answeredAt: dbFns.serverTimestamp(),
    }).catch(() => {});
  }, [consult, clientId]);

  const sending = !!(consult && consult.status === 'pending' && consult.senderId === clientId);

  return { consult, sendConsult, respond, sending };
}
