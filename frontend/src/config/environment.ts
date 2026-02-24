type RuntimeConfig = Record<string, string | undefined>

type AppEnvironment = 'localhost' | 'test' | 'prod'
type EnvironmentChip = {
  label: 'Localhost' | 'Test' | 'Beta'
  tone: 'localhost' | 'test' | 'beta'
}

function getRuntimeConfig(): RuntimeConfig {
  const config = (globalThis as { __RECIBOX_CONFIG?: RuntimeConfig }).__RECIBOX_CONFIG
  return config || {}
}

export function getRuntimeSetting(name: string): string | undefined {
  const runtimeValue = getRuntimeConfig()[name]
  if (typeof runtimeValue === 'string' && runtimeValue.trim()) {
    return runtimeValue.trim()
  }
  const buildValue = (import.meta.env as Record<string, string | undefined>)[name]
  if (typeof buildValue === 'string' && buildValue.trim()) {
    return buildValue.trim()
  }
  return undefined
}

function mapNamedEnvironment(value: string | undefined): AppEnvironment | null {
  const normalized = (value || '').trim().toLowerCase()
  if (['localhost', 'local', 'dev', 'development'].includes(normalized)) {
    return 'localhost'
  }
  if (['test', 'testing', 'staging', 'qa', 'homolog'].includes(normalized)) {
    return 'test'
  }
  if (['prod', 'production'].includes(normalized)) {
    return 'prod'
  }
  return null
}

function mapHostnameEnvironment(hostname: string): AppEnvironment {
  const host = hostname.trim().toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local')) {
    return 'localhost'
  }
  if (host.includes('test') || host.includes('staging') || host.includes('qa')) {
    return 'test'
  }
  return 'prod'
}

export function detectAppEnvironment(): AppEnvironment {
  const named = mapNamedEnvironment(getRuntimeSetting('VITE_APP_ENV'))
  if (named) {
    return named
  }
  if (typeof window !== 'undefined') {
    return mapHostnameEnvironment(window.location.hostname)
  }
  return 'prod'
}

export function getEnvironmentChip(): EnvironmentChip | null {
  const env = detectAppEnvironment()
  if (env === 'localhost') {
    return { label: 'Localhost', tone: 'localhost' }
  }
  if (env === 'test') {
    return { label: 'Test', tone: 'test' }
  }
  return { label: 'Beta', tone: 'beta' }
}
