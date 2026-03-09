import { useEffect, useState, type ReactNode } from 'react'
import {
  onAuthStateChanged,
  signOut,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
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
  const [loading, setLoading] = useState(firebaseAuthEnabled)
  const [user, setUser] = useState<User | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const environmentChip = getEnvironmentChip()

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
          setError(err instanceof Error ? err.message : 'No se pudo sincronizar sesion.')
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

  async function signInWithEmail(): Promise<void> {
    setBusy(true)
    setError('')
    setInfo('')
    try {
      await signInWithEmailAndPassword(firebaseAuth, email.trim(), password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar sesion con correo y contrasena.')
    } finally {
      setBusy(false)
    }
  }

  async function createAccount(): Promise<void> {
    setBusy(true)
    setError('')
    setInfo('')
    try {
      await createUserWithEmailAndPassword(firebaseAuth, email.trim(), password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear la cuenta.')
    } finally {
      setBusy(false)
    }
  }

  async function resetPassword(): Promise<void> {
    const nextEmail = email.trim()
    if (!nextEmail) {
      setError('Ingresa tu correo para recuperar la contrasena.')
      setInfo('')
      return
    }
    setBusy(true)
    setError('')
    setInfo('')
    try {
      await sendPasswordResetEmail(firebaseAuth, nextEmail)
      setInfo('Te enviamos un correo para restablecer tu contrasena.')
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
            <p>Validando sesion...</p>
          </div>
        </section>
      </main>
    )
  }

  if (user) {
    return <>{children}</>
  }

  const chipClassName = environmentChip ? `auth-gate-chip auth-gate-chip-${environmentChip.tone}` : ''

  return (
    <main className="h-screen w-screen overflow-hidden bg-background-light dark:bg-background-dark font-display">
      <div className="flex h-full w-full">
        <section className="hidden lg:flex lg:w-1/2 relative overflow-hidden bg-primary/10">
          <div className="absolute inset-0 z-10 bg-gradient-to-t from-dark-text/40 to-transparent"></div>
          <img
            alt="Persona sonriendo trabajando comodamente en su oficina"
            className="absolute inset-0 h-full w-full object-cover"
            src="https://lh3.googleusercontent.com/aida-public/AB6AXuBqEuP8UKkLWwxtaB8V2PKVBDbiFOTf5YnAs9EpYwTR4otk5pUaNczBRchd7SNtQ7BRd3zk_l5umF1PGdPxsqTnabbkVxN2vhbKcZ11eDmciligSaBWMc65mZVqaEp1W3JFe8KTyVH79QtgdV2D_OGcHMIJFOhIApnNb3o3DlWc1A0gL1at0Za10sXNGBvl1YAxQflClz09bqSMge0Y43urYmq4L1pO9n-iy_bCAEwQhwHRMUHsdFGoSZJgAIZe2gyEywddKC2dom4"
          />
          <div className="relative z-20 flex flex-col justify-end p-14 text-white">
            <div className="flex items-center gap-3 mb-6">
              <img src="/assets/branding/logo_recibox.svg" alt="Recibox" className="h-12 w-auto" />
              {environmentChip && <span className={chipClassName}>{environmentChip.label.toUpperCase()}</span>}
            </div>
            <h1 className="text-4xl font-black leading-tight mb-4">Tu espacio, tus documentos, siempre seguros</h1>
            <p className="text-lg font-medium opacity-90 max-w-md">
              Gestion administrativa inteligente integrada totalmente con Google Drive para empresas y particulares.
            </p>
          </div>
        </section>

        <section
          className="w-full lg:w-1/2 flex flex-col justify-between bg-white dark:bg-background-dark p-8 lg:p-14"
          aria-label="Autenticacion Firebase"
        >
          <div className="lg:hidden flex items-center gap-3 mb-12">
            <img src="/assets/branding/logo_recibox.svg" alt="Recibox" className="h-10 w-auto" />
            {environmentChip && <span className={chipClassName}>{environmentChip.label.toUpperCase()}</span>}
          </div>

          <div className="flex-1 flex flex-col justify-center max-w-md mx-auto w-full">
            <div className="mb-10">
              <h2 className="text-3xl font-extrabold text-dark-text dark:text-slate-100 mb-2">Bienvenido de nuevo</h2>
              <p className="text-neutral-custom dark:text-neutral-custom/80">Accede a tu panel de control administrativo</p>
            </div>

            <button
              type="button"
              disabled
              title="Google Sign-In no disponible"
              className="flex w-full items-center justify-center gap-3 rounded-xl bg-slate-300 text-slate-600 font-bold py-4 px-6 cursor-not-allowed opacity-80 mb-8"
            >
              <svg className="w-6 h-6" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"></path>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"></path>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"></path>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.66l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"></path>
              </svg>
              <span>Continuar con Google (no disponible)</span>
            </button>

            <div className="relative flex py-5 items-center mb-6">
              <div className="flex-grow border-t border-neutral-custom/20"></div>
              <span className="flex-shrink mx-4 text-neutral-custom/60 text-sm font-medium">Configuracion de acceso</span>
              <div className="flex-grow border-t border-neutral-custom/20"></div>
            </div>

            <form
              className="space-y-4 mb-6"
              onSubmit={(event) => {
                event.preventDefault()
                void signInWithEmail()
              }}
            >
              <div>
                <label className="auth-gate-label block mb-1" htmlFor="auth-email">
                  Correo
                </label>
                <input
                  id="auth-email"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm focus:border-primary focus:ring-primary"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={busy}
                  required
                />
              </div>
              <div>
                <label className="auth-gate-label block mb-1" htmlFor="auth-password">
                  Contrasena
                </label>
                <input
                  id="auth-password"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm focus:border-primary focus:ring-primary"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                  required
                />
              </div>
              <button
                type="submit"
                className="w-full rounded-xl bg-primary hover:bg-primary/90 text-dark-text font-bold py-4 px-6 transition-all shadow-lg shadow-primary/20 disabled:opacity-70 disabled:cursor-not-allowed"
                disabled={busy}
              >
                {busy ? 'Procesando...' : 'Iniciar sesion'}
              </button>
            </form>

            <div className="flex items-center justify-between gap-4 mb-8">
              <button
                type="button"
                className="text-sm font-semibold underline text-amber-700 disabled:opacity-60 disabled:cursor-not-allowed"
                onClick={() => void createAccount()}
                disabled={busy}
              >
                Crear cuenta
              </button>
              <button
                type="button"
                className="text-sm underline text-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
                onClick={() => void resetPassword()}
                disabled={busy}
              >
                Olvide mi contrasena
              </button>
            </div>

            {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
            {info && <p className="text-sky-700 text-sm mb-3">{info}</p>}

            <div className="bg-background-light dark:bg-primary/5 p-1 rounded-xl flex mb-8">
              <button
                type="button"
                className="flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-lg bg-white dark:bg-background-dark text-dark-text dark:text-slate-100 shadow-sm font-semibold transition-all"
              >
                <span className="material-symbols-outlined text-lg">corporate_fare</span>
                Acceso Empresa
              </button>
              <button
                type="button"
                className="flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-lg text-neutral-custom font-medium"
              >
                <span className="material-symbols-outlined text-lg">person</span>
                Uso Personal
              </button>
            </div>

            <p className="text-center text-xs text-neutral-custom leading-relaxed">
              Al continuar, aceptas nuestros <a className="underline hover:text-dark-text font-medium" href="#">terminos de servicio</a> y{' '}
              <a className="underline hover:text-dark-text font-medium" href="#">politica de privacidad</a>.
            </p>
          </div>

          <footer className="mt-12 flex flex-col md:flex-row items-center justify-between gap-4 border-t border-neutral-custom/10 pt-8">
            <p className="text-neutral-custom text-sm">© 2024 Recibox. Todos los derechos reservados.</p>
            <div className="flex gap-6">
              <a className="text-neutral-custom hover:text-primary text-sm font-medium transition-colors" href="#">
                Privacidad
              </a>
              <a className="text-neutral-custom hover:text-primary text-sm font-medium transition-colors" href="#">
                Ayuda
              </a>
              <a className="text-neutral-custom hover:text-primary text-sm font-medium transition-colors" href="#">
                Contacto
              </a>
            </div>
          </footer>
        </section>
      </div>
    </main>
  )
}
