import type { ApiErrorPayload, ApiResponse } from '../types/api'

const API_BASE_PATH = import.meta.env.VITE_API_BASE_PATH || '/api'

function buildUrl(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`API path must start with '/': ${path}`)
  }
  return `${API_BASE_PATH}${path}`
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  try {
    const method = (init?.method || 'GET').toUpperCase()
    const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData
    const response = await fetch(buildUrl(path), {
      cache: method === 'GET' ? 'no-store' : init?.cache,
      ...init,
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } : {}),
        ...(init?.headers ?? {}),
      },
    })

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
