import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  adoptReciboxFolder,
  checkReciboxStructure,
  createReciboxStructure,
  getGoogleOAuthStatus,
  getJobStatus,
  getProcessingPreferences,
  ingestDrive,
  listEmployeeFolders,
  listEmployeeYears,
  listFilesInFolder,
  listDriveFiles,
  listPickerFolders,
  putProcessingPreferences,
  putTenantDriveConfig,
  unlinkGoogleOAuth,
} from './api/recibox'
import type {
  DriveFile,
  DriveFolder,
  FilenameCustomFormat,
  JobStatusResponse,
  ProcessingPreferences,
  ReciboxStructureCheckResponse,
} from './types/api'

const defaultTenant = (import.meta.env.VITE_TENANT_ID || 'acme').trim() || 'acme'
const apiBasePath = import.meta.env.VITE_API_BASE_PATH || '/api'
const tenantStorageKey = 'recibox:tenant-id'

type OAuthMessage = {
  source?: string
  ok?: boolean
  tenant_id?: string
  message?: string
}

type Section = 'cuenta' | 'procesar' | 'nomina' | 'configuracion'
type ProcessState = 'running' | 'success' | 'error'
type SortOrder = 'asc' | 'desc'
type FilenameFormatMode = 'mm_yyyy_employee' | 'yyyy_mm_employee' | 'yyyy_employee' | 'custom'
type EmployeeFolderNumberMode = 'indexed_number' | 'number_only' | 'no_index' | 'custom'

type ProcessItem = {
  id: string
  jobId: string
  name: string
  state: ProcessState
  detail: JobStatusResponse | null
  createdAt: number
}

type RunMetrics = {
  totalProcessed: number | null
  success: number | null
  error: number | null
  flowStatus: string | null
  message: string | null
  logPath: string | null
}

type StorageStructureInfo = {
  parentId: string
  reciboxFolderId: string
  inputFolderId: string
}

type PendingStructureData = {
  parentId: string
}

type PendingStorageAction =
  | { kind: 'create' }
  | { kind: 'adopt'; folderId: string; folderName: string }

type ProcessingPrefsSnapshot = {
  filenameFormatMode: FilenameFormatMode
  customFilenameFormat: FilenameCustomFormat
  employeeFolderNumberMode: EmployeeFolderNumberMode
  employeeFolderCustomPart1: string
  employeeFolderCustomPart2: string
  autoCreateMissingEmployeeFolder: boolean
}

type AutomationRulesSnapshot = {
  cronDateTime: string
  retryOnError: string
  notifyOnFailure: boolean
}

const sectionPathMap: Record<Section, string> = {
  cuenta: '/cuentas',
  procesar: '/procesar',
  nomina: '/nomina',
  configuracion: '/configuracion',
}

const filenameTokenOptions: Array<{ value: FilenameCustomFormat['part1']; label: string }> = [
  { value: 'MM', label: 'MM' },
  { value: 'YYYY', label: 'YYYY' },
  { value: 'EMPLOYEE', label: 'Nombre del colaborador' },
  { value: 'NONE', label: 'Ninguno' },
]

const filenameSeparatorOptions: Array<{ value: FilenameCustomFormat['sep1']; label: string }> = [
  { value: '-', label: '-' },
  { value: '/', label: '/' },
  { value: ')', label: ')' },
  { value: '', label: 'Ninguno' },
]

const defaultCustomFilenameFormat: FilenameCustomFormat = {
  part1: 'MM',
  sep1: '-',
  part2: 'YYYY',
  sep2: ')',
  part3: 'EMPLOYEE',
}

const employeeNameCollator = new Intl.Collator('es', {
  sensitivity: 'base',
  numeric: true,
  ignorePunctuation: true,
})

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function tokenPreviewValue(token: FilenameCustomFormat['part1']): string {
  if (token === 'NONE') {
    return ''
  }
  if (token === 'MM') {
    return '01'
  }
  if (token === 'YYYY') {
    return '2026'
  }
  return 'Nombre del colaborador'
}

function separatorPreviewValue(separator: FilenameCustomFormat['sep1']): string {
  if (separator === ')') {
    return ') '
  }
  return separator
}

function buildFilenamePreview(mode: FilenameFormatMode, custom: FilenameCustomFormat): string {
  if (mode === 'yyyy_mm_employee') {
    return '2026-01) Nombre del colaborador.pdf'
  }
  if (mode === 'yyyy_employee') {
    return '2026) Nombre del colaborador.pdf'
  }
  if (mode === 'custom') {
    return `${tokenPreviewValue(custom.part1)}${separatorPreviewValue(custom.sep1)}${tokenPreviewValue(custom.part2)}${separatorPreviewValue(custom.sep2)}${tokenPreviewValue(custom.part3)}.pdf`
  }
  return '01-2026) Nombre del colaborador.pdf'
}

function hasAnyCustomFilenamePart(custom: FilenameCustomFormat): boolean {
  return custom.part1 !== 'NONE' || custom.part2 !== 'NONE' || custom.part3 !== 'NONE'
}

function buildEmployeeFolderPreview(
  mode: EmployeeFolderNumberMode,
  customPart1: string,
  customPart2: string,
): string {
  const numero = '1'
  const empleado = 'Nombre del colaborador'
  if (mode === 'number_only') {
    return `${numero} ${empleado}`
  }
  if (mode === 'no_index') {
    return empleado
  }
  if (mode === 'custom') {
    const fixedField = `${customPart1}${customPart2}`.trim()
    if (!fixedField) {
      return empleado
    }
    return `${fixedField} ${empleado}`
  }
  return `#${numero} ${empleado}`
}

function compareEmployeeFolders(a: DriveFolder, b: DriveFolder): number {
  const cmp = employeeNameCollator.compare(normalizeSearchText(a.name), normalizeSearchText(b.name))
  if (cmp !== 0) {
    return cmp
  }
  return a.id.localeCompare(b.id)
}

function mapJobState(status: string | undefined, detail: JobStatusResponse | null): ProcessState {
  const value = (status || '').toLowerCase()
  const result = detail?.result
  if (value === 'finished' && result && typeof result === 'object') {
    const resultObj = result as Record<string, unknown>
    const flowStatus = typeof resultObj.status === 'string' ? resultObj.status.toLowerCase() : ''
    const errorCount = typeof resultObj.error === 'number' ? resultObj.error : 0
    if (flowStatus === 'partial' || flowStatus === 'error' || errorCount > 0) {
      return 'error'
    }
  }
  if (value === 'finished') {
    return 'success'
  }
  if (value === 'queued' || value === 'started' || value === 'deferred' || value === 'scheduled') {
    return 'running'
  }
  return 'error'
}

function extractRunMetrics(detail: JobStatusResponse | null): RunMetrics {
  const fallback: RunMetrics = {
    totalProcessed: null,
    success: null,
    error: null,
    flowStatus: null,
    message: null,
    logPath: null,
  }

  if (!detail?.result || typeof detail.result !== 'object') {
    return fallback
  }

  const result = detail.result as Record<string, unknown>
  const asNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null)
  const asText = (value: unknown): string | null => (typeof value === 'string' ? value : null)

  return {
    totalProcessed: asNumber(result.processed),
    success: asNumber(result.ok),
    error: asNumber(result.error),
    flowStatus: asText(result.status),
    message: asText(result.message),
    logPath: asText(result.log),
  }
}

function formatDateTime(value?: string | null): string {
  if (!value) {
    return 'N/D'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString()
}

function formatDuration(seconds?: number | null): string {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) {
    return 'N/D'
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  const rem = Math.round(seconds % 60)
  return `${minutes}m ${rem}s`
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.trim()
  if (!trimmed || trimmed === '/') {
    return '/'
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

function sectionFromPath(pathname: string): Section {
  const value = normalizePath(pathname).toLowerCase()
  if (value === '/procesar') {
    return 'procesar'
  }
  if (value === '/nomina') {
    return 'nomina'
  }
  if (value === '/configuracion') {
    return 'configuracion'
  }
  return 'cuenta'
}

function updateSectionPath(section: Section, mode: 'push' | 'replace'): void {
  if (typeof window === 'undefined') {
    return
  }
  const targetPath = sectionPathMap[section]
  if (normalizePath(window.location.pathname) === targetPath) {
    return
  }
  if (mode === 'replace') {
    window.history.replaceState({ section }, '', targetPath)
    return
  }
  window.history.pushState({ section }, '', targetPath)
}

function getProcessSortTimestamp(item: ProcessItem): number {
  const endedRaw = item.detail?.ended_at
  if (endedRaw) {
    const ended = new Date(endedRaw).getTime()
    if (!Number.isNaN(ended)) {
      return ended
    }
  }
  return item.createdAt
}

function App() {
  const [tenantId, setTenantId] = useState<string>(() => {
    if (typeof window === 'undefined') {
      return defaultTenant
    }
    const saved = window.localStorage.getItem(tenantStorageKey)?.trim()
    return saved || defaultTenant
  })
  const [activeSection, setActiveSection] = useState<Section>(() => {
    if (typeof window === 'undefined') {
      return 'cuenta'
    }
    return sectionFromPath(window.location.pathname)
  })
  const [isConnected, setIsConnected] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)

  const [pendingFiles, setPendingFiles] = useState<DriveFile[]>([])
  const [processLoading, setProcessLoading] = useState(false)
  const [processError, setProcessError] = useState('')
  const [refreshingProcessId, setRefreshingProcessId] = useState<string | null>(null)
  const [processItems, setProcessItems] = useState<ProcessItem[]>([])
  const [selectedProcess, setSelectedProcess] = useState<ProcessItem | null>(null)
  const [employees, setEmployees] = useState<DriveFolder[]>([])
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('')
  const [employeeYears, setEmployeeYears] = useState<DriveFolder[]>([])
  const [selectedYearFolderId, setSelectedYearFolderId] = useState('')
  const [nominaFiles, setNominaFiles] = useState<DriveFile[]>([])
  const [nominaLoading, setNominaLoading] = useState(false)
  const [nominaFilesLoading, setNominaFilesLoading] = useState(false)
  const [nominaError, setNominaError] = useState('')
  const [collaboratorSearch, setCollaboratorSearch] = useState('')
  const [collaboratorSort, setCollaboratorSort] = useState<SortOrder>('asc')

  const [showConnectRequiredModal, setShowConnectRequiredModal] = useState(false)
  const [oauthFeedback, setOauthFeedback] = useState<{ type: 'success' | 'error' | null; text: string }>({
    type: null,
    text: '',
  })

  const [storageLoading, setStorageLoading] = useState(false)
  const [storageError, setStorageError] = useState('')
  const [storageInfo, setStorageInfo] = useState<StorageStructureInfo | null>(null)
  const [showCreateStructureModal, setShowCreateStructureModal] = useState(false)
  const [pendingStructureData, setPendingStructureData] = useState<PendingStructureData | null>(null)
  const [showChooseReciboxModal, setShowChooseReciboxModal] = useState(false)
  const [rootFolders, setRootFolders] = useState<DriveFolder[]>([])
  const [rootFoldersLoading, setRootFoldersLoading] = useState(false)
  const [rootFoldersError, setRootFoldersError] = useState('')
  const [selectedRootFolderId, setSelectedRootFolderId] = useState('')
  const [adoptingReciboxFolder, setAdoptingReciboxFolder] = useState(false)
  const [showStorageConfirmModal, setShowStorageConfirmModal] = useState(false)
  const [pendingStorageAction, setPendingStorageAction] = useState<PendingStorageAction | null>(null)
  const [processingPreferencesLoading, setProcessingPreferencesLoading] = useState(false)
  const [processingPreferencesSaving, setProcessingPreferencesSaving] = useState(false)
  const [processingPreferencesError, setProcessingPreferencesError] = useState('')
  const [processingPreferencesSuccess, setProcessingPreferencesSuccess] = useState('')
  const [showCustomFilenameModal, setShowCustomFilenameModal] = useState(false)
  const [customFormatError, setCustomFormatError] = useState('')
  const [filenameFormatMode, setFilenameFormatMode] = useState<FilenameFormatMode>('mm_yyyy_employee')
  const [customFilenameFormat, setCustomFilenameFormat] = useState<FilenameCustomFormat>(defaultCustomFilenameFormat)
  const [employeeFolderNumberMode, setEmployeeFolderNumberMode] = useState<EmployeeFolderNumberMode>('indexed_number')
  const [showCustomEmployeeFolderModal, setShowCustomEmployeeFolderModal] = useState(false)
  const [customEmployeeFolderError, setCustomEmployeeFolderError] = useState('')
  const [employeeFolderCustomPart1, setEmployeeFolderCustomPart1] = useState('')
  const [employeeFolderCustomPart2, setEmployeeFolderCustomPart2] = useState('')
  const [autoCreateMissingEmployeeFolder, setAutoCreateMissingEmployeeFolder] = useState(true)
  const [cronDateTime, setCronDateTime] = useState('')
  const [retryOnError, setRetryOnError] = useState('0')
  const [notifyOnFailure, setNotifyOnFailure] = useState(false)
  const [processingPrefsInitial, setProcessingPrefsInitial] = useState<ProcessingPrefsSnapshot | null>(null)
  const [, setAutomationRulesInitial] = useState<AutomationRulesSnapshot | null>(null)
  const [, setAutomationRulesSaving] = useState(false)
  const [automationRulesSuccess, setAutomationRulesSuccess] = useState('')
  const [showProfilePopover, setShowProfilePopover] = useState(false)
  const profilePopoverRef = useRef<HTMLDivElement | null>(null)

  const syncTenantDriveConfig = useCallback(
    async (inputFolderId: string, rootFolderId: string, reciboxFolderId: string, targetTenantId = tenantId) => {
      const save = await putTenantDriveConfig(targetTenantId, {
        drive_input_folder_id: inputFolderId,
        drive_root_folder_id: rootFolderId,
        drive_recibox_folder_id: reciboxFolderId,
      })
      if (!save.ok) {
        setStorageError('La estructura existe pero no se pudo guardar la configuración del tenant.')
      }
    },
    [tenantId],
  )

  const refreshOAuthStatus = useCallback(
    async (showError = false, targetTenantId = tenantId): Promise<boolean> => {
      const response = await getGoogleOAuthStatus(targetTenantId)
      if (!response.ok) {
        if (showError) {
          setOauthFeedback({
            type: 'error',
            text: response.error || 'No se pudo verificar el estado de OAuth.',
          })
        }
        return false
      }
      const data = response.data
      const connected = Boolean(data?.has_token && data?.valid)
      setIsConnected(connected)
      return connected
    },
    [tenantId],
  )

  const verifyStorageStructure = useCallback(async (targetTenantId = tenantId) => {
    setStorageLoading(true)
    setStorageError('')

    const check = await checkReciboxStructure(targetTenantId, 'root')
    if (!check.ok || !check.data) {
      setStorageLoading(false)
      setStorageError('No se pudo verificar la estructura de carpetas en Drive.')
      setStorageInfo(null)
      return
    }

    const checkData = check.data as ReciboxStructureCheckResponse
    if (checkData.status === 'complete' && checkData.recibox_folder_id && checkData.input_folder_id) {
      await syncTenantDriveConfig(
        checkData.input_folder_id,
        checkData.parent_id || 'root',
        checkData.recibox_folder_id,
        targetTenantId,
      )
      setStorageInfo({
        parentId: checkData.parent_id,
        reciboxFolderId: checkData.recibox_folder_id,
        inputFolderId: checkData.input_folder_id,
      })
      setPendingStructureData(null)
      setShowCreateStructureModal(false)
      setStorageLoading(false)
      return
    }

    setStorageInfo(null)
    setStorageLoading(false)
    setPendingStructureData({ parentId: checkData.parent_id || 'root' })
    setShowCreateStructureModal(true)
  }, [tenantId, syncTenantDriveConfig])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    window.localStorage.setItem(tenantStorageKey, tenantId)
  }, [tenantId])

  useEffect(() => {
    updateSectionPath(activeSection, 'replace')
    // Run once to normalize initial path (e.g. "/" -> "/cuentas").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const createStorageStructure = useCallback(async () => {
    const parentId = pendingStructureData?.parentId || 'root'
    setStorageLoading(true)
    setStorageError('')
    const create = await createReciboxStructure(tenantId, parentId)
    setStorageLoading(false)
    if (!create.ok || !create.data) {
      setStorageError('No se pudo crear la estructura /root/RECIBOX/#0 INPUT.')
      setStorageInfo(null)
      return
    }

    setStorageInfo({
      parentId: create.data.parent_id,
      reciboxFolderId: create.data.root_folder.id,
      inputFolderId: create.data.input_folder.id,
    })
    await syncTenantDriveConfig(
      create.data.input_folder.id,
      create.data.parent_id || parentId,
      create.data.root_folder.id,
    )
    setPendingStructureData(null)
    setShowCreateStructureModal(false)
  }, [tenantId, pendingStructureData, syncTenantDriveConfig])

  const openChooseReciboxModal = useCallback(async () => {
    const parentId = pendingStructureData?.parentId || 'root'
    setShowChooseReciboxModal(true)
    setRootFoldersLoading(true)
    setRootFoldersError('')
    setSelectedRootFolderId('')
    const response = await listPickerFolders(tenantId, parentId)
    setRootFoldersLoading(false)

    if (!response.ok || !response.data) {
      setRootFolders([])
      setRootFoldersError(response.error || 'No se pudieron listar las carpetas en /root.')
      return
    }

    const folders = [...(response.data.folders || [])].sort(compareEmployeeFolders)
    setRootFolders(folders)
    if (folders.length > 0) {
      setSelectedRootFolderId(folders[0].id)
    }
  }, [tenantId, pendingStructureData])

  const adoptSelectedRootFolder = useCallback(async (folderId: string) => {
    const parentId = pendingStructureData?.parentId || 'root'

    setAdoptingReciboxFolder(true)
    setStorageError('')
    setRootFoldersError('')
    const response = await adoptReciboxFolder(tenantId, folderId, parentId)
    setAdoptingReciboxFolder(false)

    if (!response.ok || !response.data) {
      setRootFoldersError(response.error || 'No se pudo renombrar la carpeta seleccionada.')
      return
    }

    setStorageInfo({
      parentId: response.data.parent_id,
      reciboxFolderId: response.data.root_folder.id,
      inputFolderId: response.data.input_folder.id,
    })
    setPendingStructureData(null)
    setShowChooseReciboxModal(false)
    setShowCreateStructureModal(false)
  }, [tenantId, pendingStructureData])

  const requestCreateStorageStructure = useCallback(() => {
    setPendingStorageAction({ kind: 'create' })
    setShowStorageConfirmModal(true)
  }, [])

  const requestAdoptSelectedRootFolder = useCallback(() => {
    if (!selectedRootFolderId) {
      setRootFoldersError('Selecciona una carpeta.')
      return
    }
    const selectedFolder = rootFolders.find((folder) => folder.id === selectedRootFolderId)
    setPendingStorageAction({
      kind: 'adopt',
      folderId: selectedRootFolderId,
      folderName: selectedFolder?.name || 'la carpeta seleccionada',
    })
    setShowStorageConfirmModal(true)
  }, [rootFolders, selectedRootFolderId])

  const confirmStorageAction = useCallback(async () => {
    const action = pendingStorageAction
    if (!action) {
      return
    }
    setShowStorageConfirmModal(false)
    setPendingStorageAction(null)
    if (action.kind === 'create') {
      await createStorageStructure()
      return
    }
    await adoptSelectedRootFolder(action.folderId)
  }, [pendingStorageAction, createStorageStructure, adoptSelectedRootFolder])

  const cancelStorageAction = useCallback(() => {
    setShowStorageConfirmModal(false)
    setPendingStorageAction(null)
  }, [])

  const loadProcessingPreferences = useCallback(async () => {
    setProcessingPreferencesLoading(true)
    setProcessingPreferencesError('')
    setProcessingPreferencesSuccess('')
    const response = await getProcessingPreferences(tenantId)
    setProcessingPreferencesLoading(false)
    if (!response.ok || !response.data) {
      setProcessingPreferencesError(response.error || 'No se pudo cargar la configuración de preferencias.')
      return
    }
    const data = response.data as ProcessingPreferences
    setFilenameFormatMode(data.filename_format_mode)
    setCustomFilenameFormat(data.filename_custom_format || defaultCustomFilenameFormat)
    setEmployeeFolderNumberMode(data.employee_folder_number_mode || 'indexed_number')
    setEmployeeFolderCustomPart1((data.employee_folder_number_custom_part1 || '').trim())
    setEmployeeFolderCustomPart2((data.employee_folder_number_custom_part2 || '').trim())
    setAutoCreateMissingEmployeeFolder(data.auto_create_missing_employee_folder !== false)
    setProcessingPrefsInitial({
      filenameFormatMode: data.filename_format_mode,
      customFilenameFormat: data.filename_custom_format || defaultCustomFilenameFormat,
      employeeFolderNumberMode: data.employee_folder_number_mode || 'indexed_number',
      employeeFolderCustomPart1: (data.employee_folder_number_custom_part1 || '').trim(),
      employeeFolderCustomPart2: (data.employee_folder_number_custom_part2 || '').trim(),
      autoCreateMissingEmployeeFolder: data.auto_create_missing_employee_folder !== false,
    })

    const automationDefaults: AutomationRulesSnapshot = {
      cronDateTime: '',
      retryOnError: '0',
      notifyOnFailure: false,
    }
    if (typeof window === 'undefined') {
      setCronDateTime(automationDefaults.cronDateTime)
      setRetryOnError(automationDefaults.retryOnError)
      setNotifyOnFailure(automationDefaults.notifyOnFailure)
      setAutomationRulesInitial(automationDefaults)
      return
    }
    const storageKey = `recibox:automation-rules:${tenantId}`
    const saved = window.localStorage.getItem(storageKey)
    if (!saved) {
      setCronDateTime(automationDefaults.cronDateTime)
      setRetryOnError(automationDefaults.retryOnError)
      setNotifyOnFailure(automationDefaults.notifyOnFailure)
      setAutomationRulesInitial(automationDefaults)
      return
    }
    try {
      const parsed = JSON.parse(saved) as Partial<AutomationRulesSnapshot>
      const snapshot: AutomationRulesSnapshot = {
        cronDateTime: String(parsed.cronDateTime || ''),
        retryOnError: ['0', '1', '2', '3'].includes(String(parsed.retryOnError)) ? String(parsed.retryOnError) : '0',
        notifyOnFailure: Boolean(parsed.notifyOnFailure),
      }
      setCronDateTime(snapshot.cronDateTime)
      setRetryOnError(snapshot.retryOnError)
      setNotifyOnFailure(snapshot.notifyOnFailure)
      setAutomationRulesInitial(snapshot)
    } catch {
      setCronDateTime(automationDefaults.cronDateTime)
      setRetryOnError(automationDefaults.retryOnError)
      setNotifyOnFailure(automationDefaults.notifyOnFailure)
      setAutomationRulesInitial(automationDefaults)
    }
  }, [tenantId])

  const saveProcessingPreferences = useCallback(async () => {
    if (filenameFormatMode === 'custom' && !hasAnyCustomFilenamePart(customFilenameFormat)) {
      setProcessingPreferencesError('En formato custom, al menos un campo debe tener información.')
      return
    }
    if (employeeFolderNumberMode === 'custom') {
      if (!employeeFolderCustomPart1 && !employeeFolderCustomPart2) {
        setProcessingPreferencesError('En carpeta empleado custom, al menos un campo debe tener información.')
        return
      }
    }
    setProcessingPreferencesSaving(true)
    setProcessingPreferencesError('')
    setProcessingPreferencesSuccess('')
    const response = await putProcessingPreferences(tenantId, {
      tenant_id: tenantId,
      filename_format_mode: filenameFormatMode,
      filename_custom_format: customFilenameFormat,
      employee_folder_number_mode: employeeFolderNumberMode,
      employee_folder_number_custom_part1: employeeFolderCustomPart1,
      employee_folder_number_custom_part2: employeeFolderCustomPart2,
      auto_create_missing_employee_folder: autoCreateMissingEmployeeFolder,
    })
    setProcessingPreferencesSaving(false)
    if (!response.ok || !response.data) {
      setProcessingPreferencesError(response.error || 'No se pudo guardar la configuración de preferencias.')
      return
    }
    setFilenameFormatMode(response.data.filename_format_mode)
    setCustomFilenameFormat(response.data.filename_custom_format || defaultCustomFilenameFormat)
    setEmployeeFolderNumberMode(response.data.employee_folder_number_mode || 'indexed_number')
    setEmployeeFolderCustomPart1((response.data.employee_folder_number_custom_part1 || '').trim())
    setEmployeeFolderCustomPart2((response.data.employee_folder_number_custom_part2 || '').trim())
    setAutoCreateMissingEmployeeFolder(response.data.auto_create_missing_employee_folder !== false)
    setProcessingPrefsInitial({
      filenameFormatMode: response.data.filename_format_mode,
      customFilenameFormat: response.data.filename_custom_format || defaultCustomFilenameFormat,
      employeeFolderNumberMode: response.data.employee_folder_number_mode || 'indexed_number',
      employeeFolderCustomPart1: (response.data.employee_folder_number_custom_part1 || '').trim(),
      employeeFolderCustomPart2: (response.data.employee_folder_number_custom_part2 || '').trim(),
      autoCreateMissingEmployeeFolder: response.data.auto_create_missing_employee_folder !== false,
    })
    setProcessingPreferencesSuccess('Preferencias guardadas.')
  }, [
    tenantId,
    filenameFormatMode,
    customFilenameFormat,
    employeeFolderNumberMode,
    employeeFolderCustomPart1,
    employeeFolderCustomPart2,
    autoCreateMissingEmployeeFolder,
  ])

  const hasProcessingChanges = useMemo(() => {
    if (!processingPrefsInitial) {
      return false
    }
    const customA = JSON.stringify(processingPrefsInitial.customFilenameFormat)
    const customB = JSON.stringify(customFilenameFormat)
    return (
      processingPrefsInitial.filenameFormatMode !== filenameFormatMode ||
      customA !== customB ||
      processingPrefsInitial.employeeFolderNumberMode !== employeeFolderNumberMode ||
      processingPrefsInitial.employeeFolderCustomPart1 !== employeeFolderCustomPart1 ||
      processingPrefsInitial.employeeFolderCustomPart2 !== employeeFolderCustomPart2 ||
      processingPrefsInitial.autoCreateMissingEmployeeFolder !== autoCreateMissingEmployeeFolder
    )
  }, [
    processingPrefsInitial,
    filenameFormatMode,
    customFilenameFormat,
    employeeFolderNumberMode,
    employeeFolderCustomPart1,
    employeeFolderCustomPart2,
    autoCreateMissingEmployeeFolder,
  ])

  const saveAutomationRules = useCallback(async () => {
    setAutomationRulesSaving(true)
    if (typeof window !== 'undefined') {
      const storageKey = `recibox:automation-rules:${tenantId}`
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          cronDateTime,
          retryOnError,
          notifyOnFailure,
        }),
      )
    }
    const snapshot: AutomationRulesSnapshot = { cronDateTime, retryOnError, notifyOnFailure }
    setAutomationRulesInitial(snapshot)
    setAutomationRulesSuccess('Reglas guardadas.')
    setAutomationRulesSaving(false)
  }, [tenantId, cronDateTime, retryOnError, notifyOnFailure])

  const onFilenameFormatChange = useCallback((mode: FilenameFormatMode) => {
    setFilenameFormatMode(mode)
    setProcessingPreferencesSuccess('')
    setProcessingPreferencesError('')
    if (mode === 'custom') {
      setCustomFormatError('')
      setShowCustomFilenameModal(true)
    }
  }, [])

  const onEmployeeFolderModeChange = useCallback((mode: EmployeeFolderNumberMode) => {
    setEmployeeFolderNumberMode(mode)
    setProcessingPreferencesSuccess('')
    setProcessingPreferencesError('')
    if (mode === 'custom') {
      setCustomEmployeeFolderError('')
      setShowCustomEmployeeFolderModal(true)
    }
  }, [])

  const updateCustomFormatField = useCallback(
    <K extends keyof FilenameCustomFormat,>(key: K, value: FilenameCustomFormat[K]) => {
      setCustomFormatError('')
      setProcessingPreferencesError('')
      setCustomFilenameFormat((prev) => ({ ...prev, [key]: value }))
    },
    [],
  )

  useEffect(() => {
    async function init() {
      const connected = await refreshOAuthStatus(false)
      if (connected) {
        await verifyStorageStructure()
      }
      setInitialLoading(false)
    }
    init()
  }, [refreshOAuthStatus, verifyStorageStructure])

  useEffect(() => {
    function onMessage(event: MessageEvent<OAuthMessage>) {
      if (!event.data || event.data.source !== 'recibox-oauth') {
        return
      }
      if (event.data.ok) {
        const oauthTenantId = (event.data.tenant_id || '').trim()
        const resolvedTenantId = oauthTenantId || tenantId
        if (oauthTenantId) {
          setTenantId(oauthTenantId)
        }
        refreshOAuthStatus(false, resolvedTenantId).then((connected) => {
          if (connected) {
            verifyStorageStructure(resolvedTenantId)
          }
        })
        setOauthFeedback({ type: null, text: '' })
        return
      }
      setOauthFeedback({
        type: 'error',
        text: event.data.message || 'No se pudo completar la conexion OAuth.',
      })
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [refreshOAuthStatus, tenantId, verifyStorageStructure])

  useEffect(() => {
    function onDocumentPointerDown(event: MouseEvent) {
      if (!profilePopoverRef.current) {
        return
      }
      const target = event.target as Node | null
      if (!target || profilePopoverRef.current.contains(target)) {
        return
      }
      setShowProfilePopover(false)
    }

    if (!showProfilePopover) {
      return
    }

    document.addEventListener('mousedown', onDocumentPointerDown)
    return () => {
      document.removeEventListener('mousedown', onDocumentPointerDown)
    }
  }, [showProfilePopover])

  function connectGoogleDrive() {
    const nextTenantId = (tenantId || defaultTenant).trim() || defaultTenant
    setTenantId(nextTenantId)
    const url = `${apiBasePath}/auth/google/login?tenant_id=${encodeURIComponent(nextTenantId)}&popup=true`
    const width = 560
    const height = 700
    const left = Math.max(0, window.screenX + Math.round((window.outerWidth - width) / 2))
    const top = Math.max(0, window.screenY + Math.round((window.outerHeight - height) / 2))
    const popup = window.open(
      url,
      'recibox-google-oauth',
      `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`,
    )

    if (!popup) {
      window.location.href = url
      return
    }

    setOauthFeedback({ type: null, text: '' })
  }

  async function disconnectGoogleDrive() {
    setActionLoading(true)
    const response = await unlinkGoogleOAuth(tenantId)
    setActionLoading(false)

    if (!response.ok) {
      setOauthFeedback({
        type: 'error',
        text: response.error || 'No se pudo desconectar la cuenta.',
      })
      return
    }

    setIsConnected(false)
    applySectionChange('cuenta', 'replace')
    setOauthFeedback({ type: null, text: '' })
    setStorageInfo(null)
    setStorageError('')
    setPendingStructureData(null)
    setShowCreateStructureModal(false)
    setProcessItems([])
    setSelectedProcess(null)
  }

  const loadPendingFiles = useCallback(async () => {
    if (!isConnected) {
      setPendingFiles([])
      setProcessError('')
      setShowConnectRequiredModal(true)
      return
    }

    setProcessLoading(true)
    setProcessError('')
    const response = await listDriveFiles(tenantId)
    setProcessLoading(false)

    if (!response.ok) {
      setPendingFiles([])
      const lowered = (response.error || '').toLowerCase()
      if (lowered.includes('unlinked') || lowered.includes('oauth')) {
        setProcessError('Necesitás conectar una cuenta de Google Drive para procesar.')
        setShowConnectRequiredModal(true)
      } else {
        setProcessError('No se pudieron listar los archivos de INPUT.')
      }
      return
    }

    setPendingFiles(response.data?.files ?? [])
  }, [tenantId, isConnected])

  const loadNominaFilesForFolder = useCallback(
    async (folderId: string) => {
      if (!folderId) {
        setNominaFiles([])
        return
      }
      setNominaFilesLoading(true)
      const filesRes = await listFilesInFolder(tenantId, folderId)
      setNominaFilesLoading(false)
      if (!filesRes.ok) {
        setNominaError('No se pudieron listar los archivos del empleado/año seleccionado.')
        setNominaFiles([])
        return
      }
      setNominaFiles(filesRes.data?.files ?? [])
    },
    [tenantId],
  )

  const loadYearsForEmployee = useCallback(
    async (employeeFolderId: string) => {
      setNominaFiles([])
      setEmployeeYears([])
      setSelectedYearFolderId('')
      if (!employeeFolderId) {
        return
      }
      const yearsRes = await listEmployeeYears(tenantId, employeeFolderId)
      if (!yearsRes.ok) {
        setNominaError('No se pudieron listar los años del empleado seleccionado.')
        return
      }
      const years = yearsRes.data?.folders ?? []
      setEmployeeYears(years)
      const defaultYear = years[0]?.id || ''
      setSelectedYearFolderId(defaultYear)
      if (defaultYear) {
        await loadNominaFilesForFolder(defaultYear)
      }
    },
    [tenantId, loadNominaFilesForFolder],
  )

  const loadNominaEmployees = useCallback(async () => {
    if (!isConnected) {
      setShowConnectRequiredModal(true)
      return
    }
    setNominaLoading(true)
    setNominaError('')
    const res = await listEmployeeFolders(tenantId)
    setNominaLoading(false)
    if (!res.ok) {
      setNominaError('No se pudieron listar empleados.')
      setEmployees([])
      return
    }
    const filtered = (res.data?.folders ?? []).filter((folder) => folder.name !== '#0 INPUT')
    const sorted = [...filtered].sort(compareEmployeeFolders)
    setEmployees(sorted)
    if (sorted.length === 0) {
      setSelectedEmployeeId('')
      setEmployeeYears([])
      setSelectedYearFolderId('')
      setNominaFiles([])
      return
    }
    const selected = sorted[0].id
    setSelectedEmployeeId(selected)
    await loadYearsForEmployee(selected)
  }, [isConnected, tenantId, loadYearsForEmployee])

  const refreshPendingFiles = useCallback(() => {
    void loadPendingFiles()
  }, [loadPendingFiles])

  const applySectionChange = useCallback(
    (section: Section, mode: 'push' | 'replace' | 'none' = 'push') => {
      if ((section === 'procesar' || section === 'nomina' || section === 'configuracion') && !isConnected) {
        setShowConnectRequiredModal(true)
        setActiveSection('cuenta')
        updateSectionPath('cuenta', 'replace')
        return
      }

      setActiveSection(section)
      if (mode !== 'none') {
        updateSectionPath(section, mode)
      }
      if (section === 'procesar') {
        refreshPendingFiles()
      }
      if (section === 'nomina') {
        void loadNominaEmployees()
      }
      if (section === 'configuracion') {
        void loadProcessingPreferences()
      }
    },
    [isConnected, loadNominaEmployees, loadProcessingPreferences, refreshPendingFiles],
  )

  useEffect(() => {
    if (activeSection !== 'procesar' || !isConnected) {
      return
    }

    function refreshOnFocus() {
      refreshPendingFiles()
    }

    function refreshOnVisibility() {
      if (document.visibilityState === 'visible') {
        refreshPendingFiles()
      }
    }

    window.addEventListener('focus', refreshOnFocus)
    document.addEventListener('visibilitychange', refreshOnVisibility)
    return () => {
      window.removeEventListener('focus', refreshOnFocus)
      document.removeEventListener('visibilitychange', refreshOnVisibility)
    }
  }, [activeSection, isConnected, refreshPendingFiles])

  useEffect(() => {
    if (activeSection !== 'procesar' || !isConnected) {
      return
    }
    const timer = window.setTimeout(() => {
      refreshPendingFiles()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activeSection, isConnected, refreshPendingFiles])

  useEffect(() => {
    function onPopState() {
      applySectionChange(sectionFromPath(window.location.pathname), 'none')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [applySectionChange])

  useEffect(() => {
    if (initialLoading || isConnected) {
      return
    }
    if (activeSection === 'procesar' || activeSection === 'nomina' || activeSection === 'configuracion') {
      setShowConnectRequiredModal(true)
      applySectionChange('cuenta', 'replace')
    }
  }, [activeSection, applySectionChange, initialLoading, isConnected])

  function handleSectionChange(section: Section) {
    applySectionChange(section, 'push')
  }

  async function triggerProcess() {
    if (!isConnected) {
      setShowConnectRequiredModal(true)
      return
    }

    setProcessError('')
    const response = await ingestDrive(tenantId)

    if (!response.ok || !response.data?.job_id) {
      const lowered = (response.error || '').toLowerCase()
      if (lowered.includes('unlinked') || lowered.includes('oauth')) {
        setProcessError('Necesitás conectar una cuenta de Google Drive para procesar.')
        setShowConnectRequiredModal(true)
      } else {
        setProcessError(response.error || 'No se pudo iniciar el proceso.')
      }
      return
    }

    const now = Date.now()
    const item: ProcessItem = {
      id: `${response.data.job_id}-${now}`,
      jobId: response.data.job_id,
      name: `Proceso ${new Date(now).toLocaleString()}`,
      state: 'running',
      detail: null,
      createdAt: now,
    }

    setProcessItems((prev) => [item, ...prev])
  }

  function openInputFolder() {
    if (!storageInfo?.inputFolderId) {
      setProcessError('No se pudo resolver la carpeta INPUT para abrirla.')
      return
    }
    window.open(`https://drive.google.com/drive/folders/${storageInfo.inputFolderId}`, '_blank')
    setTimeout(() => {
      if (activeSection === 'procesar') {
        refreshPendingFiles()
      }
    }, 800)
  }

  function openDriveFile(fileId: string) {
    window.open(`https://drive.google.com/file/d/${fileId}/view`, '_blank')
  }

  function downloadDriveFile(fileId: string) {
    const url = `${apiBasePath}/drive/files/${encodeURIComponent(fileId)}/download?tenant_id=${encodeURIComponent(tenantId)}`
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  async function refreshProcess(item: ProcessItem) {
    setRefreshingProcessId(item.id)
    const response = await getJobStatus(item.jobId)
    setRefreshingProcessId(null)

    if (!response.ok || !response.data) {
      setProcessError('No se pudo actualizar el estado del proceso.')
      return
    }

    const nextState = mapJobState(response.data.status, response.data)
    const updatedItem: ProcessItem = {
      ...item,
      state: nextState,
      detail: response.data,
    }

    setProcessItems((prev) => prev.map((entry) => (entry.id === updatedItem.id ? updatedItem : entry)))
    setSelectedProcess((prev) => (prev && prev.id === updatedItem.id ? updatedItem : prev))

    if (nextState !== 'running') {
      loadPendingFiles()
    }
  }

  const latestTerminalProcess = useMemo(() => {
    return processItems
      .filter((item) => item.state !== 'running')
      .sort((a, b) => getProcessSortTimestamp(b) - getProcessSortTimestamp(a))[0] ?? null
  }, [processItems])

  const latestMetrics = useMemo(() => extractRunMetrics(latestTerminalProcess?.detail ?? null), [latestTerminalProcess])

  const processedCount = latestMetrics.success ?? 0
  const errorCount = latestMetrics.error ?? 0
  const visibleEmployees = useMemo(() => {
    const query = normalizeSearchText(collaboratorSearch)
    const filtered = employees.filter((employee) => normalizeSearchText(employee.name).includes(query))
    return [...filtered].sort((a, b) => {
      const cmp = compareEmployeeFolders(a, b)
      return collaboratorSort === 'asc' ? cmp : -cmp
    })
  }, [employees, collaboratorSearch, collaboratorSort])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <img className="brand-icon" src="/assets/branding/recibox-logo.png" alt="RECIBOX" />
          <span className="brand-text">RECIBOX</span>
        </div>
        <div className="topbar-right">
          <div className="profile-popover-wrap" ref={profilePopoverRef}>
            <button
              type="button"
              className="profile-trigger"
              onClick={() => setShowProfilePopover((prev) => !prev)}
              aria-label="Abrir perfil"
              aria-expanded={showProfilePopover}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-4.2 0-7 2.1-7 5v1h14v-1c0-2.9-2.8-5-7-5Z" />
              </svg>
            </button>
            {showProfilePopover && (
              <div className="profile-popover" role="dialog" aria-label="Detalle de usuario">
                <p className="profile-popover-title">Detalle del usuario</p>
                <p className="profile-popover-line">
                  <span>Tenant</span>
                  <strong>{tenantId}</strong>
                </p>
                <p className="profile-popover-line">
                  <span>Estado</span>
                  <strong>{isConnected ? 'Conectado' : 'Sin conectar'}</strong>
                </p>
                <button type="button" className="profile-logout-btn" onClick={() => {}}>
                  Cerrar sesion
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="body-layout">
        <aside className="sidebar">
          <nav className="menu">
            <button
              type="button"
              className={`menu-item ${activeSection === 'cuenta' ? 'active' : ''}`}
              onClick={() => handleSectionChange('cuenta')}
            >
              Cuenta
            </button>
            <button
              type="button"
              className={`menu-item ${activeSection === 'procesar' ? 'active' : ''}`}
              onClick={() => handleSectionChange('procesar')}
            >
              Procesar
            </button>
            <button
              type="button"
              className={`menu-item ${activeSection === 'nomina' ? 'active' : ''}`}
              onClick={() => handleSectionChange('nomina')}
            >
              Nomina
            </button>
            <button
              type="button"
              className={`menu-item ${activeSection === 'configuracion' ? 'active' : ''}`}
              onClick={() => handleSectionChange('configuracion')}
            >
              Configuracion
            </button>
          </nav>
        </aside>

        {activeSection === 'cuenta' && (
          <main className={`content ${isConnected ? 'connected-mode' : ''}`}>
            {initialLoading ? (
              <section className="main-card" aria-label="Cargando estado OAuth">
                <h1>Cargando</h1>
                <h2>Verificando conexión de Google Drive...</h2>
              </section>
            ) : isConnected ? (
              <>
                <section className="connected-card" aria-label="Cuenta conectada">
                  <div className="connected-left">
                    <div className="drive-badge">
                      <img className="drive-mini" src="/assets/branding/google-drive-logo.png" alt="Google Drive" />
                    </div>
                    <div className="connected-text">
                      <h3>Cuenta conectada</h3>
                      <p>Nombre del usuario</p>
                    </div>
                  </div>
                  <button type="button" className="disconnect-btn" onClick={disconnectGoogleDrive} disabled={actionLoading}>
                    {actionLoading ? 'Desconectando...' : 'Desconectar'}
                  </button>
                </section>

                <section className="storage-card" aria-label="Ubicación de almacenamiento">
                  <h4>Ruta de almacenamiento</h4>
                  {storageLoading && <p>Verificando estructura /root/RECIBOX/#0 INPUT...</p>}
                  {!storageLoading && storageError && <p className="oauth-feedback error">{storageError}</p>}
                  {!storageLoading && !storageError && storageInfo && (
                    <div className="storage-row">
                      <p>Mi Drive/Recibox</p>
                      <button
                        type="button"
                        className="open-storage-btn"
                        onClick={() => window.open(`https://drive.google.com/drive/folders/${storageInfo.reciboxFolderId}`, '_blank')}
                      >
                        Abrir
                      </button>
                    </div>
                  )}
                </section>
              </>
            ) : (
              <section className="main-card" aria-label="Conectar Google Drive">
                <h1>Para iniciar</h1>
                <h2 className="connect-title">Conectá con tu cuenta de Google Drive</h2>

                <div className="logos-row">
                  <img className="recibox-large" src="/assets/branding/recibox-logo.png" alt="Recibox" />
                  <span className="arrow">→</span>
                  <div className="drive-wrap">
                    <img className="drive-large" src="/assets/branding/google-drive-logo.png" alt="Google Drive" />
                  </div>
                </div>

                <button type="button" className="connect-btn" onClick={connectGoogleDrive}>
                  Conectar
                </button>
              </section>
            )}
            {oauthFeedback.type && <p className={`oauth-feedback ${oauthFeedback.type}`}>{oauthFeedback.text}</p>}
          </main>
        )}

        {activeSection === 'procesar' && isConnected && (
          <main className="content process-content">
            <div className="process-grid">
              <section className="summary-card" aria-label="Archivos pendientes">
                <p>Archivos pendientes de procesar</p>
                <strong>{pendingFiles.length}</strong>
                <span>Archivos PDF</span>
              </section>
              <section className="summary-card" aria-label="Archivos procesados">
                <p>Archivos procesados</p>
                <strong>{processedCount}</strong>
                <span>Archivos PDF</span>
              </section>
              <section className="summary-card" aria-label="Archivos con error">
                <p>Archivos que no se pudieron procesar</p>
                <strong>{errorCount}</strong>
                <span>Archivos PDF</span>
              </section>

              <section className="pending-card" aria-label="Tabla de pendientes">
                <div className="pending-header">
                  <h3>Pendientes de procesar</h3>
                  <button
                    type="button"
                    className="refresh-files-btn"
                    onClick={refreshPendingFiles}
                    disabled={processLoading}
                    aria-label="Actualizar archivos pendientes"
                    title="Actualizar"
                  >
                    ↻
                  </button>
                </div>
                <div className="pending-table-wrapper">
                  <table className="pending-table">
                    <tbody>
                      {processLoading && (
                        <tr>
                          <td>Cargando archivos...</td>
                        </tr>
                      )}
                      {!processLoading && pendingFiles.length === 0 && !processError && (
                        <tr>
                          <td>Sin archivos PDF pendientes.</td>
                        </tr>
                      )}
                      {!processLoading &&
                        pendingFiles.map((file) => (
                          <tr key={file.id}>
                            <td title={file.name}>{file.name}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <div className="process-cta-row">
                  <button
                    type="button"
                    className="process-btn"
                    onClick={triggerProcess}
                    disabled={processLoading || pendingFiles.length === 0}
                  >
                    Procesar
                  </button>
                  <button
                    type="button"
                    className="add-files-btn"
                    onClick={openInputFolder}
                    disabled={processLoading}
                  >
                    Agregar archivos
                  </button>
                </div>
              </section>

              <section className="jobs-card" aria-label="Tabla de procesos">
                <table className="jobs-table">
                  <thead>
                    <tr>
                      <th>Procesos</th>
                      <th>Estado</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {processItems.length === 0 && (
                      <tr>
                        <td colSpan={3}>Sin procesos ejecutados todavía.</td>
                      </tr>
                    )}
                    {processItems.map((item) => (
                      <tr key={item.id}>
                        <td title={item.jobId}>{item.name}</td>
                        <td>
                          {item.state === 'running' && (
                            <span className="status running">
                              <span className="spinner" /> Ejecutando
                            </span>
                          )}
                          {item.state === 'success' && <span className="status success">✓ Exitoso</span>}
                          {item.state === 'error' && <span className="status error">✕ Error</span>}
                        </td>
                        <td>
                          {item.state === 'running' ? (
                            <button
                              type="button"
                              className="link-btn"
                              onClick={() => refreshProcess(item)}
                              disabled={refreshingProcessId === item.id}
                            >
                              {refreshingProcessId === item.id ? 'Actualizando...' : 'Actualizar'}
                            </button>
                          ) : (
                            <button type="button" className="link-btn" onClick={() => setSelectedProcess(item)}>
                              Ver
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {processError && <p className="oauth-feedback error">{processError}</p>}
              </section>
            </div>
          </main>
        )}

        {activeSection === 'configuracion' && isConnected && (
          <main className="content process-content">
            <div className="process-layout settings-layout">
              <h3 className="settings-page-title">Configuracion de preferencias</h3>
              <div className="settings-cards-grid">
                <section className="pending-card settings-card" aria-label="Configuración de preferencias">
                  <div className="settings-body">
                    <h4>Procesador de documentos</h4>
                    <div className="settings-field">
                      <label htmlFor="filename-format-select">Nombre del archivo</label>
                      <select
                        id="filename-format-select"
                        className="year-select"
                        value={filenameFormatMode}
                        onChange={(event) => onFilenameFormatChange(event.target.value as FilenameFormatMode)}
                        disabled={processingPreferencesLoading || processingPreferencesSaving}
                      >
                        <option value="mm_yyyy_employee">MM-YYYY) Nombre del colaborador</option>
                        <option value="yyyy_mm_employee">YYYY-MM) Nombre del colaborador</option>
                        <option value="yyyy_employee">YYYY) Nombre del colaborador</option>
                        <option value="custom">Custom</option>
                      </select>
                    </div>
                    <p className="settings-preview">
                      <strong>Vista previa:</strong> {buildFilenamePreview(filenameFormatMode, customFilenameFormat)}
                    </p>
                    <hr className="settings-divider" />
                    <div className="settings-field settings-field-inline-label">
                      <label>Nombre de carpeta del colaborador</label>
                    </div>
                    <div className="settings-inline-row">
                      <div className="settings-field">
                        <select
                          id="employee-folder-mode-select"
                          className="year-select"
                          value={employeeFolderNumberMode}
                          onChange={(event) => onEmployeeFolderModeChange(event.target.value as EmployeeFolderNumberMode)}
                          disabled={processingPreferencesLoading || processingPreferencesSaving}
                        >
                          <option value="indexed_number">#Numero</option>
                          <option value="number_only">Numero</option>
                          <option value="no_index">Sin indice</option>
                          <option value="custom">Custon (indice fijo)</option>
                        </select>
                      </div>
                      <div className="settings-fixed-field" aria-label="Campo fijo de carpeta empleado">
                        <div className="settings-fixed-value">Nombre del colaborador</div>
                      </div>
                    </div>
                    <p className="settings-preview">
                      <strong>Vista previa:</strong>{' '}
                      {buildEmployeeFolderPreview(
                        employeeFolderNumberMode,
                        employeeFolderCustomPart1,
                        employeeFolderCustomPart2,
                      )}
                    </p>
                    <p className="settings-hint">Si el indice tiene numero sera incremental.</p>
                    <hr className="settings-divider" />
                    <div className="settings-field settings-field-inline-label">
                      <label>Existencia del colaborador</label>
                    </div>
                    <p className="settings-preview">
                      Si el colaborador aun no fue registrado en la nomina ¿Desea crear automaticamente la carpeta?
                    </p>
                    <div className="settings-radio-row" role="radiogroup" aria-label="Crear carpeta de colaborador automáticamente">
                      <label className="settings-radio-option">
                        <input
                          type="radio"
                          name="auto-create-collaborator-folder"
                          checked={autoCreateMissingEmployeeFolder}
                          onChange={() => setAutoCreateMissingEmployeeFolder(true)}
                          disabled={processingPreferencesLoading || processingPreferencesSaving}
                        />
                        <span>Si</span>
                      </label>
                      <label className="settings-radio-option">
                        <input
                          type="radio"
                          name="auto-create-collaborator-folder"
                          checked={!autoCreateMissingEmployeeFolder}
                          onChange={() => setAutoCreateMissingEmployeeFolder(false)}
                          disabled={processingPreferencesLoading || processingPreferencesSaving}
                        />
                        <span>No (El archivo no se procesará generando un error)</span>
                      </label>
                    </div>
                    <div className="settings-actions settings-actions-bottom">
                      <button
                        type="button"
                        className="modal-primary"
                        onClick={() => void saveProcessingPreferences()}
                        disabled={processingPreferencesLoading || processingPreferencesSaving || !hasProcessingChanges}
                      >
                        {processingPreferencesSaving ? 'Guardando...' : 'Guardar'}
                      </button>
                    </div>
                    {processingPreferencesError && <p className="oauth-feedback error">{processingPreferencesError}</p>}
                    {processingPreferencesSuccess && <p className="oauth-feedback success">{processingPreferencesSuccess}</p>}
                  </div>
                </section>

                <section className="pending-card settings-card" aria-label="Reglas de automatizacion">
                  <div className="settings-body">
                    <div className="settings-card-header">
                      <h4>Reglas de automatizacion</h4>
                      <span className="settings-chip">Proximamente disponible</span>
                    </div>
                    <p className="settings-preview">
                      Reglas de automatizacion le permite configurar un CRON para disparar el procesamiento de archivos
                      automaticamente. Se debe hacer la carga previa de archivos a procesar, si no se encuentran
                      archivos el proceso fallará.
                    </p>
                    <hr className="settings-divider" />
                    <div className="settings-field">
                      <label htmlFor="cron-datetime">Croneo</label>
                      <input
                        id="cron-datetime"
                        className="settings-input"
                        type="datetime-local"
                        value={cronDateTime}
                        onChange={(event) => {
                          setCronDateTime(event.target.value)
                          setAutomationRulesSuccess('')
                        }}
                      />
                    </div>
                    <hr className="settings-divider" />
                    <div className="settings-field settings-field-inline-label">
                      <label>Errores</label>
                    </div>
                    <div className="settings-field">
                      <label htmlFor="retry-on-error">En caso de errores repetir el procesamiento:</label>
                      <select
                        id="retry-on-error"
                        className="year-select"
                        value={retryOnError}
                        onChange={(event) => {
                          setRetryOnError(event.target.value)
                          setAutomationRulesSuccess('')
                        }}
                      >
                        <option value="0">0</option>
                        <option value="1">1</option>
                        <option value="2">2</option>
                        <option value="3">3</option>
                      </select>
                    </div>
                    <div className="settings-field">
                      <label>Si falla, notificarme:</label>
                      <div className="settings-radio-row" role="radiogroup" aria-label="Notificación por falla">
                        <label className="settings-radio-option">
                          <input
                            type="radio"
                            name="notify-on-failure"
                            checked={notifyOnFailure}
                            onChange={() => {
                              setNotifyOnFailure(true)
                              setAutomationRulesSuccess('')
                            }}
                          />
                          <span>Si</span>
                        </label>
                        <label className="settings-radio-option">
                          <input
                            type="radio"
                            name="notify-on-failure"
                            checked={!notifyOnFailure}
                            onChange={() => {
                              setNotifyOnFailure(false)
                              setAutomationRulesSuccess('')
                            }}
                          />
                          <span>No</span>
                        </label>
                      </div>
                    </div>
                    <div className="settings-actions settings-actions-bottom">
                      <button
                        type="button"
                        className="modal-primary modal-primary-disabled"
                        onClick={() => void saveAutomationRules()}
                        disabled
                      >
                        Guardar
                      </button>
                    </div>
                    {automationRulesSuccess && <p className="oauth-feedback success">{automationRulesSuccess}</p>}
                  </div>
                </section>
              </div>
            </div>
          </main>
        )}

        {activeSection === 'nomina' && isConnected && (
          <main className="content process-content">
            <div className="nomina-grid">
              <div className="nomina-left-col">
                <section className="summary-card" aria-label="Colaboradores activos">
                  <p>Colaboradores activos</p>
                  <strong>{employees.length}</strong>
                  <span>Total</span>
                </section>

                <section className="pending-card" aria-label="Tabla de colaboradores">
                  <div className="pending-header">
                    <h3>Colaboradores</h3>
                  </div>
                  <div className="collaborator-toolbar">
                    <input
                      className="collaborator-search"
                      type="text"
                      value={collaboratorSearch}
                      onChange={(event) => setCollaboratorSearch(event.target.value)}
                      placeholder="Buscar colaborador..."
                    />
                    <button
                      type="button"
                      className="sort-btn"
                      onClick={() => setCollaboratorSort((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                      title={collaboratorSort === 'asc' ? 'Orden ascendente' : 'Orden descendente'}
                    >
                      {collaboratorSort === 'asc' ? 'A-Z' : 'Z-A'}
                    </button>
                  </div>
                  <div className="pending-table-wrapper">
                    <table className="pending-table">
                      <tbody>
                        {nominaLoading && (
                          <tr>
                            <td>Cargando colaboradores...</td>
                          </tr>
                        )}
                        {!nominaLoading && employees.length === 0 && !nominaError && (
                          <tr>
                            <td>Aun no existen documentos de colaboradores</td>
                          </tr>
                        )}
                        {!nominaLoading && employees.length > 0 && visibleEmployees.length === 0 && !nominaError && (
                          <tr>
                            <td>Sin resultados para la búsqueda</td>
                          </tr>
                        )}
                        {!nominaLoading &&
                          visibleEmployees.map((employee) => (
                            <tr
                              key={employee.id}
                              className={employee.id === selectedEmployeeId ? 'selected-row' : ''}
                              onClick={() => {
                                setSelectedEmployeeId(employee.id)
                                void loadYearsForEmployee(employee.id)
                              }}
                            >
                              <td title={employee.name}>{employee.name}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="process-cta-row">
                    <button type="button" className="add-files-btn" disabled>
                      Nuevo colaborador
                    </button>
                  </div>
                </section>
              </div>

              <section className="jobs-card" aria-label="Archivos por colaborador y año">
                <div className="pending-header">
                  <h3>Documentos del colaborador</h3>
                  <div className="year-filter">
                    <span>Año</span>
                    <select
                      className="year-select"
                      value={selectedYearFolderId}
                      onChange={(event) => {
                        const yearId = event.target.value
                        setSelectedYearFolderId(yearId)
                        void loadNominaFilesForFolder(yearId)
                      }}
                      disabled={employeeYears.length === 0}
                    >
                      {employeeYears.length === 0 && <option value="">Sin años</option>}
                      {employeeYears.map((yearFolder) => (
                        <option key={yearFolder.id} value={yearFolder.id}>
                          {yearFolder.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="pending-table-wrapper">
                  <table className="pending-table files-table">
                    <colgroup>
                      <col />
                      <col className="files-action-col" />
                      <col className="files-action-col" />
                    </colgroup>
                    <tbody>
                      {nominaFilesLoading && (
                        <tr>
                          <td colSpan={3}>Cargando archivos...</td>
                        </tr>
                      )}
                      {!nominaFilesLoading && nominaFiles.length === 0 && (
                        <tr>
                          <td colSpan={3}>Sin archivos para el colaborador/año seleccionado.</td>
                        </tr>
                      )}
                      {!nominaFilesLoading &&
                        nominaFiles.map((file) => (
                          <tr key={file.id}>
                            <td title={file.name}>{file.name}</td>
                            <td className="doc-actions">
                              <button
                                type="button"
                                className="doc-action-text-btn doc-action-view"
                                onClick={() => openDriveFile(file.id)}
                                title="Ver en Drive"
                                aria-label="Ver en Drive"
                              >
                                Ver
                              </button>
                            </td>
                            <td className="doc-actions">
                              <button
                                type="button"
                                className="doc-action-text-btn doc-action-download"
                                onClick={() => downloadDriveFile(file.id)}
                                title="Descargar"
                                aria-label="Descargar archivo"
                              >
                                Descargar
                              </button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                {nominaError && <p className="oauth-feedback error">{nominaError}</p>}
              </section>
            </div>
          </main>
        )}
      </div>

      {showConnectRequiredModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Cuenta requerida">
          <div className="modal-card">
            <h3>Cuenta requerida</h3>
            <p>Para procesar archivos primero necesitás conectar una cuenta de Google Drive.</p>
            <div className="modal-actions">
              <button type="button" className="modal-secondary" onClick={() => setShowConnectRequiredModal(false)}>
                Cerrar
              </button>
              <button
                type="button"
                className="modal-primary"
                onClick={() => {
                  applySectionChange('cuenta', 'replace')
                  setShowConnectRequiredModal(false)
                }}
              >
                Ir a conectar cuenta
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreateStructureModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Crear estructura RECIBOX">
          <div className="modal-card">
            <h3>Accion necesaria</h3>
            <p>RECIBOX necesita un espacio dentro de tu unidad de Google Drive.</p>
            <p>Selecciona:</p>
            <ul className="storage-options-list">
              <li>
                <strong>Crear:</strong> Para generar una carpeta especifica donde procesar los documentos.
              </li>
              <li>
                <strong>Elegir:</strong> Si ya tenes informacion de tus colaboradores y queres usar ese espacio.
              </li>
            </ul>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-secondary"
                onClick={() => setShowCreateStructureModal(false)}
                disabled={storageLoading}
              >
                Salir
              </button>
              <button
                type="button"
                className="modal-secondary"
                onClick={() => void openChooseReciboxModal()}
                disabled={storageLoading}
              >
                Elegir
              </button>
              <button
                type="button"
                className="modal-primary"
                onClick={requestCreateStorageStructure}
                disabled={storageLoading}
              >
                {storageLoading ? 'Creando...' : 'Crear'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showChooseReciboxModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Elegir carpeta RECIBOX">
          <div className="modal-card picker-modal">
            <h3>Elegir carpeta existente</h3>
            <p>Selecciona una carpeta en /root para renombrarla a RECIBOX.</p>
            <div className="picker-list" role="listbox" aria-label="Carpetas disponibles en root">
              {rootFoldersLoading && <p>Cargando carpetas...</p>}
              {!rootFoldersLoading && rootFolders.length === 0 && !rootFoldersError && (
                <p>No hay carpetas disponibles en /root.</p>
              )}
              {!rootFoldersLoading &&
                rootFolders.map((folder) => (
                  <label key={folder.id} className="picker-option">
                    <input
                      type="radio"
                      name="recibox-root-folder"
                      value={folder.id}
                      checked={selectedRootFolderId === folder.id}
                      onChange={() => setSelectedRootFolderId(folder.id)}
                    />
                    <span title={folder.name}>{folder.name}</span>
                  </label>
                ))}
            </div>
            {rootFoldersError && <p className="oauth-feedback error">{rootFoldersError}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="modal-secondary"
                onClick={() => setShowChooseReciboxModal(false)}
                disabled={adoptingReciboxFolder}
              >
                Salir
              </button>
              <button
                type="button"
                className="modal-primary"
                onClick={requestAdoptSelectedRootFolder}
                disabled={adoptingReciboxFolder || rootFoldersLoading || rootFolders.length === 0}
              >
                {adoptingReciboxFolder ? 'Renombrando...' : 'Renombrar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showStorageConfirmModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirmar accion">
          <div className="modal-card">
            <h3>Confirmar accion</h3>
            {pendingStorageAction?.kind === 'create' && (
              <p>Se creara la estructura RECIBOX/#0 INPUT. ¿Deseas continuar?</p>
            )}
            {pendingStorageAction?.kind === 'adopt' && (
              <p>
                Se renombrara "{pendingStorageAction.folderName}" a RECIBOX y se creara #0 INPUT dentro. ¿Deseas
                continuar?
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="modal-secondary" onClick={cancelStorageAction}>
                Cancelar
              </button>
              <button type="button" className="modal-primary" onClick={() => void confirmStorageAction()}>
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      {showCustomFilenameModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Formato custom de nombre">
          <div className="modal-card picker-modal">
            <h3>Formato custom</h3>
            <p>Define los campos y separadores para establecer el formato de nombre del archivos</p>
            <div className="custom-format-grid">
              <select
                className="year-select"
                value={customFilenameFormat.part1}
                onChange={(event) => updateCustomFormatField('part1', event.target.value as FilenameCustomFormat['part1'])}
              >
                {filenameTokenOptions.map((option) => (
                  <option key={`part1-${option.value}`} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                className="year-select"
                value={customFilenameFormat.sep1}
                onChange={(event) => updateCustomFormatField('sep1', event.target.value as FilenameCustomFormat['sep1'])}
              >
                {filenameSeparatorOptions.map((option) => (
                  <option key={`sep1-${option.value || 'none'}`} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                className="year-select"
                value={customFilenameFormat.part2}
                onChange={(event) => updateCustomFormatField('part2', event.target.value as FilenameCustomFormat['part2'])}
              >
                {filenameTokenOptions.map((option) => (
                  <option key={`part2-${option.value}`} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                className="year-select"
                value={customFilenameFormat.sep2}
                onChange={(event) => updateCustomFormatField('sep2', event.target.value as FilenameCustomFormat['sep2'])}
              >
                {filenameSeparatorOptions.map((option) => (
                  <option key={`sep2-${option.value || 'none'}`} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                className="year-select"
                value={customFilenameFormat.part3}
                onChange={(event) => updateCustomFormatField('part3', event.target.value as FilenameCustomFormat['part3'])}
              >
                {filenameTokenOptions.map((option) => (
                  <option key={`part3-${option.value}`} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            {customFormatError && <p className="oauth-feedback error">{customFormatError}</p>}
            <p className="settings-preview">
              <strong>Vista previa:</strong> {buildFilenamePreview('custom', customFilenameFormat)}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-secondary"
                onClick={() => {
                  setCustomFormatError('')
                  setShowCustomFilenameModal(false)
                }}
              >
                Cerrar
              </button>
              <button
                type="button"
                className="modal-primary"
                onClick={() => {
                  if (!hasAnyCustomFilenamePart(customFilenameFormat)) {
                    setCustomFormatError('Al menos un campo debe tener información.')
                    return
                  }
                  setFilenameFormatMode('custom')
                  setCustomFormatError('')
                  setShowCustomFilenameModal(false)
                }}
              >
                Aplicar custom
              </button>
            </div>
          </div>
        </div>
      )}

      {showCustomEmployeeFolderModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Formato custom carpeta empleado">
          <div className="modal-card picker-modal">
            <h3>Formato custom de carpeta empleado</h3>
            <p>Define dos campos para el indice custom del nombre de la carpeta del colaborador</p>
            <div className="custom-format-grid">
              <input
                className="collaborator-search"
                type="text"
                value={employeeFolderCustomPart1}
                placeholder="Campo 1"
                onChange={(event) => {
                  setCustomEmployeeFolderError('')
                  setProcessingPreferencesError('')
                  setEmployeeFolderCustomPart1(event.target.value)
                }}
              />
              <input
                className="collaborator-search"
                type="text"
                value={employeeFolderCustomPart2}
                placeholder="Campo 2"
                onChange={(event) => {
                  setCustomEmployeeFolderError('')
                  setProcessingPreferencesError('')
                  setEmployeeFolderCustomPart2(event.target.value)
                }}
              />
            </div>
            {customEmployeeFolderError && <p className="oauth-feedback error">{customEmployeeFolderError}</p>}
            <p className="settings-preview">
              <strong>Vista previa:</strong>{' '}
              {buildEmployeeFolderPreview('custom', employeeFolderCustomPart1, employeeFolderCustomPart2)}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-secondary"
                onClick={() => {
                  setCustomEmployeeFolderError('')
                  setShowCustomEmployeeFolderModal(false)
                }}
              >
                Cerrar
              </button>
              <button
                type="button"
                className="modal-primary"
                onClick={() => {
                  if (!employeeFolderCustomPart1 && !employeeFolderCustomPart2) {
                    setCustomEmployeeFolderError('Al menos un campo debe tener información.')
                    return
                  }
                  setEmployeeFolderNumberMode('custom')
                  setCustomEmployeeFolderError('')
                  setShowCustomEmployeeFolderModal(false)
                }}
              >
                Aplicar custom
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedProcess && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Detalle del proceso">
          <div className="modal-card process-detail-modal">
            <h3>Detalle del proceso</h3>
            <p><strong>Job ID:</strong> {selectedProcess.jobId}</p>
            <p><strong>Estado final:</strong> {selectedProcess.state === 'success' ? 'Exitoso' : 'Error'}</p>
            <p><strong>Estado backend:</strong> {selectedProcess.detail?.status || 'N/D'}</p>
            <p><strong>Duración:</strong> {formatDuration(selectedProcess.detail?.duration_seconds)}</p>
            <p><strong>Procesados (total):</strong> {extractRunMetrics(selectedProcess.detail).totalProcessed ?? 'N/D'}</p>
            <p><strong>Exitosos:</strong> {extractRunMetrics(selectedProcess.detail).success ?? 'N/D'}</p>
            <p><strong>Errores:</strong> {extractRunMetrics(selectedProcess.detail).error ?? 'N/D'}</p>
            <p><strong>Estado del flujo:</strong> {extractRunMetrics(selectedProcess.detail).flowStatus ?? 'N/D'}</p>
            <p><strong>Mensaje:</strong> {extractRunMetrics(selectedProcess.detail).message ?? 'N/D'}</p>
            <p><strong>Log:</strong> {extractRunMetrics(selectedProcess.detail).logPath ?? 'N/D'}</p>
            <p><strong>Creado:</strong> {formatDateTime(selectedProcess.detail?.created_at)}</p>
            <p><strong>En cola:</strong> {formatDateTime(selectedProcess.detail?.enqueued_at)}</p>
            <p><strong>Inicio:</strong> {formatDateTime(selectedProcess.detail?.started_at)}</p>
            <p><strong>Fin:</strong> {formatDateTime(selectedProcess.detail?.ended_at)}</p>
            <div className="modal-actions">
              <button type="button" className="modal-primary" onClick={() => setSelectedProcess(null)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
