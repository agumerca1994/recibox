import { useEffect, useState, type ReactNode } from 'react'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signOut,
  signInWithEmailAndPassword,
  type User,
} from 'firebase/auth'
import './AuthGate.css'
import { firebaseAuth, firebaseAuthEnabled } from './firebase'
import { authEmailStorageKey, authUidStorageKey, tenantStorageKey } from './session'
import { getEnvironmentChip } from '../config/environment'

type Props = {
  children: ReactNode
}

const apiBasePath = import.meta.env.VITE_API_BASE_PATH || '/api'

export default function AuthGate({ children }: Props) {
  const environmentChip = getEnvironmentChip()
  const [loading, setLoading] = useState(firebaseAuthEnabled)
  const [user, setUser] = useState<User | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [info, setInfo] = useState('')

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
    setInfo('')
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

  async function recoverPassword() {
    const normalizedEmail = email.trim()
    if (!normalizedEmail) {
      setInfo('')
      setError('Ingresa tu correo para recuperar la contraseña.')
      return
    }
    setBusy(true)
    setError('')
    setInfo('')
    try {
      await sendPasswordResetEmail(firebaseAuth, normalizedEmail)
      setInfo('Te enviamos un correo para recuperar la contraseña.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar el correo de recuperacion.')
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
          <div className="auth-gate-brand">
            <h1>RECIBOX</h1>
            {environmentChip && <span className={`env-chip env-chip-${environmentChip.tone}`}>{environmentChip.label}</span>}
          </div>
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
        <div className="auth-gate-brand">
          <h1>RECIBOX</h1>
          {environmentChip && <span className={`env-chip env-chip-${environmentChip.tone}`}>{environmentChip.label}</span>}
        </div>
        <p>Inicia sesion o registrate para usar el backoffice.</p>
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
          <button
            type="submit"
            className={`auth-gate-btn ${mode === 'register' ? 'auth-gate-btn-register' : ''}`}
            disabled={busy}
          >
            {busy ? 'Procesando...' : mode === 'register' ? 'Crear cuenta' : 'Iniciar sesion'}
          </button>
        </form>
        <div className="auth-gate-links">
          <button
            type="button"
            className="auth-gate-link auth-gate-link-create"
            disabled={busy}
            onClick={() => {
              setError('')
              setInfo('')
              setMode((prev) => (prev === 'login' ? 'register' : 'login'))
            }}
          >
            {mode === 'register' ? 'Ya tengo cuenta' : 'Crear cuenta'}
          </button>
          <button type="button" className="auth-gate-link" disabled={busy} onClick={() => void recoverPassword()}>
            Olvide mi contraseña
          </button>
        </div>
        {error && <p className="auth-gate-error">{error}</p>}
        {info && <p className="auth-gate-info">{info}</p>}
      </section>
    </main>
  )
}
