// Firebase project config for Multi-Ref Sync. These values are not secret —
// they only identify the Firebase project; actual access control lives in
// the Realtime Database security rules (see the setup checklist in the PR/
// README). Paste your real project's values in below once you've created a
// Firebase project and registered a Web app for it.
export const firebaseConfig = {
  apiKey: 'AIzaSyAP3rw_YVkeYtUzYgkbzQvT-t3XfH7vkPo',
  authDomain: 'ref-app-sync.firebaseapp.com',
  databaseURL: 'https://ref-app-sync-default-rtdb.firebaseio.com',
  projectId: 'ref-app-sync',
  storageBucket: 'ref-app-sync.firebasestorage.app',
  messagingSenderId: '635740385774',
  appId: '1:635740385774:web:967e26b11a9c4a6ba59eff',
};

// True once the placeholder values above have been replaced with a real
// project. Multi-Ref Sync stays hidden/disabled in Settings until then, and
// nothing imports the `firebase` package until it's true.
export const isFirebaseConfigured =
  firebaseConfig.apiKey !== 'YOUR_API_KEY' && !!firebaseConfig.databaseURL;
