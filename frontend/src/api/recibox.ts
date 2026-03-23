import { apiRequest } from './client'
import type {
  DriveFilesResponse,
  DriveFolderContentsResponse,
  DriveFoldersResponse,
  HealthResponse,
  IngestDrivePayload,
  JobQueuedResponse,
  JobStatusResponse,
  OAuthStatusResponse,
  OAuthUnlinkResponse,
  ProcessRunListResponse,
  PickerFoldersResponse,
  ProcessingPreferences,
  ReciboxStructureCheckResponse,
  ReciboxStructureCreateResponse,
  RegisterAccountPayload,
  RegisterAccountResponse,
  StopJobResponse,
  TenantDriveConfig,
  TemplateFieldTransformGroup,
  TemplateGroupCreateResponse,
  TemplateGroupListResponse,
  TemplateClassificationRuleResponse,
  TemplateDetail,
  TemplateDraftResponse,
  TemplateListResponse,
  ClassificationRulePayload,
} from '../types/api'

const API_BASE_PATH = import.meta.env.VITE_API_BASE_PATH || '/api'

function queryTenant(tenantId: string): string {
  return `tenant_id=${encodeURIComponent(tenantId)}`
}

function buildApiUrl(path: string): string {
  return `${API_BASE_PATH}${path}`
}

export type TemplateUpsertPayload = {
  name: string
  group_id: string
  description?: string | null
  is_active?: boolean
  original_model: Record<string, unknown>
  custom_model: Record<string, unknown>
  sample_file_metadata?: Record<string, unknown> | null
  field_transforms?: TemplateFieldTransformGroup[]
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

export function listFolderContents(tenantId: string, folderId: string) {
  return apiRequest<DriveFolderContentsResponse>(
    `/drive/folders/${encodeURIComponent(folderId)}/contents?${queryTenant(tenantId)}`,
  )
}

export function ingestDrive(tenantId: string, payload?: IngestDrivePayload) {
  return apiRequest<JobQueuedResponse>(`/ingest/drive?${queryTenant(tenantId)}`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

export function getJobStatus(jobId: string) {
  return apiRequest<JobStatusResponse>(`/jobs/${encodeURIComponent(jobId)}`)
}

export function listProcessRuns(tenantId: string, limit = 10) {
  return apiRequest<ProcessRunListResponse>(`/process-runs?${queryTenant(tenantId)}&limit=${encodeURIComponent(String(limit))}`)
}

export function stopJob(jobId: string) {
  return apiRequest<StopJobResponse>(`/jobs/${encodeURIComponent(jobId)}/stop`, {
    method: 'POST',
  })
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

export function createTemplateDraftFromFile(tenantId: string, fileId: string, fileName?: string) {
  return apiRequest<TemplateDraftResponse>(`/tenants/${encodeURIComponent(tenantId)}/templates/draft-from-file`, {
    method: 'POST',
    body: JSON.stringify({
      file_id: fileId,
      file_name: fileName || null,
    }),
  })
}

export function listTemplates(tenantId: string, includeInactive = true) {
  return apiRequest<TemplateListResponse>(
    `/tenants/${encodeURIComponent(tenantId)}/templates?include_inactive=${encodeURIComponent(String(includeInactive))}`,
  )
}

export function listTemplateGroups(tenantId: string, options?: { sync?: boolean }) {
  const query = options?.sync ? '?sync=true' : ''
  return apiRequest<TemplateGroupListResponse>(`/tenants/${encodeURIComponent(tenantId)}/template-groups${query}`)
}

export function createTemplateGroup(tenantId: string, name: string) {
  return apiRequest<TemplateGroupCreateResponse>(`/tenants/${encodeURIComponent(tenantId)}/template-groups`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export function getTemplate(tenantId: string, templateId: string) {
  return apiRequest<TemplateDetail>(
    `/tenants/${encodeURIComponent(tenantId)}/templates/${encodeURIComponent(templateId)}`,
  )
}

export function createTemplate(tenantId: string, payload: TemplateUpsertPayload) {
  return apiRequest<TemplateDetail>(`/tenants/${encodeURIComponent(tenantId)}/templates`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateTemplate(tenantId: string, templateId: string, payload: TemplateUpsertPayload) {
  return apiRequest<TemplateDetail>(`/tenants/${encodeURIComponent(tenantId)}/templates/${encodeURIComponent(templateId)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function getTemplateClassificationRule(tenantId: string, templateId: string) {
  return apiRequest<TemplateClassificationRuleResponse>(
    `/tenants/${encodeURIComponent(tenantId)}/templates/${encodeURIComponent(templateId)}/classification-rule`,
  )
}

export function putTemplateClassificationRule(tenantId: string, templateId: string, payload: ClassificationRulePayload) {
  return apiRequest<TemplateClassificationRuleResponse>(
    `/tenants/${encodeURIComponent(tenantId)}/templates/${encodeURIComponent(templateId)}/classification-rule`,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
  )
}

export function deleteTemplate(tenantId: string, templateId: string) {
  return apiRequest<{ status: string; deleted: boolean; tenant_id: string; template_id: string }>(
    `/tenants/${encodeURIComponent(tenantId)}/templates/${encodeURIComponent(templateId)}`,
    {
      method: 'DELETE',
    },
  )
}

export function uploadTemplateSourcePdf(tenantId: string, templateId: string, file: Blob, fileName: string) {
  const form = new FormData()
  form.append('file', file, fileName || 'template.pdf')
  return apiRequest<{ status: string; tenant_id: string; template_id: string; stored: boolean }>(
    `/tenants/${encodeURIComponent(tenantId)}/templates/${encodeURIComponent(templateId)}/source-pdf`,
    {
      method: 'POST',
      body: form,
    },
  )
}

export function buildTemplateSourcePdfUrl(tenantId: string, templateId: string) {
  return buildApiUrl(`/tenants/${encodeURIComponent(tenantId)}/templates/${encodeURIComponent(templateId)}/source-pdf`)
}

export function buildDrivePdfDownloadUrl(tenantId: string, fileId: string) {
  return buildApiUrl(`/drive/files/${encodeURIComponent(fileId)}/download?${queryTenant(tenantId)}`)
}

export function registerAccount(payload: RegisterAccountPayload, idToken: string) {
  return apiRequest<RegisterAccountResponse>('/auth/register', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(payload),
  })
}
