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

export type IngestDrivePayload = {
  processing_mode?: 'default' | 'template'
  template_id?: string | null
}

export type JobQueuedResponse = {
  status: string
  job_id: string
  tenant_id: string
  drive_config_source?: string
  processing_mode?: 'default' | 'template'
  template_id?: string | null
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
  granted_scopes?: string[]
  missing_scopes?: string[]
  scope_mismatch?: boolean
  tenant_disabled?: boolean
  operable?: boolean
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

export type TemplateMode = 'processing' | 'document'
export type RuleStatus = 'missing' | 'invalid' | 'ready'
export type TemplateFieldTransformOperation = 'trim' | 'replace' | 'remove_chars' | 'split' | 'case' | 'date_format'
export type TemplateFieldTransformCaseMode = 'upper' | 'lower' | 'title'
export type TemplateFieldTransformDateOutput = 'DD' | 'MM' | 'YYYY' | 'MM/YYYY' | 'MM-YYYY' | 'YYYY-MM' | 'MMM' | 'MMMM'

export type TemplateFieldTransformStep = {
  operation: TemplateFieldTransformOperation
  from?: string
  to?: string
  chars?: string
  delimiter?: string
  index?: number
  mode?: TemplateFieldTransformCaseMode
  output?: TemplateFieldTransformDateOutput
}

export type TemplateFieldTransformGroup = {
  field_key: string
  steps: TemplateFieldTransformStep[]
}

export type ProcessingTemplateField = {
  key: string
  label: string
  selected: boolean
  target: 'ignore' | 'employee_folder' | 'year_folder' | 'filename'
  required: boolean
}

export type TemplateFieldType = 'string' | 'number' | 'date' | 'array'

export type TemplateRect = {
  page: number
  x: number
  y: number
  w: number
  h: number
}

export type DocumentTemplateField = {
  id?: string
  key: string
  name: string
  label?: string | null
  suggested_label?: string | null
  type: TemplateFieldType
  rect: TemplateRect
  detected_value?: string | null
  sample_value?: string | null
  required?: boolean
}

export type TemplateOriginalField = {
  key: string
  label: string
  value: string
  source?: string
}

export type TemplateOriginalModel = {
  schema_version: string
  sample?: {
    file_id: string
    file_name: string
  }
  source?: {
    extractor?: string
    parser?: string
  }
  extracted_info: Record<string, string | null>
  fields: TemplateOriginalField[]
  raw_text?: string
  raw_text_len?: number
}

export type TemplateCustomModel = {
  mode?: TemplateMode
  fields: Array<ProcessingTemplateField | DocumentTemplateField>
}

export type ClassificationRulePartType = 'field' | 'literal' | 'index'
export type ClassificationRuleNodeType = 'folder' | 'file'
export type ClassificationRuleFolderConflictPolicy = 'use_existing' | 'create_new'
export type ClassificationRuleIndexKind = 'numeric' | 'alphabetic'
export type ClassificationRuleIndexDirection = 'incremental' | 'decremental'

export type ClassificationRuleNamePart = {
  part_id?: string
  part_order?: number
  part_type: ClassificationRulePartType
  field_key?: string | null
  literal_value?: string | null
  index_kind?: ClassificationRuleIndexKind | null
  index_start_numeric?: number | null
  index_start_alpha?: string | null
  index_direction?: ClassificationRuleIndexDirection | null
}

export type ClassificationRuleNode = {
  node_id?: string
  node_order?: number
  node_type: ClassificationRuleNodeType
  conflict_policy?: ClassificationRuleFolderConflictPolicy | null
  name_parts: ClassificationRuleNamePart[]
}

export type ClassificationRule = {
  rule_id?: string
  template_id: string
  tenant_id: string
  rule_status?: RuleStatus
  nodes: ClassificationRuleNode[]
  created_at?: string | null
  updated_at?: string | null
}

export type ClassificationRulePayload = {
  nodes: Array<{
    node_type: ClassificationRuleNodeType
    conflict_policy?: ClassificationRuleFolderConflictPolicy | null
    name_parts: Array<{
      part_type: ClassificationRulePartType
      field_key?: string | null
      literal_value?: string | null
      index_kind?: ClassificationRuleIndexKind | null
      index_start_numeric?: number | null
      index_start_alpha?: string | null
      index_direction?: ClassificationRuleIndexDirection | null
    }>
  }>
}

export type TemplateSummary = {
  template_id: string
  tenant_id: string
  name: string
  description?: string | null
  is_active: boolean
  template_mode?: TemplateMode
  sample_file_metadata?: Record<string, unknown> | null
  field_transforms?: TemplateFieldTransformGroup[]
  rule_status?: RuleStatus
  has_rule?: boolean
  updated_at?: string | null
}

export type TemplateDetail = TemplateSummary & {
  original_model: TemplateOriginalModel
  custom_model: TemplateCustomModel
  rule_errors?: string[]
  classification_rule?: ClassificationRule | null
  created_at?: string | null
}

export type TemplateListResponse = {
  tenant_id: string
  count: number
  templates: TemplateSummary[]
}

export type TemplateDraftResponse = {
  tenant_id: string
  file_id: string
  file_name: string
  original_model: TemplateOriginalModel
  custom_model: TemplateCustomModel
}

export type TemplateClassificationRuleResponse = {
  status: string
  tenant_id: string
  template_id: string
  rule_status: RuleStatus
  has_rule: boolean
  rule_errors?: string[]
  classification_rule?: ClassificationRule | null
}
