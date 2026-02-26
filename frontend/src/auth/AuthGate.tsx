import { useEffect, useState, type ReactNode } from 'react'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signOut,
  signInWithPopup,
  signInWithEmailAndPassword,
  type User,
} from 'firebase/auth'
import './AuthGate.css'
import { firebaseAuth, firebaseAuthEnabled, googleAuthProvider } from './firebase'
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

  async function signInWithGoogle() {
    setBusy(true)
    setError('')
    setInfo('')
    try {
      await signInWithPopup(firebaseAuth, googleAuthProvider)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar sesión con Google.')
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
      <section className="auth-gate-layout" aria-label="Autenticacion Firebase">
        <aside className="auth-left-panel">
          <div className="auth-left-overlay" />
          <img
            className="auth-left-image"
            src="https://lh3.googleusercontent.com/aida-public/AB6AXuBqEuP8UKkLWwxtaB8V2PKVBDbiFOTf5YnAs9EpYwTR4otk5pUaNczBRchd7SNtQ7BRd3zk_l5umF1PGdPxsqTnabbkVxN2vhbKcZ11eDmciligSaBWMc65mZVqaEp1W3JFe8KTyVH79QtgdV2D_OGcHMIJFOhIApnNb3o3DlWc1A0gL1at0Za10sXNGBvl1YAxQflClz09bqSMge0Y43urYmq4L1pO9n-iy_bCAEwQhwHRMUHsdFGoSZJgAIZe2gyEywddKC2dom4"
            alt="Persona sonriendo trabajando cómodamente en su oficina"
          />
          <div className="auth-left-content">
            <div className="auth-left-content-inner">
              <div className="auth-left-brand">
                <img src="/assets/branding/logo_recibox.svg" alt="Recibox" />
              </div>
              <h1>Tu espacio, tus documentos, siempre seguros</h1>
              <p>Gestión administrativa inteligente integrada totalmente con Google Drive para empresas y particulares.</p>
            </div>
          </div>
        </aside>
        <div className="auth-right-panel">
          <div className="auth-gate-brand">
            {environmentChip && <span className={`env-chip env-chip-${environmentChip.tone}`}>{environmentChip.label}</span>}
          </div>
          <div className="auth-title-block">
            <h2>Bienvenido de nuevo</h2>
            <p>Accede a tu panel de control administrativo</p>
          </div>
          <button type="button" className="auth-google-btn" disabled={busy} onClick={() => void signInWithGoogle()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.66l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 12-4.53z" fill="#EA4335" />
            </svg>
            <span>{busy ? 'Procesando...' : 'Continuar con Google'}</span>
          </button>
          <div className="auth-divider">
            <span>Configuración de acceso</span>
          </div>
          <div className="auth-access-switch">
            <button type="button" className={`auth-access-option ${mode === 'login' ? 'active' : ''}`} onClick={() => setMode('login')}>
              Acceso Empresa
            </button>
            <button
              type="button"
              className={`auth-access-option ${mode === 'register' ? 'active' : ''}`}
              onClick={() => setMode('register')}
            >
              Uso Personal
            </button>
          </div>
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
            <button type="submit" className={`auth-gate-btn ${mode === 'register' ? 'auth-gate-btn-register' : ''}`} disabled={busy}>
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
          <p className="auth-legal-copy">
            Al continuar, aceptas nuestros <a href="#">términos de servicio</a> y <a href="#">política de privacidad</a>.
          </p>
          {error && <p className="auth-gate-error">{error}</p>}
          {info && <p className="auth-gate-info">{info}</p>}
          <footer className="auth-footer">
            <p>© 2024 Recibox. Todos los derechos reservados.</p>
            <div>
              <a href="#">Privacidad</a>
              <a href="#">Ayuda</a>
              <a href="#">Contacto</a>
            </div>
          </footer>
        </div>
      </section>
    </main>
  )
}
