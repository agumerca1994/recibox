import { apiRequest } from './client'
import type {
  DriveFilesResponse,
  DriveFoldersResponse,
  HealthResponse,
  JobQueuedResponse,
  JobStatusResponse,
  OAuthStatusResponse,
  OAuthUnlinkResponse,
  PickerFoldersResponse,
  ProcessingPreferences,
  ReciboxStructureCheckResponse,
  ReciboxStructureCreateResponse,
  TenantDriveConfig,
} from '../types/api'

function queryTenant(tenantId: string): string {
  return `tenant_id=${encodeURIComponent(tenantId)}`
}

export function getHealth() {
  return apiRequest<HealthResponse>('/health')
}

export function getTenantDriveConfig(tenantId: string) {
  return apiRequest<TenantDriveConfig>(`/tenants/${encodeURIComponent(tenantId)}/drive-config`)
}

export function putTenantDriveConfig(tenantId: string, payload: TenantDriveConfig) {
  return apiRequest<TenantDriveConfig>(`/tenants/${encodeURIComponent(tenantId)}/drive-config`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function listDriveFiles(tenantId: string) {
  return apiRequest<DriveFilesResponse>(`/drive/files?${queryTenant(tenantId)}`)
}

export function listEmployeeFolders(tenantId: string) {
  return apiRequest<DriveFoldersResponse>(`/drive/employees?${queryTenant(tenantId)}`)
}

export function listEmployeeYears(tenantId: string, employeeFolderId: string) {
  return apiRequest<DriveFoldersResponse>(
    `/drive/employees/${encodeURIComponent(employeeFolderId)}/years?${queryTenant(tenantId)}`,
  )
}

export function listFilesInFolder(tenantId: string, folderId: string) {
  return apiRequest<DriveFilesResponse>(`/drive/folders/${encodeURIComponent(folderId)}/files?${queryTenant(tenantId)}`)
}

export function ingestDrive(tenantId: string) {
  return apiRequest<JobQueuedResponse>(`/ingest/drive?${queryTenant(tenantId)}`, {
    method: 'POST',
  })
}

export function getJobStatus(jobId: string) {
  return apiRequest<JobStatusResponse>(`/jobs/${encodeURIComponent(jobId)}`)
}

export function getGoogleOAuthStatus(tenantId: string) {
  return apiRequest<OAuthStatusResponse>(`/auth/google/status?${queryTenant(tenantId)}`)
}

export function unlinkGoogleOAuth(tenantId: string) {
  return apiRequest<OAuthUnlinkResponse>(`/auth/google/unlink?${queryTenant(tenantId)}`, {
    method: 'POST',
  })
}

export function checkReciboxStructure(tenantId: string, parentId = 'root') {
  return apiRequest<ReciboxStructureCheckResponse>(
    `/drive/picker/recibox-structure/check?${queryTenant(tenantId)}&parent_id=${encodeURIComponent(parentId)}`,
  )
}

export function createReciboxStructure(tenantId: string, parentId = 'root') {
  return apiRequest<ReciboxStructureCreateResponse>(`/drive/picker/recibox-structure?${queryTenant(tenantId)}`, {
    method: 'POST',
    body: JSON.stringify({ parent_id: parentId }),
  })
}

export function listPickerFolders(tenantId: string, parentId = 'root') {
  return apiRequest<PickerFoldersResponse>(
    `/drive/picker/folders?${queryTenant(tenantId)}&parent_id=${encodeURIComponent(parentId)}`,
  )
}

export function adoptReciboxFolder(tenantId: string, folderId: string, parentId = 'root') {
  return apiRequest<ReciboxStructureCreateResponse>(`/drive/picker/recibox-structure/adopt-folder?${queryTenant(tenantId)}`, {
    method: 'POST',
    body: JSON.stringify({
      folder_id: folderId,
      parent_id: parentId,
    }),
  })
}

export function getProcessingPreferences(tenantId: string) {
  return apiRequest<ProcessingPreferences>(`/tenants/${encodeURIComponent(tenantId)}/processing-preferences`)
}

export function putProcessingPreferences(tenantId: string, payload: ProcessingPreferences) {
  return apiRequest<ProcessingPreferences>(`/tenants/${encodeURIComponent(tenantId)}/processing-preferences`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}
