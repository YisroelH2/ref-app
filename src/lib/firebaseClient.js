import { firebaseConfig, isFirebaseConfigured } from '../firebaseConfig.js';

// Lazily initializes Firebase and signs in anonymously, importing the SDK
// only on first real use so users who never touch Multi-Ref Sync never pay
// for it in bundle size or startup cost. The result is memoized so every
// caller (host/join actions, every mounted useRoomSync) shares one init.
let servicesPromise = null;

export function getFirebaseServices() {
  if (servicesPromise) return servicesPromise;

  if (!isFirebaseConfigured) {
    servicesPromise = Promise.resolve({ db: null, auth: null, dbFns: null, authFns: null });
    return servicesPromise;
  }

  servicesPromise = (async () => {
    const [{ initializeApp }, dbFns, authFns] = await Promise.all([
      import('firebase/app'),
      import('firebase/database'),
      import('firebase/auth'),
    ]);
    const app = initializeApp(firebaseConfig);
    const db = dbFns.getDatabase(app);
    const auth = authFns.getAuth(app);
    if (!auth.currentUser) {
      await authFns.signInAnonymously(auth);
    }
    return { db, auth, dbFns, authFns };
  })();

  return servicesPromise;
}
