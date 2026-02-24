import { initializeApp, getApp, getApps, type FirebaseOptions } from 'firebase/app'
import { getAnalytics, isSupported } from 'firebase/analytics'
import { getAuth, GoogleAuthProvider, signOut } from 'firebase/auth'
import { getRuntimeSetting } from '../config/environment'

export const firebaseAuthEnabled = (getRuntimeSetting('VITE_FIREBASE_AUTH_ENABLED') || 'false').toLowerCase() === 'true'
export const firebaseAnalyticsEnabled =
  (getRuntimeSetting('VITE_FIREBASE_ANALYTICS_ENABLED') || 'false').toLowerCase() === 'true'

const firebaseConfig: FirebaseOptions = {
  apiKey: getRuntimeSetting('VITE_FIREBASE_API_KEY'),
  authDomain: getRuntimeSetting('VITE_FIREBASE_AUTH_DOMAIN'),
  projectId: getRuntimeSetting('VITE_FIREBASE_PROJECT_ID'),
  storageBucket: getRuntimeSetting('VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: getRuntimeSetting('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  appId: getRuntimeSetting('VITE_FIREBASE_APP_ID'),
  measurementId: getRuntimeSetting('VITE_FIREBASE_MEASUREMENT_ID'),
}

function assertFirebaseConfig(): void {
  if (!firebaseAuthEnabled) {
    return
  }
  const required: Array<[string, string | undefined]> = [
    ['VITE_FIREBASE_API_KEY', firebaseConfig.apiKey],
    ['VITE_FIREBASE_AUTH_DOMAIN', firebaseConfig.authDomain],
    ['VITE_FIREBASE_PROJECT_ID', firebaseConfig.projectId],
    ['VITE_FIREBASE_APP_ID', firebaseConfig.appId],
  ]
  const missing = required.filter(([, value]) => !String(value || '').trim()).map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(`Firebase Auth habilitado, pero faltan variables: ${missing.join(', ')}`)
  }
}

assertFirebaseConfig()

const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig)

export const firebaseAuth = getAuth(firebaseApp)
export const googleAuthProvider = new GoogleAuthProvider()

export async function signOutFirebaseUser(): Promise<void> {
  if (!firebaseAuthEnabled) {
    return
  }
  await signOut(firebaseAuth)
}

if (firebaseAnalyticsEnabled && typeof window !== 'undefined') {
  isSupported()
    .then((supported) => {
      if (supported) {
        getAnalytics(firebaseApp)
      }
    })
    .catch(() => {
      // no-op: analytics is optional and should not block app startup
    })
}
