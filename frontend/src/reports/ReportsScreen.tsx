import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Download,
  Filter,
  File,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Info,
  Landmark,
  Link2,
  Play,
  Plus,
  RefreshCcw,
  LoaderCircle,
  Search,
  Save,
  Trash2,
  X,
} from 'lucide-react'

import './ReportsScreen.css'
import {
  bindReportFileTemplate,
  buildReportRunDownloadUrl,
  createReportLayout,
  createReportRun,
  deleteReportLayout,
  listFilesInFolder,
  listFolderContents,
  listPickerFolders,
  listReportLayouts,
  listReportRuns,
  listTemplateGroups,
  reprocessReportRun,
  resolveReportSelection,
  updateReportLayout,
} from '../api/recibox'
import type {
  DriveFile,
  DriveFolder,
  ReportColumn,
  ReportLayout,
  ReportOutputFormat,
  ReportRunRecord,
  ReportSelectionResolveResponse,
  ReportSelectionResolvedFile,
  ReportSelectionTemplate,
  TemplateGroup,
} from '../types/api'

type Props = {
  tenantId: string
  isConnected: boolean
  onRequireConnect: () => void
}

type WizardStep = 1 | 2 | 3 | 4
type SortOrder = 'asc' | 'desc'

type FolderCacheEntry = {
  folders: DriveFolder[]
  files: DriveFile[]
}

function compareByName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
}

function createDraftColumn(index: number): ReportColumn {
  return {
    column_id: crypto.randomUUID(),
    label: `Columna ${index}`,
    value_type: 'string',
    source_type: 'template_field',
    system_key: null,
    template_mappings: {},
    order: index,
  }
}

function normalizeDraftColumns(columns: ReportColumn[]): ReportColumn[] {
  return columns.map((column, index) => ({
    ...column,
    column_id: column.column_id || crypto.randomUUID(),
    source_type: 'template_field',
    system_key: null,
    template_mappings: column.template_mappings || {},
    order: index + 1,
  }))
}

function describeRunProgress(run: ReportRunRecord): string | null {
  const detail = run.detail
  if (!detail || typeof detail !== 'object' || !('progress' in detail)) {
    return null
  }
  const progress = (detail as {
    progress?: {
      processed?: number | null
      total?: number | null
      message?: string | null
    } | null
  }).progress
  if (!progress || typeof progress !== 'object') {
    return null
  }
  const processed = typeof progress.processed === 'number' ? progress.processed : null
  const total = typeof progress.total === 'number' ? progress.total : null
  const message = typeof progress.message === 'string' ? progress.message.trim() : ''
  if (processed !== null && total !== null && total > 0) {
    return `${processed}/${total}${message ? ` · ${message}` : ''}`
  }
  return message || null
}

function formatReportDate(value?: string | null): string {
  if (!value) {
    return 'Sin fecha'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'Sin fecha'
  }
  return new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

function formatRelativeTime(value?: string | null): string {
  if (!value) {
    return 'sin fecha'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'sin fecha'
  }

  const diffMs = date.getTime() - Date.now()
  const absMs = Math.abs(diffMs)
  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' })

  if (absMs < 60_000) {
    return rtf.format(Math.round(diffMs / 1000), 'second')
  }
  if (absMs < 3_600_000) {
    return rtf.format(Math.round(diffMs / 60_000), 'minute')
  }
  if (absMs < 86_400_000) {
    return rtf.format(Math.round(diffMs / 3_600_000), 'hour')
  }
  return rtf.format(Math.round(diffMs / 86_400_000), 'day')
}

function formatEstimatedProcessingTime(fileCount: number): string {
  if (fileCount <= 0) {
    return '~0 segundos'
  }
  const totalSeconds = fileCount * 15
  if (totalSeconds < 60) {
    return `~${totalSeconds} segundos`
  }
  const minutes = Math.round(totalSeconds / 60)
  return `~${minutes} minuto${minutes === 1 ? '' : 's'}`
}

function getReportFileVisual(name: string): {
  icon: typeof File | typeof FileText | typeof FileSpreadsheet
  tone: 'pdf' | 'sheet' | 'doc'
} {
  const lowerName = name.toLowerCase()
  if (lowerName.endsWith('.pdf')) {
    return { icon: FileText, tone: 'pdf' }
  }
  if (lowerName.endsWith('.xls') || lowerName.endsWith('.xlsx') || lowerName.endsWith('.csv')) {
    return { icon: FileSpreadsheet, tone: 'sheet' }
  }
  return { icon: File, tone: 'doc' }
}

function getTemplateFieldOptionLabel(field: ReportSelectionTemplate['fields'][number]): string {
  const label = String(field.label || '').trim()
  if (label && label.toLowerCase() !== 'none') {
    return label
  }
  const name = String(field.name || '').trim()
  if (name && name.toLowerCase() !== 'none') {
    return name
  }
  return String(field.key || '').trim() || 'Campo sin nombre'
}

function getRunStatusMeta(status: ReportRunRecord['status']): { label: string; tone: 'success' | 'running' | 'error' } {
  if (status === 'success') {
    return { label: 'success', tone: 'success' }
  }
  if (status === 'running') {
    return { label: 'procesando', tone: 'running' }
  }
  return { label: 'error', tone: 'error' }
}

function getRunDisplayName(run: ReportRunRecord, layoutNameById: Map<string, string>): string {
  const explicitName = String(run.report_name || '').trim()
  if (explicitName) {
    return explicitName
  }
  const layoutName = run.report_id ? String(layoutNameById.get(run.report_id) || '').trim() : ''
  if (layoutName) {
    return layoutName
  }
  const artifactName = String(run.artifact_filename || '').trim()
  if (artifactName) {
    if (/^reporte-[0-9a-f-]+\.(csv|xlsx)$/i.test(artifactName)) {
      return 'Reporte exportado'
    }
    return artifactName.replace(/\.(csv|xlsx)$/i, '')
  }
  return 'Reporte exportado'
}

export function ReportsScreen({ tenantId, isConnected, onRequireConnect }: Props) {
  const [layouts, setLayouts] = useState<ReportLayout[]>([])
  const [runs, setRuns] = useState<ReportRunRecord[]>([])
  const [groups, setGroups] = useState<TemplateGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [runsLoading, setRunsLoading] = useState(false)
  const [error, setError] = useState('')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardStep, setWizardStep] = useState<WizardStep>(1)
  const [editingLayoutId, setEditingLayoutId] = useState<string | null>(null)
  const [layoutName, setLayoutName] = useState('')
  const [layoutDescription, setLayoutDescription] = useState('')
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [selectedFolderStack, setSelectedFolderStack] = useState<DriveFolder[]>([])
  const [folders, setFolders] = useState<DriveFolder[]>([])
  const [files, setFiles] = useState<DriveFile[]>([])
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([])
  const [folderSort, setFolderSort] = useState<SortOrder>('asc')
  const [outputFormat, setOutputFormat] = useState<ReportOutputFormat>('csv')
  const [csvDelimiter, setCsvDelimiter] = useState<';' | ','>(';')
  const [columns, setColumns] = useState<ReportColumn[]>([createDraftColumn(1)])
  const [resolvedSelection, setResolvedSelection] = useState<ReportSelectionResolveResponse | null>(null)
  const [selectionLoading, setSelectionLoading] = useState(false)
  const [selectionError, setSelectionError] = useState('')
  const [savingLayout, setSavingLayout] = useState(false)
  const [runningReport, setRunningReport] = useState(false)
  const [showSaveLayoutDialog, setShowSaveLayoutDialog] = useState(false)
  const [bindingTemplateByFileId, setBindingTemplateByFileId] = useState<Record<string, string>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [showAllLayouts, setShowAllLayouts] = useState(false)
  const [showAllRuns, setShowAllRuns] = useState(false)
  const folderCacheRef = useRef<Partial<Record<string, FolderCacheEntry>>>({})
  const folderRequestRef = useRef<Partial<Record<string, Promise<FolderCacheEntry>>>>({})
  const hasLoadedRunsRef = useRef(false)
  const wizardBodyRef = useRef<HTMLDivElement | null>(null)
  const browserScrollPanelRef = useRef<HTMLDivElement | null>(null)

  const resetBrowserScroll = useCallback(() => {
    if (browserScrollPanelRef.current) {
      browserScrollPanelRef.current.scrollTop = 0
    }
    if (wizardBodyRef.current) {
      wizardBodyRef.current.scrollTop = 0
    }
  }, [])

  const loadLayouts = useCallback(async () => {
    setLoading(true)
    const response = await listReportLayouts(tenantId, true)
    setLoading(false)
    if (!response.ok || !response.data) {
      setError(response.error || 'No se pudieron cargar los reportes.')
      return
    }
    setError('')
    setLayouts(response.data.reports || [])
  }, [tenantId])

  const loadRuns = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? hasLoadedRunsRef.current
    if (!silent) {
      setRunsLoading(true)
    }
    const response = await listReportRuns(tenantId, 20)
    if (!silent) {
      setRunsLoading(false)
    }
    if (!response.ok || !response.data) {
      return
    }
    hasLoadedRunsRef.current = true
    setRuns(response.data.items || [])
  }, [tenantId])

  const loadGroups = useCallback(async () => {
    const response = await listTemplateGroups(tenantId, { sync: true })
    if (!response.ok || !response.data) {
      setError(response.error || 'No se pudieron cargar los grupos.')
      return
    }
    setError('')
    setGroups([...(response.data.groups || [])].sort(compareByName))
  }, [tenantId])

  useEffect(() => {
    if (!isConnected) {
      return
    }
    void loadLayouts()
    void loadRuns()
    void loadGroups()
  }, [isConnected, loadGroups, loadLayouts, loadRuns])

  useEffect(() => {
    if (!isConnected) {
      return
    }
    const timer = window.setInterval(() => {
      void loadRuns({ silent: true })
    }, 10000)
    return () => window.clearInterval(timer)
  }, [isConnected, loadRuns])

  const fetchFolderContents = useCallback(
    async (folderId: string) => {
      if (!isConnected) {
        onRequireConnect()
        throw new Error('Drive no conectado')
      }
      if (folderCacheRef.current[folderId]) {
        return folderCacheRef.current[folderId]
      }
      if (folderRequestRef.current[folderId]) {
        return await folderRequestRef.current[folderId]
      }

      const request = (async () => {
        const contentsRes = await listFolderContents(tenantId, folderId)
        if (contentsRes.ok && contentsRes.data) {
          const nextEntry = {
            folders: [...(contentsRes.data.folders || [])].sort(compareByName),
            files: [...(contentsRes.data.files || [])].sort(compareByName),
          }
          folderCacheRef.current[folderId] = nextEntry
          return nextEntry
        }

        const [foldersRes, filesRes] = await Promise.all([listPickerFolders(tenantId, folderId), listFilesInFolder(tenantId, folderId)])
        if (!foldersRes.ok || !filesRes.ok) {
          throw new Error('No se pudo navegar la carpeta seleccionada.')
        }

        const nextEntry = {
          folders: [...(foldersRes.data?.folders || [])].sort(compareByName),
          files: [...(filesRes.data?.files || [])].sort(compareByName),
        }
        folderCacheRef.current[folderId] = nextEntry
        return nextEntry
      })()

      folderRequestRef.current[folderId] = request
      try {
        return await request
      } finally {
        delete folderRequestRef.current[folderId]
      }
    },
    [isConnected, onRequireConnect, tenantId],
  )

  const loadFolderContents = useCallback(
    async (folderId: string) => {
      try {
        const nextEntry = await fetchFolderContents(folderId)
        setSelectionError('')
        setFolders(nextEntry.folders)
        setFiles(nextEntry.files)
      } catch (error) {
        setSelectionError(error instanceof Error ? error.message : 'No se pudo navegar la carpeta seleccionada.')
      }
    },
    [fetchFolderContents],
  )

  const openWizard = useCallback(
    async (layout?: ReportLayout) => {
      if (!isConnected) {
        onRequireConnect()
        return
      }
      const nextGroupId = layout?.default_group_id || groups[0]?.group_id || ''
      setWizardOpen(true)
      setWizardStep(1)
      setEditingLayoutId(layout?.report_id || null)
      setLayoutName(layout?.name || '')
      setLayoutDescription(layout?.description || '')
      setSelectedGroupId(nextGroupId)
      setSelectedFolderStack([])
      setSelectedFileIds([])
      setResolvedSelection(null)
      setShowSaveLayoutDialog(false)
      setSelectionError('')
      setSearchQuery('')
      setOutputFormat(layout?.default_output_format || 'csv')
      setCsvDelimiter((layout?.csv_delimiter as ';' | ',') || ';')
      setColumns(normalizeDraftColumns(layout?.columns?.length ? layout.columns : [createDraftColumn(1)]))
      setBindingTemplateByFileId({})
      if (nextGroupId) {
        const group = groups.find((item) => item.group_id === nextGroupId)
        if (group?.drive_folder_id) {
          await loadFolderContents(group.drive_folder_id)
        }
      }
    },
    [groups, isConnected, loadFolderContents, onRequireConnect],
  )

  const refreshSelection = useCallback(async () => {
    if (!selectedGroupId || selectedFileIds.length === 0) {
      setResolvedSelection(null)
      setSelectionError('')
      return
    }
    setSelectionLoading(true)
    const response = await resolveReportSelection(tenantId, {
      group_id: selectedGroupId,
      file_ids: selectedFileIds,
    })
    setSelectionLoading(false)
    if (!response.ok || !response.data) {
      setSelectionError(response.error || 'No se pudo resolver la selección.')
      return
    }
    setSelectionError('')
    setResolvedSelection(response.data)
  }, [selectedFileIds, selectedGroupId, tenantId])

  useEffect(() => {
    if (!wizardOpen) {
      return
    }
    void refreshSelection()
  }, [refreshSelection, wizardOpen])

  useEffect(() => {
    if (!wizardOpen || wizardStep !== 1) {
      return
    }
    resetBrowserScroll()
  }, [resetBrowserScroll, selectedFolderStack, selectedGroupId, wizardOpen, wizardStep])

  const currentGroup = useMemo(
    () => groups.find((group) => group.group_id === selectedGroupId) || null,
    [groups, selectedGroupId],
  )

  const selectedFiles = useMemo(() => {
    const items = new Map<string, ReportSelectionResolvedFile>()
    for (const file of resolvedSelection?.files || []) {
      items.set(file.file_id, file)
    }
    return selectedFileIds.map((fileId) => items.get(fileId)).filter(Boolean) as ReportSelectionResolvedFile[]
  }, [resolvedSelection?.files, selectedFileIds])

  const visibleFolders = useMemo(() => {
    const next = [...folders]
    next.sort((a, b) => (folderSort === 'asc' ? compareByName(a, b) : compareByName(b, a)))
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase('es')
    if (!normalizedQuery) {
      return next
    }
    return next.filter((folder) => folder.name.toLocaleLowerCase('es').includes(normalizedQuery))
  }, [folderSort, folders, searchQuery])

  const visibleFiles = useMemo(() => {
    const next = [...files].sort(compareByName)
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase('es')
    if (!normalizedQuery) {
      return next
    }
    return next.filter((file) => file.name.toLocaleLowerCase('es').includes(normalizedQuery))
  }, [files, searchQuery])

  const hasSelectionIssues = useMemo(
    () => selectedFiles.some((item) => item.template_binding_status !== 'ready'),
    [selectedFiles],
  )

  const presentTemplates = resolvedSelection?.templates || []
  const singleDetectedTemplate = presentTemplates.length === 1 ? presentTemplates[0] : null

  const displayedLayouts = useMemo(
    () => (showAllLayouts ? layouts : layouts.slice(0, 2)),
    [layouts, showAllLayouts],
  )

  const layoutNameById = useMemo(() => {
    const next = new Map<string, string>()
    for (const layout of layouts) {
      next.set(layout.report_id, layout.name)
    }
    return next
  }, [layouts])

  const displayedRuns = useMemo(
    () => (showAllRuns ? runs : runs.slice(0, 3)),
    [runs, showAllRuns],
  )

  const monthlyGoal = 100
  const monthlyGenerated = useMemo(
    () => runs.filter((item) => item.status === 'success').length,
    [runs],
  )
  const monthlyProgress = Math.max(0, Math.min((monthlyGenerated / monthlyGoal) * 100, 100))

  const currentFolderLabel = useMemo(() => {
    if (selectedFolderStack.length === 0) {
      return currentGroup?.name || 'Raíz del grupo'
    }
    return selectedFolderStack[selectedFolderStack.length - 1]?.name || currentGroup?.name || 'Raíz del grupo'
  }, [currentGroup?.name, selectedFolderStack])

  const selectedCount = selectedFiles.length
  const estimatedProcessingTime = useMemo(
    () => formatEstimatedProcessingTime(selectedCount),
    [selectedCount],
  )
  const estimatedProcessingWidth = useMemo(
    () => `${Math.max(12, Math.min((selectedCount / 9) * 100, 100))}%`,
    [selectedCount],
  )

  const wizardSteps = useMemo(
    () => [
      { step: 1 as WizardStep, label: 'Paso 1: Selección de documentos', shortLabel: 'Paso 1' },
      { step: 2 as WizardStep, label: 'Paso 2: Formato de salida', shortLabel: 'Paso 2' },
      { step: 3 as WizardStep, label: 'Paso 3: Columnas', shortLabel: 'Paso 3' },
      { step: 4 as WizardStep, label: 'Paso 4: Resumen', shortLabel: 'Paso 4' },
    ],
    [],
  )

  const columnValidationIssues = useMemo(() => {
    const issues: string[] = []
    if (columns.length === 0) {
      issues.push('Agregá al menos una columna.')
    }
    columns.forEach((column, index) => {
      const itemLabel = column.label?.trim() || `Columna ${index + 1}`
      if (!column.label?.trim()) {
        issues.push(`${itemLabel}: falta el nombre de la columna.`)
      }
      if (presentTemplates.length === 0) {
        issues.push(`${itemLabel}: no hay plantillas listas en la selección actual.`)
        return
      }
      for (const template of presentTemplates) {
        const fieldKey = column.template_mappings?.[template.template_id] || ''
        if (!fieldKey) {
          issues.push(`${itemLabel}: falta mapear la plantilla ${template.name}.`)
          continue
        }
        if (!template.fields.some((field) => field.key === fieldKey)) {
          issues.push(`${itemLabel}: el campo elegido ya no existe en la plantilla ${template.name}.`)
        }
      }
    })
    return issues
  }, [columns, presentTemplates])

  const columnValidationIssuesById = useMemo(() => {
    const issuesById = new Map<string, string[]>()
    columns.forEach((column, index) => {
      const issues: string[] = []
      const itemLabel = column.label?.trim() || `Columna ${index + 1}`
      if (!column.label?.trim()) {
        issues.push('Falta el nombre de la columna.')
      }
      if (presentTemplates.length === 0) {
        issues.push('No hay plantillas listas en la selección actual.')
      } else {
        for (const template of presentTemplates) {
          const fieldKey = column.template_mappings?.[template.template_id] || ''
          if (!fieldKey) {
            issues.push(`Falta mapear la plantilla ${template.name}.`)
            continue
          }
          if (!template.fields.some((field) => field.key === fieldKey)) {
            issues.push(`El campo elegido ya no existe en la plantilla ${template.name}.`)
          }
        }
      }
      if (issues.length > 0) {
        issuesById.set(String(column.column_id), issues.map((issue) => `${itemLabel}: ${issue}`))
      }
    })
    return issuesById
  }, [columns, presentTemplates])

  const canAdvanceFromColumns = columnValidationIssues.length === 0
  const canPersistDraft = !!selectedGroupId && selectedFileIds.length > 0 && !hasSelectionIssues && canAdvanceFromColumns

  const navigateToFolderLevel = useCallback(
    async (index: number) => {
      if (!currentGroup?.drive_folder_id) {
        return
      }
      resetBrowserScroll()
      if (index <= 0) {
        setSelectedFolderStack([])
        await loadFolderContents(currentGroup.drive_folder_id)
        return
      }
      const nextStack = selectedFolderStack.slice(0, index)
      setSelectedFolderStack(nextStack)
      const targetFolder = nextStack[nextStack.length - 1]
      await loadFolderContents(targetFolder.id)
    },
    [currentGroup?.drive_folder_id, loadFolderContents, resetBrowserScroll, selectedFolderStack],
  )

  const goToParentFolder = useCallback(async () => {
    if (selectedFolderStack.length === 0) {
      return
    }
    await navigateToFolderLevel(selectedFolderStack.length - 1)
  }, [navigateToFolderLevel, selectedFolderStack.length])

  const goToGroupRoot = useCallback(async () => {
    setSelectedFolderStack([])
    resetBrowserScroll()
    if (currentGroup?.drive_folder_id) {
      await loadFolderContents(currentGroup.drive_folder_id)
    }
  }, [currentGroup?.drive_folder_id, loadFolderContents, resetBrowserScroll])

  const toggleFileSelection = useCallback((fileId: string) => {
    setSelectedFileIds((prev) => (prev.includes(fileId) ? prev.filter((item) => item !== fileId) : [...prev, fileId]))
  }, [])

  const moveColumn = useCallback((columnId: string, direction: -1 | 1) => {
    setColumns((prev) => {
      const index = prev.findIndex((item) => item.column_id === columnId)
      if (index < 0) {
        return prev
      }
      const targetIndex = index + direction
      if (targetIndex < 0 || targetIndex >= prev.length) {
        return prev
      }
      const next = [...prev]
      const [moved] = next.splice(index, 1)
      next.splice(targetIndex, 0, moved)
      return normalizeDraftColumns(next)
    })
  }, [])

  const removeColumn = useCallback((columnId: string) => {
    setColumns((prev) => normalizeDraftColumns(prev.filter((item) => item.column_id !== columnId)))
  }, [])

  const saveLayout = useCallback(async (): Promise<boolean> => {
    if (!selectedGroupId) {
      setSelectionError('Seleccioná un grupo para guardar el layout.')
      return false
    }
    setSavingLayout(true)
    const payload = {
      name: layoutName || 'Nuevo reporte',
      description: layoutDescription || null,
      default_group_id: selectedGroupId,
      default_output_format: outputFormat,
      csv_delimiter: csvDelimiter,
      columns: normalizeDraftColumns(columns),
      is_active: true,
    }
    const response = editingLayoutId
      ? await updateReportLayout(tenantId, editingLayoutId, payload)
      : await createReportLayout(tenantId, payload)
    setSavingLayout(false)
    if (!response.ok) {
      setSelectionError(response.error || 'No se pudo guardar el layout.')
      return false
    }
    await loadLayouts()
    if (response.data?.report?.report_id) {
      setEditingLayoutId(response.data.report.report_id)
    }
    return true
  }, [columns, csvDelimiter, editingLayoutId, layoutDescription, layoutName, loadLayouts, outputFormat, selectedGroupId, tenantId])

  const closeWizard = useCallback(() => {
    setShowSaveLayoutDialog(false)
    setWizardOpen(false)
  }, [])

  const processReport = useCallback(async () => {
    if (!selectedGroupId || selectedFileIds.length === 0) {
      setSelectionError('Seleccioná archivos antes de procesar.')
      return
    }
    const shouldAskToSave = !editingLayoutId
    setRunningReport(true)
    const response = await createReportRun(tenantId, {
      report_id: editingLayoutId,
      group_id: selectedGroupId,
      file_ids: selectedFileIds,
      output_format: outputFormat,
      csv_delimiter: csvDelimiter,
      columns: normalizeDraftColumns(columns),
    })
    setRunningReport(false)
    if (!response.ok) {
      setSelectionError(response.error || 'No se pudo generar el reporte.')
      return
    }
    await loadRuns()
    if (shouldAskToSave) {
      setShowSaveLayoutDialog(true)
      return
    }
    closeWizard()
  }, [closeWizard, columns, csvDelimiter, editingLayoutId, loadRuns, outputFormat, selectedFileIds, selectedGroupId, tenantId])

  const deleteLayout = useCallback(async (layoutId: string) => {
    if (!window.confirm('¿Eliminar este layout de reporte?')) {
      return
    }
    const response = await deleteReportLayout(tenantId, layoutId)
    if (response.ok) {
      await loadLayouts()
    }
  }, [loadLayouts, tenantId])

  const bindLegacyFile = useCallback(async (fileId: string) => {
    const templateId = bindingTemplateByFileId[fileId]
    if (!templateId || !selectedGroupId) {
      return
    }
    const response = await bindReportFileTemplate(tenantId, fileId, {
      group_id: selectedGroupId,
      template_id: templateId,
    })
    if (!response.ok) {
      setSelectionError(response.error || 'No se pudo vincular la plantilla.')
      return
    }
    setBindingTemplateByFileId((prev) => {
      const next = { ...prev }
      delete next[fileId]
      return next
    })
    await refreshSelection()
  }, [bindingTemplateByFileId, refreshSelection, selectedGroupId, tenantId])

  const reprocessRun = useCallback(async (reportRunId: string) => {
    const response = await reprocessReportRun(tenantId, reportRunId)
    if (response.ok) {
      await loadRuns()
    }
  }, [loadRuns, tenantId])

  const preventButtonFocus = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault()
  }, [])

  return (
    <main className="content process-content reports-screen">
      <section className="section-page-header reports-page-header" aria-label="Encabezado de reportes">
        <h2>Reportes</h2>
        <button type="button" className="modal-primary reports-hero-button" onClick={() => void openWizard()}>
          <Plus size={17} />
          <span>Nuevo reporte</span>
        </button>
      </section>

      {error && <p className="oauth-feedback error">{error}</p>}

      <div className="reports-bento">
        <section className="reports-layouts-panel">
          <div className="reports-section-head">
            <h3>Layouts guardados</h3>
            {layouts.length > 2 && (
              <button
                type="button"
                className="reports-link-button"
                onClick={() => setShowAllLayouts((prev) => !prev)}
              >
                {showAllLayouts ? 'Ver menos' : 'Ver todas'}
                <ArrowRight size={14} />
              </button>
            )}
          </div>

          {loading && <p className="reports-inline-note">Cargando layouts...</p>}
          {!loading && layouts.length === 0 && <p className="reports-inline-note">Todavía no hay layouts guardados.</p>}

          <div className="reports-layout-grid">
            {displayedLayouts.map((layout, index) => {
              const LayoutIcon = index % 2 === 0 ? FileSpreadsheet : Landmark
              const accentClass = index % 2 === 0 ? 'emerald' : 'slate'
              return (
                <article key={layout.report_id} className="reports-layout-card-modern">
                  <div className="reports-layout-card-head">
                    <div className={`reports-layout-icon ${accentClass}`}>
                      <LayoutIcon size={20} />
                    </div>
                    <button
                      type="button"
                      className="reports-layout-icon-button"
                      onClick={() => void deleteLayout(layout.report_id)}
                      aria-label={`Eliminar ${layout.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>

                  <div className="reports-layout-card-body">
                    <h4>{layout.name}</h4>
                    <p className="reports-layout-meta">Última actualización: {formatReportDate(layout.updated_at || layout.created_at)}</p>
                    <p className="reports-layout-description">{layout.description || 'Layout reutilizable listo para ejecutarse con un nuevo lote de archivos.'}</p>
                  </div>

                  <button type="button" className="reports-layout-run-button" onClick={() => void openWizard(layout)}>
                    <Play size={14} />
                    <span>Ejecutar layout</span>
                  </button>
                </article>
              )
            })}

            {layouts.length === 0 && (
              <button type="button" className="reports-layout-create-card" onClick={() => void openWizard()}>
                <div className="reports-layout-create-icon">
                  <Plus size={18} />
                </div>
                <span>Crear nuevo reporte</span>
              </button>
            )}
          </div>
        </section>

        <aside className="reports-sidebar-stack">
          <section className="reports-runs-sidebar">
            <div className="reports-section-head">
              <h3>Corridas recientes</h3>
            </div>

            <div className="reports-runs-shell">
              {runsLoading && runs.length === 0 && <p className="reports-inline-note">Cargando corridas...</p>}
              {!runsLoading && runs.length === 0 && (
                <div className="reports-run-empty">
                  <p>No hay corridas todavía.</p>
                  <span>Cuando generes reportes van a aparecer acá.</span>
                </div>
              )}

              {displayedRuns.map((run) => {
                const statusMeta = getRunStatusMeta(run.status)
                const progressText = describeRunProgress(run)
                const runDisplayName = getRunDisplayName(run, layoutNameById)
                return (
                  <article key={run.report_run_id} className="reports-run-item">
                    <div className={`reports-run-file-icon ${statusMeta.tone}`}>
                      <FileText size={18} />
                    </div>

                    <div className="reports-run-main">
                      <strong>{runDisplayName}</strong>
                      <div className="reports-run-meta-line">
                        <span className={`reports-run-status ${statusMeta.tone}`}>
                          {statusMeta.tone === 'running' ? (
                            <LoaderCircle size={12} className="reports-run-status-spinner" />
                          ) : (
                            <span className="reports-run-status-dot" />
                          )}
                          {statusMeta.label}
                        </span>
                        <span className="reports-run-time">{formatRelativeTime(run.updated_at || run.created_at)}</span>
                      </div>
                      {progressText && run.status === 'running' && (
                        <p className="reports-run-progress">{progressText}</p>
                      )}
                    </div>

                    <div className="reports-run-actions-modern">
                      {run.artifact_available && (
                        <a
                          className="reports-round-icon-button"
                          href={buildReportRunDownloadUrl(tenantId, run.report_run_id)}
                          aria-label={`Descargar ${run.artifact_filename || run.report_run_id}`}
                        >
                          <Download size={15} />
                        </a>
                      )}
                      <button
                        type="button"
                        className="reports-round-icon-button"
                        onClick={() => void reprocessRun(run.report_run_id)}
                        aria-label={`Reprocesar ${run.report_run_id}`}
                      >
                        <RefreshCcw size={15} />
                      </button>
                    </div>
                  </article>
                )
              })}

              {runs.length > 3 && (
                <button
                  type="button"
                  className="reports-show-more"
                  onClick={() => setShowAllRuns((prev) => !prev)}
                >
                  {showAllRuns ? 'Mostrar menos corridas' : 'Mostrar corridas anteriores'}
                </button>
              )}
            </div>
          </section>

          <section className="reports-metric-card">
            <div className="reports-metric-head">
              <Activity size={18} />
              <h4>Procesamiento mensual</h4>
            </div>
            <div className="reports-metric-body">
              <div className="reports-metric-row">
                <span>REPORTES GENERADOS</span>
                <strong>{monthlyGenerated}/{monthlyGoal}</strong>
              </div>
              <div className="reports-metric-track" aria-hidden="true">
                <div className="reports-metric-bar" style={{ width: `${monthlyProgress}%` }} />
              </div>
            </div>
          </section>
        </aside>
      </div>

      {wizardOpen && (
        <div className="modal-overlay reports-wizard-overlay" role="dialog" aria-modal="true" aria-label="Wizard de reportes">
          <div className="modal-card reports-wizard-modal">
            <header className="reports-wizard-header">
              <div className="reports-wizard-brand">
                <div className="reports-wizard-brand-icon">
                  <FileSpreadsheet size={18} />
                </div>
                <div className="reports-wizard-brand-copy">
                  <h3>{editingLayoutId ? 'Editar reporte' : 'Nuevo reporte'}</h3>
                  <p>Recibox Backoffice</p>
                </div>
              </div>
              <button
                type="button"
                className="reports-wizard-close"
                onClick={closeWizard}
                aria-label="Cerrar modal"
              >
                <X size={18} />
              </button>
            </header>

            <nav className="reports-wizard-stepper" aria-label="Pasos del reporte">
              {wizardSteps.map((item, index) => (
                <div key={item.step} className="reports-stepper-segment">
                  <button
                    type="button"
                    className={[
                      'reports-stepper-item',
                      wizardStep === item.step ? 'active' : '',
                      wizardStep > item.step ? 'completed' : '',
                    ].join(' ').trim()}
                    onClick={() => setWizardStep(item.step)}
                  >
                    <span className="reports-stepper-index">{item.step}</span>
                    <span className="reports-stepper-label">
                      {wizardStep === item.step ? item.label : item.shortLabel}
                    </span>
                  </button>
                  {index < wizardSteps.length - 1 && <span className="reports-stepper-line" aria-hidden="true" />}
                </div>
              ))}
            </nav>

            <div ref={wizardBodyRef} className="reports-wizard-body">
              {wizardStep === 1 && (
                <div className="reports-wizard-stage reports-wizard-stage-selection">
                  <section className="reports-step-browser-panel">
                    <div className="settings-field reports-step-group-field">
                      <label>Grupo</label>
                      <select
                        className="year-select"
                        value={selectedGroupId}
                        onChange={(event) => {
                          setSelectedGroupId(event.target.value)
                          setSelectedFolderStack([])
                          setSelectedFileIds([])
                          setResolvedSelection(null)
                          setSelectionError('')
                          setFolders([])
                          setFiles([])
                          setSearchQuery('')
                          const nextGroup = groups.find((item) => item.group_id === event.target.value)
                          if (nextGroup?.drive_folder_id) {
                            void loadFolderContents(nextGroup.drive_folder_id)
                          }
                        }}
                      >
                        <option value="">Seleccionar grupo</option>
                        {groups.map((group) => (
                          <option key={group.group_id} value={group.group_id}>
                            {group.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="reports-step-search-row">
                      <label className="reports-search-field" aria-label="Buscar carpetas o archivos">
                        <Search size={15} />
                        <input
                          type="search"
                          placeholder="Buscar carpetas o documentos..."
                          value={searchQuery}
                          onChange={(event) => setSearchQuery(event.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        className="reports-filter-button"
                        onClick={() => setFolderSort((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                      >
                        <Filter size={14} />
                        <span>Filtro {folderSort === 'asc' ? 'A-Z' : 'Z-A'}</span>
                      </button>
                    </div>

                    {currentGroup ? (
                      <>
                        <div className="reports-browser-nav">
                          <div className="reports-browser-nav-copy">
                            <strong>{currentFolderLabel}</strong>
                            <span>{visibleFolders.length} carpetas · {visibleFiles.length} archivos</span>
                          </div>
                          <div className="reports-browser-nav-actions">
                            <button
                              type="button"
                              className="reports-tree-action"
                              onMouseDown={preventButtonFocus}
                              onClick={() => void goToParentFolder()}
                              disabled={selectedFolderStack.length === 0}
                            >
                              <ArrowLeft size={14} /> Volver
                            </button>
                            <button
                              type="button"
                              className="reports-tree-action"
                              onMouseDown={preventButtonFocus}
                              onClick={() => void goToGroupRoot()}
                              disabled={selectedFolderStack.length === 0}
                            >
                              Raíz
                            </button>
                          </div>
                        </div>

                        <div ref={browserScrollPanelRef} className="reports-browser-scroll-panel">
                          {visibleFolders.length > 0 && (
                            <div className="reports-browser-section">
                              <div className="reports-browser-section-title">Carpetas</div>
                              <div className="reports-browser-list-modern">
                                {visibleFolders.map((folder) => (
                                  <button
                                    key={folder.id}
                                    type="button"
                                    className="reports-browser-entry folder"
                                    onMouseDown={preventButtonFocus}
                                    onClick={() => {
                                      resetBrowserScroll()
                                      setSelectedFolderStack((prev) => [...prev, folder])
                                      void loadFolderContents(folder.id)
                                    }}
                                  >
                                    <span className="reports-browser-entry-main">
                                      <Folder size={16} />
                                      <span>{folder.name}</span>
                                    </span>
                                    <ArrowRight size={14} />
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          {visibleFiles.length > 0 && (
                            <div className="reports-browser-section">
                              <div className="reports-browser-section-title">Archivos</div>
                              <div className="reports-browser-list-modern reports-browser-file-list">
                                {visibleFiles.map((file) => (
                                  <button
                                    key={file.id}
                                    type="button"
                                    className={`reports-browser-entry file ${selectedFileIds.includes(file.id) ? 'selected' : ''}`}
                                    onMouseDown={preventButtonFocus}
                                    onClick={() => toggleFileSelection(file.id)}
                                  >
                                    <span className="reports-browser-entry-main">
                                      <FileText size={16} />
                                      <span>{file.name}</span>
                                    </span>
                                    {selectedFileIds.includes(file.id) ? <CheckCircle2 size={15} /> : null}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          {visibleFolders.length === 0 && visibleFiles.length === 0 && (
                            <div className="reports-browser-empty-state">
                              No hay elementos para mostrar en esta vista.
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="reports-browser-empty-state">
                        Seleccioná un grupo para empezar a navegar carpetas y elegir archivos.
                      </div>
                    )}

                    <div className="reports-step-tip">
                      <Info size={15} />
                      <p>
                        <strong>Quick Tip:</strong> Podés navegar carpetas y combinar archivos de distintas rutas del mismo grupo para armar el reporte.
                      </p>
                    </div>
                  </section>

                  <aside className="reports-step-selection-panel">
                    <div className="reports-selected-header">
                      <h4>Archivos Seleccionados</h4>
                      <span>{selectedCount}</span>
                    </div>

                    <div className="reports-selected-scroll">
                      {selectedFiles.length === 0 && (
                        <div className="reports-selected-empty">
                          Elegí archivos desde el panel izquierdo para empezar.
                        </div>
                      )}

                      {selectedFiles.map((file) => {
                        const fileVisual = getReportFileVisual(file.name)
                        const SelectedFileIcon = fileVisual.icon
                        return (
                          <article key={file.file_id} className="reports-selected-simple-row">
                            <div className={`reports-selected-file-icon small ${fileVisual.tone}`}>
                              <SelectedFileIcon size={18} />
                            </div>

                            <div className="reports-selected-file-body">
                              <strong>{file.name}</strong>
                            </div>

                            <button
                              type="button"
                              className="reports-selected-remove inline"
                              onClick={() => toggleFileSelection(file.file_id)}
                              aria-label={`Quitar ${file.name}`}
                            >
                              <Trash2 size={14} />
                            </button>

                            {file.template_binding_status !== 'ready' && (
                              <div className="reports-binding-box">
                                <p>
                                  <AlertTriangle size={14} />
                                  {file.error || 'Archivo sin plantilla vinculada.'}
                                </p>
                                <select
                                  className="year-select"
                                  value={bindingTemplateByFileId[file.file_id] || ''}
                                  onChange={(event) =>
                                    setBindingTemplateByFileId((prev) => ({
                                      ...prev,
                                      [file.file_id]: event.target.value,
                                    }))
                                  }
                                >
                                  <option value="">Vincular plantilla...</option>
                                  {(resolvedSelection?.binding_templates || []).map((template) => (
                                    <option key={template.template_id} value={template.template_id}>
                                      {template.name}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  className="modal-secondary"
                                  onClick={() => void bindLegacyFile(file.file_id)}
                                >
                                  <Link2 size={14} /> Guardar vínculo
                                </button>
                              </div>
                            )}
                          </article>
                        )
                      })}
                    </div>

                    <div className="reports-selected-estimate">
                      <div className="reports-selected-estimate-row">
                        <span>Tiempo estimado de procesamiento</span>
                        <strong>{estimatedProcessingTime}</strong>
                      </div>
                      <div className="reports-selected-estimate-track" aria-hidden="true">
                        <div className="reports-selected-estimate-bar" style={{ width: estimatedProcessingWidth }} />
                      </div>
                    </div>
                  </aside>
                </div>
              )}

            {wizardStep === 2 && (
              <div className="reports-wizard-stage reports-wizard-stage-dual">
                <section className="reports-step-main-card">
                  <div className="reports-step-card-head">
                    <h4>Formato de salida</h4>
                    <p>Elegí cómo querés generar el archivo final.</p>
                  </div>

                  <div className="reports-format-card-grid">
                    <button
                      type="button"
                      className={`reports-format-card ${outputFormat === 'csv' ? 'active' : ''}`}
                      onClick={() => setOutputFormat('csv')}
                    >
                      <FileText size={18} />
                      <div>
                        <strong>CSV</strong>
                        <span>Archivo plano ideal para integrar o importar.</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      className={`reports-format-card ${outputFormat === 'xlsx' ? 'active' : ''}`}
                      onClick={() => setOutputFormat('xlsx')}
                    >
                      <FileSpreadsheet size={18} />
                      <div>
                        <strong>Excel (.xlsx)</strong>
                        <span>Una hoja simple lista para revisar o compartir.</span>
                      </div>
                    </button>
                  </div>

                  {outputFormat === 'csv' && (
                    <div className="settings-field reports-inline-field">
                      <label>Delimitador</label>
                      <select
                        className="year-select"
                        value={csvDelimiter}
                        onChange={(event) => setCsvDelimiter(event.target.value as ';' | ',')}
                      >
                        <option value=";">Punto y coma (;)</option>
                        <option value=",">Coma (,)</option>
                      </select>
                    </div>
                  )}
                </section>

                <aside className="reports-step-side-card">
                  <h4>Resumen rápido</h4>
                  <div className="reports-side-summary-list">
                    <p><FolderOpen size={15} /> {currentGroup?.name || 'Sin grupo seleccionado'}</p>
                    <p><FileText size={15} /> {selectedCount} archivos seleccionados</p>
                    <p><Save size={15} /> {columns.length} columnas configuradas</p>
                  </div>
                </aside>
              </div>
            )}

            {wizardStep === 3 && (
              <div className="reports-wizard-stage reports-wizard-stage-dual reports-wizard-stage-columns">
                <section className="reports-step-main-card reports-step-columns-card">
                  <div className="reports-step-card-head reports-step-card-head-row">
                    <div>
                      <h4>Columnas del reporte</h4>
                      <p>Definí qué datos querés exportar y en qué orden.</p>
                    </div>
                    <button
                      type="button"
                      className="modal-secondary reports-add-column-button"
                      onClick={() => setColumns((prev) => normalizeDraftColumns([...prev, createDraftColumn(prev.length + 1)]))}
                    >
                      <Plus size={14} /> Agregar columna
                    </button>
                  </div>

                  <div className="reports-columns-scroll">
                    <div className="reports-selected-list">
                      {columns.map((column, index) => (
                        <article key={column.column_id} className="reports-column-card">
                        <div className="reports-column-row">
                          <input
                            className="settings-input"
                            value={column.label}
                            onChange={(event) =>
                              setColumns((prev) =>
                                prev.map((item) => item.column_id === column.column_id ? { ...item, label: event.target.value } : item),
                              )
                            }
                            placeholder="Nombre de columna"
                          />
                          {singleDetectedTemplate ? (
                            <select
                              className="year-select"
                              value={column.template_mappings?.[singleDetectedTemplate.template_id] || ''}
                              onChange={(event) =>
                                setColumns((prev) =>
                                  prev.map((item) =>
                                    item.column_id === column.column_id
                                      ? {
                                          ...item,
                                          template_mappings: {
                                            ...(item.template_mappings || {}),
                                            [singleDetectedTemplate.template_id]: event.target.value,
                                          },
                                        }
                                      : item,
                                  ),
                                )
                              }
                            >
                              <option value="">Seleccionar campo...</option>
                              {singleDetectedTemplate.fields.map((field) => (
                                <option key={field.key} value={field.key}>{getTemplateFieldOptionLabel(field)}</option>
                              ))}
                            </select>
                          ) : (
                            <div className="reports-column-template-chip">
                              Campo de plantilla
                            </div>
                          )}
                          <button type="button" className="modal-secondary" onClick={() => moveColumn(String(column.column_id), -1)} disabled={index === 0}><ArrowUp size={14} /></button>
                          <button type="button" className="modal-secondary" onClick={() => moveColumn(String(column.column_id), 1)} disabled={index === columns.length - 1}><ArrowDown size={14} /></button>
                          <button type="button" className="modal-secondary" onClick={() => removeColumn(String(column.column_id))}><Trash2 size={14} /></button>
                        </div>

                          {columnValidationIssuesById.get(String(column.column_id))?.length ? (
                            <div className="reports-column-warning-list">
                              {columnValidationIssuesById.get(String(column.column_id))?.map((issue) => (
                                <p key={`${column.column_id}-${issue}`}>
                                  <AlertTriangle size={14} /> {issue}
                                </p>
                              ))}
                            </div>
                          ) : null}

                          {!singleDetectedTemplate && (
                            <div className="reports-template-mapping-grid">
                              {presentTemplates.map((template: ReportSelectionTemplate) => (
                                <div key={`${column.column_id}-${template.template_id}`} className="settings-field">
                                  <label>{template.name}</label>
                                  <select
                                    className="year-select"
                                    value={column.template_mappings?.[template.template_id] || ''}
                                    onChange={(event) =>
                                      setColumns((prev) =>
                                        prev.map((item) =>
                                          item.column_id === column.column_id
                                            ? {
                                                ...item,
                                                template_mappings: {
                                                  ...(item.template_mappings || {}),
                                                  [template.template_id]: event.target.value,
                                                },
                                              }
                                            : item,
                                        ),
                                      )
                                    }
                                  >
                                    <option value="">Seleccionar campo...</option>
                                    {template.fields.map((field) => (
                                      <option key={field.key} value={field.key}>{getTemplateFieldOptionLabel(field)}</option>
                                    ))}
                                  </select>
                                </div>
                              ))}
                            </div>
                          )}
                        </article>
                      ))}
                    </div>
                  </div>
                </section>

                <aside className="reports-step-side-card">
                  <h4>Plantillas detectadas</h4>
                  <div className="reports-side-template-list">
                    {presentTemplates.length === 0 && <p>No hay plantillas listas en la selección.</p>}
                    {presentTemplates.map((template) => (
                      <article key={template.template_id} className="reports-side-template-card">
                        <strong>{template.name}</strong>
                        <span>{template.fields.length} campos disponibles</span>
                        {template.fields.length > 0 && (
                          <ul className="reports-side-template-fields">
                            {template.fields.map((field) => {
                              const fieldLabel = getTemplateFieldOptionLabel(field)
                              return (
                                <li key={`${template.template_id}-${field.key}`} title={fieldLabel}>
                                  {fieldLabel}
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      </article>
                    ))}
                  </div>
                </aside>
              </div>
            )}

            {wizardStep === 4 && (
              <div className="reports-wizard-stage reports-wizard-stage-dual">
                <section className="reports-step-main-card">
                  <div className="reports-step-card-head">
                    <h4>Resumen final</h4>
                    <p>Guardá este layout para reutilizarlo o procesá el reporte ahora.</p>
                  </div>

                  <div className="settings-field">
                    <label>Nombre del layout</label>
                    <input
                      className="settings-input"
                      value={layoutName}
                      onChange={(event) => setLayoutName(event.target.value)}
                      placeholder="Nuevo reporte"
                    />
                  </div>
                  <div className="settings-field">
                    <label>Descripción</label>
                    <input
                      className="settings-input"
                      value={layoutDescription}
                      onChange={(event) => setLayoutDescription(event.target.value)}
                      placeholder="Descripción opcional"
                    />
                  </div>
                  <div className="reports-summary-box">
                    <p><FileSpreadsheet size={16} /> {selectedCount} archivos seleccionados</p>
                    <p><FolderOpen size={16} /> {currentGroup?.name || 'Sin grupo'}</p>
                    <p><Save size={16} /> {columns.length} columnas</p>
                  </div>
                </section>

                <aside className="reports-step-side-card">
                  <h4>Salida configurada</h4>
                  <div className="reports-side-summary-list">
                    <p><FileText size={15} /> Formato: {outputFormat.toUpperCase()}</p>
                    {outputFormat === 'csv' && <p><Save size={15} /> Delimitador: {csvDelimiter}</p>}
                    <p><CheckCircle2 size={15} /> Layout reutilizable: {layoutName?.trim() ? 'sí' : 'pendiente de nombre'}</p>
                  </div>
                </aside>
              </div>
            )}

            <div className="reports-wizard-status" aria-live="polite">
              {(selectionError || selectionLoading) && (
                <p className={`oauth-feedback ${selectionLoading ? 'success' : 'error'}`}>
                  {selectionLoading ? 'Resolviendo selección...' : selectionError}
                </p>
              )}
            </div>
            </div>

            <footer className="reports-wizard-footer">
              <div className="reports-wizard-footer-actions">
                {wizardStep > 1 && (
                  <button
                    type="button"
                    className="modal-secondary reports-footer-secondary"
                    onClick={() => setWizardStep((prev) => (prev - 1) as WizardStep)}
                  >
                    <ArrowLeft size={14} /> Atrás
                  </button>
                )}
                {wizardStep < 4 && (
                  <button
                    type="button"
                    className="modal-primary reports-footer-primary"
                    onClick={() => setWizardStep((prev) => (prev + 1) as WizardStep)}
                    disabled={
                      (wizardStep === 1 && (selectedFileIds.length === 0 || hasSelectionIssues)) ||
                      (wizardStep === 3 && !canAdvanceFromColumns)
                    }
                  >
                    Siguiente <ArrowRight size={14} />
                  </button>
                )}
                {wizardStep === 4 && (
                  <>
                    <button
                      type="button"
                      className="modal-primary reports-footer-primary"
                      onClick={() => void processReport()}
                      disabled={runningReport || !canPersistDraft}
                    >
                      <Play size={14} /> {runningReport ? 'Procesando...' : 'Procesar ahora'}
                    </button>
                  </>
                )}
              </div>
            </footer>

            {showSaveLayoutDialog && (
              <div className="reports-confirm-overlay" role="dialog" aria-modal="true" aria-label="Guardar configuracion reporte">
                <div className="reports-confirm-card">
                  <h4>Guardar configuracion reporte</h4>
                  <p>Podes guardar la configuracion del reporte para repetir su ejecucion con nuevos datos.</p>
                  <div className="reports-confirm-actions">
                    <button
                      type="button"
                      className="modal-secondary reports-footer-secondary"
                      onClick={closeWizard}
                      disabled={savingLayout}
                    >
                      Cerrar
                    </button>
                    <button
                      type="button"
                      className="modal-primary reports-footer-primary"
                      onClick={async () => {
                        const saved = await saveLayout()
                        if (saved) {
                          closeWizard()
                        }
                      }}
                      disabled={savingLayout || !canPersistDraft}
                    >
                      <Save size={14} /> {savingLayout ? 'Guardando...' : 'Guardar'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
