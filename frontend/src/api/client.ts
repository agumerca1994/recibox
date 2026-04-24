import type { ApiErrorPayload, ApiResponse } from '../types/api'
import { firebaseAuth, firebaseAuthEnabled } from '../auth/firebase'

const API_BASE_PATH = import.meta.env.VITE_API_BASE_PATH || '/api'

function buildUrl(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`API path must start with '/': ${path}`)
  }
  return `${API_BASE_PATH}${path}`
}

async function buildRequestHeaders(init?: RequestInit): Promise<Headers> {
  const headers = new Headers(init?.headers ?? {})
  const method = (init?.method || 'GET').toUpperCase()
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData
  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (method === 'GET') {
    headers.set('Cache-Control', 'no-cache')
    headers.set('Pragma', 'no-cache')
  }
  if (!headers.has('Authorization') && firebaseAuthEnabled && firebaseAuth.currentUser) {
    const idToken = await firebaseAuth.currentUser.getIdToken()
    if (idToken.trim()) {
      headers.set('Authorization', `Bearer ${idToken}`)
    }
  }
  return headers
}

export async function fetchWithAuth(url: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method || 'GET').toUpperCase()
  const headers = await buildRequestHeaders(init)
  return fetch(url, {
    cache: method === 'GET' ? 'no-store' : init?.cache,
    ...init,
    headers,
  })
}

export async function fetchApiBlob(url: string): Promise<{ blob: Blob; response: Response }> {
  const response = await fetchWithAuth(url, { method: 'GET' })
  if (!response.ok) {
    throw new Error(`No se pudo descargar el archivo (${response.status}).`)
  }
  const blob = await response.blob()
  if (blob.size === 0) {
    throw new Error('El archivo descargado esta vacio.')
  }
  return { blob, response }
}

export async function downloadApiFile(url: string, fallbackFileName: string): Promise<void> {
  const { blob, response } = await fetchApiBlob(url)
  const contentDisposition = response.headers.get('content-disposition') || ''
  const match = /filename\*=UTF-8''([^;]+)|filename=\"?([^\";]+)\"?/i.exec(contentDisposition)
  const resolvedFileName = decodeURIComponent(match?.[1] || match?.[2] || fallbackFileName || 'download.bin')
  const objectUrl = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = resolvedFileName
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 500)
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  try {
    const response = await fetchWithAuth(buildUrl(path), init)

    const isJson = response.headers.get('content-type')?.includes('application/json')
    const payload = isJson ? ((await response.json()) as T | ApiErrorPayload) : undefined

    if (!response.ok) {
      const detail = (payload as ApiErrorPayload | undefined)?.detail
      return {
        ok: false,
        status: response.status,
        error: typeof detail === 'string' ? detail : `HTTP ${response.status}`,
      }
    }

    return {
      ok: true,
      status: response.status,
      data: payload as T,
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : 'Network error',
    }
  }
}
