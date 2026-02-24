import { useEffect, useState, type ReactNode } from 'react'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  signInWithEmailAndPassword,
  signInWithPopup,
  type User,
} from 'firebase/auth'
import './AuthGate.css'
import { firebaseAuth, firebaseAuthEnabled, googleAuthProvider } from './firebase'
import { authEmailStorageKey, authUidStorageKey, tenantStorageKey } from './session'

type Props = {
  children: ReactNode
}

const apiBasePath = import.meta.env.VITE_API_BASE_PATH || '/api'

export default function AuthGate({ children }: Props) {
  const [loading, setLoading] = useState(firebaseAuthEnabled)
  const [user, setUser] = useState<User | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  useEffect(() => {
    if (!firebaseAuthEnabled) {
      setLoading(false)
      return
    }
    const unsubscribe = onAuthStateChanged(firebaseAuth, async (nextUser) => {
      if (nextUser) {
        window.localStorage.setItem(authUidStorageKey, nextUser.uid)
        if (nextUser.email) {
          window.localStorage.setItem(authEmailStorageKey, nextUser.email)
        } else {
          window.localStorage.removeItem(authEmailStorageKey)
        }
        try {
          const idToken = await nextUser.getIdToken()
          const response = await fetch(`${apiBasePath}/auth/session`, {
            headers: {
              Authorization: `Bearer ${idToken}`,
              'Cache-Control': 'no-cache',
            },
          })
          if (!response.ok) {
            const text = await response.text()
            throw new Error(text || `HTTP ${response.status}`)
          }
          const payload = (await response.json()) as { tenant_id?: string }
          const tenantId = (payload.tenant_id || '').trim()
          if (!tenantId) {
            throw new Error('Backend no devolvio tenant_id')
          }
          window.localStorage.setItem(tenantStorageKey, tenantId)
        } catch (err) {
          try {
            await signOut(firebaseAuth)
          } catch {
            // no-op
          }
          setError(err instanceof Error ? err.message : 'No se pudo sincronizar sesión.')
          setUser(null)
          setLoading(false)
          return
        }
      } else {
        window.localStorage.removeItem(authUidStorageKey)
        window.localStorage.removeItem(authEmailStorageKey)
      }
      setUser(nextUser)
      setLoading(false)
    })
    return () => unsubscribe()
  }, [])

  async function loginWithGoogle() {
    setBusy(true)
    setError('')
    try {
      await signInWithPopup(firebaseAuth, googleAuthProvider)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar sesion con Firebase.')
    } finally {
      setBusy(false)
    }
  }

  async function submitEmailPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedEmail = email.trim()
    if (!normalizedEmail || !password) {
      setError('Completa correo y contraseña.')
      return
    }
    if (mode === 'register' && password.length < 6) {
      setError('La contraseña debe tener al menos 6 caracteres.')
      return
    }

    setBusy(true)
    setError('')
    try {
      if (mode === 'register') {
        await createUserWithEmailAndPassword(firebaseAuth, normalizedEmail, password)
      } else {
        await signInWithEmailAndPassword(firebaseAuth, normalizedEmail, password)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo autenticar el usuario.')
    } finally {
      setBusy(false)
    }
  }

  if (!firebaseAuthEnabled) {
    return <>{children}</>
  }

  if (loading) {
    return (
      <main className="auth-gate">
        <section className="auth-gate-card" aria-label="Autenticacion Firebase">
          <h1>RECIBOX</h1>
          <p>Validando sesion...</p>
        </section>
      </main>
    )
  }

  if (user) {
    return <>{children}</>
  }

  return (
    <main className="auth-gate">
      <section className="auth-gate-card" aria-label="Autenticacion Firebase">
        <h1>RECIBOX</h1>
        <p>Ingresa con Google o con correo y contraseña para acceder al backoffice.</p>
        <form className="auth-gate-form" onSubmit={(event) => void submitEmailPassword(event)}>
          <label className="auth-gate-label" htmlFor="auth-email">
            Correo
          </label>
          <input
            id="auth-email"
            className="auth-gate-input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            disabled={busy}
          />
          <label className="auth-gate-label" htmlFor="auth-password">
            Contraseña
          </label>
          <input
            id="auth-password"
            className="auth-gate-input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            disabled={busy}
          />
          <button type="submit" className="auth-gate-btn" disabled={busy}>
            {busy ? 'Procesando...' : mode === 'register' ? 'Crear cuenta' : 'Entrar con correo'}
          </button>
        </form>
        <div className="auth-gate-actions">
          <button type="button" className="auth-gate-btn" onClick={() => void loginWithGoogle()} disabled={busy}>
            {busy ? 'Conectando...' : 'Entrar con Google'}
          </button>
          <button
            type="button"
            className="auth-gate-btn auth-gate-btn-secondary"
            disabled={busy}
            onClick={() => {
              setError('')
              setMode((prev) => (prev === 'login' ? 'register' : 'login'))
            }}
          >
            {mode === 'register' ? 'Ya tengo cuenta' : 'Crear cuenta'}
          </button>
        </div>
        {error && <p className="auth-gate-error">{error}</p>}
      </section>
    </main>
  )
}
