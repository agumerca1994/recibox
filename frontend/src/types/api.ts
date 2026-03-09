export type ApiErrorPayload = {
  detail?: unknown
}

export type ApiResponse<T> = {
  ok: boolean
  status: number
  data?: T
  error?: string
}

export type HealthResponse = {
  status: string
}

export type DriveFile = {
  id: string
  name: string
  mimeType?: string
  webViewLink?: string
}

export type DriveFilesResponse = {
  count: number
  files: DriveFile[]
}

export type DriveFolder = {
  id: string
  name: string
  mimeType?: string
  webViewLink?: string
}

export type DriveFoldersResponse = {
  count: number
  folders: DriveFolder[]
}

export type PickerFoldersResponse = DriveFoldersResponse & {
  parent_id: string
}

export type TenantDriveConfig = {
  drive_input_folder_id: string
  drive_root_folder_id: string
  drive_recibox_folder_id?: string | null
}

export type FilenameCustomFormat = {
  part1: 'MM' | 'YYYY' | 'EMPLOYEE' | 'NONE'
  sep1: '-' | '/' | '' | ')'
  part2: 'MM' | 'YYYY' | 'EMPLOYEE' | 'NONE'
  sep2: '-' | '/' | '' | ')'
  part3: 'MM' | 'YYYY' | 'EMPLOYEE' | 'NONE'
}

export type ProcessingPreferences = {
  tenant_id: string
  filename_format_mode: 'mm_yyyy_employee' | 'yyyy_mm_employee' | 'yyyy_employee' | 'custom'
  filename_custom_format: FilenameCustomFormat
  employee_folder_number_mode?: 'indexed_number' | 'number_only' | 'no_index' | 'custom'
  employee_folder_number_custom_part1?: string
  employee_folder_number_custom_part2?: string
  auto_create_missing_employee_folder?: boolean
  source?: string
  has_custom_config?: boolean
  updated_at?: string | null
}

export type JobQueuedResponse = {
  status: string
  job_id: string
  tenant_id: string
  drive_config_source?: string
}

export type JobStatusResponse = {
  job_id: string
  status: string
  result: unknown
  created_at?: string | null
  enqueued_at?: string | null
  started_at?: string | null
  ended_at?: string | null
  duration_seconds?: number | null
}

export type OAuthStatusResponse = {
  tenant_id: string
  has_token: boolean
  valid: boolean
  expired: boolean | null
  has_refresh_token: boolean
  expiry: string | null
}

export type OAuthUnlinkResponse = {
  tenant_id: string
  revoked: boolean
  deleted_local_token: boolean
  drive_config_cleared?: boolean
  tenant_disabled?: boolean
}

export type ReciboxStructureCheckResponse = {
  status: 'complete' | 'missing_input' | 'missing_recibox'
  parent_id: string
  recibox_exists: boolean
  input_exists: boolean
  recibox_folder_id: string | null
  input_folder_id: string | null
}

export type ReciboxStructureCreateResponse = {
  status: string
  tenant_id: string
  parent_id: string
  root_folder: { id: string; name?: string }
  input_folder: { id: string; name?: string }
  tenant_config_updated: boolean
}

export type RegisterAccountPayload = {
  company_name: string
  tax_id: string
  billing_address: string
  email?: string | null
}

export type RegisterAccountResponse = {
  status: string
  uid: string
  tenant_id: string
  email?: string | null
  company_name: string
  tax_id: string
  billing_address: string
}
