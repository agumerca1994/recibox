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
import { registerAccount } from '../api/recibox'

type Props = {
  children: ReactNode
}

const apiBasePath = import.meta.env.VITE_API_BASE_PATH || '/api'
const websiteBaseUrl = (import.meta.env.VITE_WEBSITE_BASE_URL || 'http://localhost:8090').replace(/\/+$/, '')
const registerPath = '/crear-cuenta'

export default function AuthGate({ children }: Props) {
  const [loading, setLoading] = useState(firebaseAuthEnabled)
  const [user, setUser] = useState<User | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [taxId, setTaxId] = useState('')
  const [billingAddress, setBillingAddress] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'register'>(() => {
    if (typeof window === 'undefined') {
      return 'login'
    }
    return window.location.pathname === registerPath ? 'register' : 'login'
  })
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
          const tenantId = (payload.tenant_id || '').trim().toLowerCase()
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
        if (typeof window !== 'undefined' && window.location.pathname === registerPath) {
          window.history.replaceState({ auth: 'login' }, '', '/')
          setAuthMode('login')
        }
      }
      setUser(nextUser)
      setLoading(false)
    })
    return () => unsubscribe()
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handlePopState = () => {
      setAuthMode(window.location.pathname === registerPath ? 'register' : 'login')
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  function goToRegister(): void {
    if (typeof window !== 'undefined') {
      window.history.pushState({ auth: 'register' }, '', registerPath)
    }
    setError('')
    setInfo('')
    setAuthMode('register')
  }

  function goToLogin(): void {
    if (typeof window !== 'undefined') {
      window.history.pushState({ auth: 'login' }, '', '/')
    }
    setError('')
    setInfo('')
    setAuthMode('login')
  }

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
      const normalizedEmail = email.trim()
      const normalizedCompany = companyName.trim()
      const normalizedTaxId = taxId.trim()
      const normalizedAddress = billingAddress.trim()
      if (!normalizedCompany || !normalizedTaxId || !normalizedAddress) {
        throw new Error('Completa todos los datos de la empresa o usuario.')
      }
      const credential = await createUserWithEmailAndPassword(firebaseAuth, normalizedEmail, password)
      const idToken = await credential.user.getIdToken()
      const register = await registerAccount(
        {
          company_name: normalizedCompany,
          tax_id: normalizedTaxId,
          billing_address: normalizedAddress,
          email: normalizedEmail,
        },
        idToken,
      )
      if (!register.ok) {
        throw new Error(register.error || 'No se pudo guardar la informacion de la cuenta.')
      }
    } catch (err) {
      try {
        await signOut(firebaseAuth)
      } catch {
        // no-op
      }
      let message = 'No se pudo crear la cuenta.'
      if (err && typeof err === 'object' && 'code' in err) {
        const code = String((err as { code?: unknown }).code || '')
        if (code === 'auth/email-already-in-use') {
          message = 'Ya hay un usuario registrado para este correo electronico.'
        }
      } else if (err instanceof Error) {
        message = err.message
      }
      setError(message)
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

  const isRegister = authMode === 'register'

  return (
    <main className="min-h-screen w-screen overflow-y-auto bg-background-light dark:bg-background-dark font-display auth-scroll">
      <div className="flex min-h-screen w-full">
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
          className="w-full lg:w-1/2 flex flex-col justify-between bg-white dark:bg-background-dark p-6 sm:p-8 lg:p-14 overflow-y-auto auth-scroll"
          aria-label="Autenticacion Firebase"
        >
          <div className="lg:hidden flex items-center gap-3 mb-12">
            <img src="/assets/branding/logo_recibox.svg" alt="Recibox" className="h-10 w-auto" />
            {environmentChip && <span className={chipClassName}>{environmentChip.label.toUpperCase()}</span>}
          </div>

          <div className="flex-1 flex flex-col justify-center max-w-md mx-auto w-full py-4">
            <div className="mb-6 sm:mb-10">
              <h2 className="text-3xl font-extrabold text-dark-text dark:text-slate-100 mb-2">
                {isRegister ? 'Crea tu cuenta' : 'Bienvenido de nuevo'}
              </h2>
              <p className="text-neutral-custom dark:text-neutral-custom/80">
                {isRegister
                  ? 'Completa los datos para habilitar tu acceso al backoffice.'
                  : 'Accede a tu panel de control administrativo'}
              </p>
            </div>

            <div className="relative flex py-5 items-center mb-6">
              <div className="flex-grow border-t border-neutral-custom/20"></div>
              <span className="flex-shrink mx-4 text-neutral-custom/60 text-sm font-medium">Configuracion de acceso</span>
              <div className="flex-grow border-t border-neutral-custom/20"></div>
            </div>

            {isRegister ? (
              <form
                className="space-y-4 mb-6"
                onSubmit={(event) => {
                  event.preventDefault()
                  void createAccount()
                }}
              >
                <div>
                  <label className="auth-gate-label block mb-1" htmlFor="register-company">
                    Nombre de usuario o empresa
                  </label>
                  <input
                    id="register-company"
                    className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm focus:border-primary focus:ring-primary"
                    type="text"
                    value={companyName}
                    onChange={(event) => setCompanyName(event.target.value)}
                    disabled={busy}
                    required
                  />
                </div>
                <div>
                  <label className="auth-gate-label block mb-1" htmlFor="register-tax-id">
                    Cuit/Cuil
                  </label>
                  <input
                    id="register-tax-id"
                    className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm focus:border-primary focus:ring-primary"
                    type="text"
                    value={taxId}
                    onChange={(event) => setTaxId(event.target.value)}
                    disabled={busy}
                    required
                  />
                </div>
                <div>
                  <label className="auth-gate-label block mb-1" htmlFor="register-address">
                    Direccion de facturacion
                  </label>
                  <input
                    id="register-address"
                    className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm focus:border-primary focus:ring-primary"
                    type="text"
                    value={billingAddress}
                    onChange={(event) => setBillingAddress(event.target.value)}
                    disabled={busy}
                    required
                  />
                </div>
                <div>
                  <label className="auth-gate-label block mb-1" htmlFor="auth-email">
                    Correo electronico
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
                    autoComplete="new-password"
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
                  {busy ? 'Procesando...' : 'Crear cuenta'}
                </button>
              </form>
            ) : (
              <>
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
                    onClick={goToRegister}
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
              </>
            )}

            {isRegister && (
              <div className="flex items-center justify-between gap-4 mb-8">
                <button
                  type="button"
                  className="text-sm font-semibold underline text-amber-700 disabled:opacity-60 disabled:cursor-not-allowed"
                  onClick={goToLogin}
                  disabled={busy}
                >
                  Ya tengo cuenta
                </button>
              </div>
            )}

            <div className="min-h-[32px]">
              {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
              {!error && info && <p className="text-sky-700 text-sm mb-3">{info}</p>}
            </div>

            <p className="text-center text-xs text-neutral-custom leading-relaxed">
              Al continuar, aceptas nuestros{' '}
              <a
                className="underline hover:text-dark-text font-medium"
                href={`${websiteBaseUrl}/terminos-y-condiciones`}
                target="_blank"
                rel="noreferrer"
              >
                terminos de servicio
              </a>{' '}
              y{' '}
              <a
                className="underline hover:text-dark-text font-medium"
                href={`${websiteBaseUrl}/politicas-de-privacidad`}
                target="_blank"
                rel="noreferrer"
              >
                politica de privacidad
              </a>
              .
            </p>
          </div>

          <footer className="mt-8 sm:mt-12 flex flex-col md:flex-row items-center justify-between gap-4 border-t border-neutral-custom/10 pt-6 sm:pt-8 pb-6 sm:pb-0">
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
