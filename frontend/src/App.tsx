import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  ChevronRight,
  FileText,
  Folder,
  GitBranchPlus,
  GripVertical,
  Info,
  ListOrdered,
  Plus,
  Save,
  Settings,
  SlidersHorizontal,
  Tag,
  Tags,
  Type,
  X,
  type LucideIcon,
} from 'lucide-react'
import { DragOverlay, DndContext, type DragEndEvent, type DragStartEvent, PointerSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import { snapCenterToCursor } from '@dnd-kit/modifiers'
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import './App.css'
import {
  adoptReciboxFolder,
  buildDrivePdfDownloadUrl,
  buildTemplateSourcePdfUrl,
  checkReciboxStructure,
  createTemplate,
  createReciboxStructure,
  deleteTemplate,
  getTemplate,
  getTemplateClassificationRule,
  getGoogleOAuthStatus,
  getJobStatus,
  getProcessingPreferences,
  ingestDrive,
  listEmployeeFolders,
  listEmployeeYears,
  listFilesInFolder,
  listDriveFiles,
  listPickerFolders,
  listTemplates,
  putProcessingPreferences,
  putTemplateClassificationRule,
  putTenantDriveConfig,
  unlinkGoogleOAuth,
  uploadTemplateSourcePdf,
  updateTemplate,
} from './api/recibox'
import { signOutFirebaseUser } from './auth/firebase'
import { authEmailStorageKey, tenantStorageKey } from './auth/session'
import { getEnvironmentChip, getRuntimeSetting } from './config/environment'
import type {
  DriveFile,
  DriveFolder,
  FilenameCustomFormat,
  JobStatusResponse,
  ProcessingPreferences,
  ReciboxStructureCheckResponse,
  TemplateFieldType,
  TemplateRect,
  TemplateCustomModel,
  TemplateMode,
  DocumentTemplateField,
  ClassificationRule,
  ClassificationRuleIndexDirection,
  ClassificationRuleIndexKind,
  ClassificationRulePartType,
  ClassificationRulePayload,
  RuleStatus,
  TemplateFieldTransformCaseMode,
  TemplateFieldTransformDateOutput,
  TemplateFieldTransformGroup,
  TemplateFieldTransformOperation,
  TemplateFieldTransformStep,
  TemplateSummary,
} from './types/api'

const defaultTenant = normalizeTenantId(import.meta.env.VITE_TENANT_ID || 'acme') || 'acme'
const apiBasePath = import.meta.env.VITE_API_BASE_PATH || '/api'
const pdfWorkerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
const templateLocalUploadEnabled = (getRuntimeSetting('VITE_TEMPLATE_LOCAL_UPLOAD_ENABLED') || 'false').toLowerCase() === 'true'
GlobalWorkerOptions.workerSrc = pdfWorkerSrc
const pdfWorkerLoadErrorMessage =
  'No se pudo cargar el worker PDF; revisar MIME `.mjs` en frontend y volver a intentar.'

function isPdfWorkerLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const message = error.message.toLowerCase()
  return (
    message.includes('setting up fake worker failed') ||
    message.includes('failed to fetch dynamically imported module') ||
    message.includes('importing a module script failed') ||
    message.includes('pdf.worker') ||
    message.includes('fake worker')
  )
}

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
type ProcessingMode = 'default' | 'template'

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

type PdfTextToken = {
  text: string
  x: number
  y: number
  w: number
  h: number
}

type TemplateEditorField = {
  id: string
  key: string
  name: string
  label: string | null
  suggestedLabel: string | null
  type: TemplateFieldType
  rect: TemplateRect
  detectedValue: string | null
  sampleValue: string | null
  required: boolean
  transforms: TemplateFieldTransformStepDraft[]
}

type TemplateFieldTransformStepDraft = {
  id: string
  operation: TemplateFieldTransformOperation
  from: string
  to: string
  chars: string
  delimiter: string
  index: string
  mode: TemplateFieldTransformCaseMode
  output: TemplateFieldTransformDateOutput
}

type TemplateFieldDraftForm = {
  name: string
  label: string
  type: TemplateFieldType
  detectedValue: string
  suggestedLabel: string
  required: boolean
}

type TemplateEditorState = {
  name: string
  description: string
  isActive: boolean
  sourcePdfBlob: Blob | null
  previewImageDataUrl: string
  pageSize: { width: number; height: number } | null
  textTokens: PdfTextToken[]
  fields: TemplateEditorField[]
  sampleFileId: string
  sampleFileName: string
}

type ClassificationRuleNodeDraft = {
  id: string
  nodeType: 'folder' | 'file'
  conflictPolicy: 'use_existing' | 'create_new' | null
  nameParts: ClassificationRuleNamePartDraft[]
}

type ClassificationRuleNamePartDraft = {
  id: string
  partType: RulePartTypeDraft
  fieldKey: string
  literalValue: string
  indexKind: ClassificationRuleIndexKind
  indexStartNumeric: string
  indexStartAlpha: string
  indexDirection: ClassificationRuleIndexDirection
}

type RuleFieldOption = {
  key: string
  label: string
  required: boolean
  previewValue: string
}

type RulePartTypeDraft = ClassificationRulePartType | 'space'

function normalizeTenantId(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
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

const transformOperationOptions: Array<{ value: TemplateFieldTransformOperation; label: string }> = [
  { value: 'trim', label: 'Trim (recortar espacios)' },
  { value: 'replace', label: 'Replace (reemplazar texto)' },
  { value: 'remove_chars', label: 'Remove chars (quitar caracteres)' },
  { value: 'split', label: 'Split (dividir por separador)' },
  { value: 'case', label: 'Case (mayus/minus/titulo)' },
  { value: 'date_format', label: 'Date format (formato fecha)' },
]

const transformCaseModeOptions: Array<{ value: TemplateFieldTransformCaseMode; label: string }> = [
  { value: 'upper', label: 'MAYUSCULAS' },
  { value: 'lower', label: 'minusculas' },
  { value: 'title', label: 'Titulo' },
]

const transformDateOutputOptions: Array<{ value: TemplateFieldTransformDateOutput; label: string }> = [
  { value: 'DD', label: 'DD' },
  { value: 'MM', label: 'MM' },
  { value: 'YYYY', label: 'YYYY' },
  { value: 'MM/YYYY', label: 'MM/YYYY' },
  { value: 'YYYY-MM', label: 'YYYY-MM' },
  { value: 'MMM', label: 'MMM (mes corto ES)' },
  { value: 'MMMM', label: 'MMMM (mes completo ES)' },
]

type RulePaletteItemKind = 'field' | 'index' | 'space' | 'literal'

type RulePaletteItem = {
  id: string
  label: string
  kind: RulePaletteItemKind
  fieldKey?: string
  icon: LucideIcon
  highlighted?: boolean
}

type RuleDragOverlayChipDraft = {
  label: string
  kind: RulePaletteItemKind
}

const RULE_DND_SOURCE_PREFIX = 'rule-source'
const RULE_DND_PART_PREFIX = 'rule-part'
const RULE_DND_DROP_PREFIX = 'rule-drop'

function buildRuleSourceDndId(sourceId: string): string {
  return `${RULE_DND_SOURCE_PREFIX}:${sourceId}`
}

function buildRulePartDndId(nodeId: string, partId: string): string {
  return `${RULE_DND_PART_PREFIX}:${nodeId}:${partId}`
}

function buildRuleDropDndId(nodeId: string): string {
  return `${RULE_DND_DROP_PREFIX}:${nodeId}`
}

function parseRulePartDndId(rawId: string): { nodeId: string; partId: string } | null {
  if (!rawId.startsWith(`${RULE_DND_PART_PREFIX}:`)) {
    return null
  }
  const chunks = rawId.split(':')
  if (chunks.length !== 3 || !chunks[1] || !chunks[2]) {
    return null
  }
  return {
    nodeId: chunks[1],
    partId: chunks[2],
  }
}

function parseRuleDropDndId(rawId: string): { nodeId: string } | null {
  if (!rawId.startsWith(`${RULE_DND_DROP_PREFIX}:`)) {
    return null
  }
  const chunks = rawId.split(':')
  if (chunks.length !== 2 || !chunks[1]) {
    return null
  }
  return { nodeId: chunks[1] }
}

function resolveRuleFieldLabel(fieldKey: string, fieldOptions: RuleFieldOption[]): string {
  const found = fieldOptions.find((field) => field.key === fieldKey)
  return found?.label || fieldKey || 'Campo'
}

type RuleDragOverlayChipProps = RuleDragOverlayChipDraft & {
  overlay?: boolean
}

function RuleDragOverlayChip({ label, kind, overlay = false }: RuleDragOverlayChipProps) {
  const toneClassName =
    kind === 'index'
      ? 'border-green-300 bg-green-100 text-green-800'
      : kind === 'space'
        ? 'border-green-200 bg-green-50 text-green-800'
        : kind === 'literal'
          ? 'border-slate-300 bg-white text-slate-700'
          : 'border-slate-200 bg-slate-100 text-slate-700'

  return (
    <div
      className={`inline-flex h-8 w-auto max-w-[260px] items-center gap-1 rounded-full border px-2.5 text-[13px] font-semibold shadow-lg ${
        overlay ? 'pointer-events-none cursor-grabbing' : ''
      } ${toneClassName}`}
    >
      <span className="truncate whitespace-nowrap">{label || 'Texto'}</span>
    </div>
  )
}

type RulePaletteChipProps = {
  item: RulePaletteItem
  disabled: boolean
  metaText?: string
}

function RulePaletteChip({ item, disabled, metaText = '' }: RulePaletteChipProps) {
  const Icon = item.icon
  const chipTitle = metaText ? `${item.label}: ${metaText}` : item.label
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: buildRuleSourceDndId(item.id),
    data: {
      sourceKind: item.kind,
      fieldKey: item.fieldKey || '',
      label: item.label,
    },
    disabled,
  })

  return (
    <button
      ref={setNodeRef}
      type="button"
      title={chipTitle}
      className={`group flex min-w-0 w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-left transition ${
        item.highlighted
          ? 'border-green-300 bg-[repeating-linear-gradient(135deg,rgba(190,242,100,0.10),rgba(190,242,100,0.10)_6px,rgba(255,255,255,0.7)_6px,rgba(255,255,255,0.7)_12px)] text-green-800'
          : 'border-slate-200 bg-white text-slate-700'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-grab active:cursor-grabbing'} ${
        isDragging ? 'opacity-40' : ''
      }`}
      disabled={disabled}
      {...attributes}
      {...listeners}
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="block min-w-0 truncate text-[13px] font-semibold">{item.label}</span>
        {metaText && <span className="block min-w-0 truncate text-[10px] text-slate-500">{metaText}</span>}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-slate-400 group-hover:text-slate-500">
        <Icon className={`h-3.5 w-3.5 ${item.highlighted ? 'text-green-700' : ''}`} />
        <GripVertical className="h-3.5 w-3.5" />
      </span>
    </button>
  )
}

type RuleBuilderLaneProps = {
  nodeId: string
  nodeType: 'folder' | 'file'
  parts: ClassificationRuleNamePartDraft[]
  fieldOptions: RuleFieldOption[]
  paletteItems: RulePaletteItem[]
  saving: boolean
  isOver: boolean
  onLiteralChange: (nodeId: string, partId: string, value: string) => void
  onRemove: (nodeId: string, partId: string) => void
  onAddPart: (nodeId: string, sourceKind: RulePaletteItemKind, fieldKey?: string) => void
}

function RuleBuilderLane({
  nodeId,
  nodeType,
  parts,
  fieldOptions,
  paletteItems,
  saving,
  isOver,
  onLiteralChange,
  onRemove,
  onAddPart,
}: RuleBuilderLaneProps) {
  const [showInsertMenu, setShowInsertMenu] = useState(false)
  const [showTemplateFieldOptions, setShowTemplateFieldOptions] = useState(false)
  const [insertMenuPosition, setInsertMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const insertMenuRef = useRef<HTMLDivElement | null>(null)
  const addButtonRef = useRef<HTMLButtonElement | null>(null)
  const sortableIds = parts.map((part) => buildRulePartDndId(nodeId, part.id))
  const fixedWildcardItems = useMemo(
    () =>
      (['space', 'index', 'literal'] as RulePaletteItemKind[])
        .map((kind) => paletteItems.find((item) => item.kind === kind) || null)
        .filter((item): item is RulePaletteItem => item !== null),
    [paletteItems],
  )
  const templateFieldItems = useMemo(() => paletteItems.filter((item) => item.kind === 'field'), [paletteItems])

  useEffect(() => {
    if (!showInsertMenu) {
      return
    }
    const handleOutsidePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) {
        return
      }
      if (insertMenuRef.current?.contains(target) || addButtonRef.current?.contains(target)) {
        return
      }
      setShowInsertMenu(false)
      setShowTemplateFieldOptions(false)
    }
    const handleViewportChange = () => {
      setShowInsertMenu(false)
      setShowTemplateFieldOptions(false)
    }
    window.addEventListener('mousedown', handleOutsidePointerDown)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      window.removeEventListener('mousedown', handleOutsidePointerDown)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [showInsertMenu])

  const openInsertMenu = useCallback(() => {
    if (showInsertMenu) {
      setShowInsertMenu(false)
      setShowTemplateFieldOptions(false)
      return
    }
    if (!addButtonRef.current) {
      setShowInsertMenu(true)
      setShowTemplateFieldOptions(false)
      return
    }
    const rect = addButtonRef.current.getBoundingClientRect()
    const maxLeft = Math.max(window.innerWidth - 240, 8)
    setInsertMenuPosition({
      left: Math.min(Math.max(rect.left, 8), maxLeft),
      top: Math.min(rect.bottom + 6, Math.max(window.innerHeight - 220, 8)),
    })
    setShowTemplateFieldOptions(false)
    setShowInsertMenu(true)
  }, [showInsertMenu])

  return (
    <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
      <div
        className={`min-h-[56px] rounded-lg border-2 border-dashed p-2.5 transition-colors ${
          isOver ? 'border-green-500 bg-green-50' : 'border-slate-300 bg-slate-50'
        }`}
      >
        <div className="flex w-full flex-row items-center flex-wrap gap-2">
          {parts.map((part) => (
            <RuleSortableChip
              key={part.id}
              nodeId={nodeId}
              part={part}
              fieldOptions={fieldOptions}
              saving={saving}
              onLiteralChange={onLiteralChange}
              onRemove={onRemove}
            />
          ))}

          <button
            ref={addButtonRef}
            type="button"
            className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-100 px-2 text-slate-500 transition hover:border-slate-300 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            onClick={openInsertMenu}
            disabled={saving}
            title={nodeType === 'file' ? 'Agregar parte al nombre de archivo' : 'Agregar parte al nombre de carpeta'}
            aria-expanded={showInsertMenu && !saving}
            aria-haspopup="menu"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {showInsertMenu && !saving && insertMenuPosition && (
          <div
            ref={insertMenuRef}
            className="fixed z-[1200] w-56 rounded-xl border border-slate-200 bg-white p-1 shadow-2xl"
            style={{ left: insertMenuPosition.left, top: insertMenuPosition.top }}
            role="menu"
            aria-label="Agregar parte de nombre"
          >
            {fixedWildcardItems.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={`${nodeId}-${item.id}`}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
                  onClick={() => {
                    onAddPart(nodeId, item.kind, item.fieldKey)
                    setShowInsertMenu(false)
                    setShowTemplateFieldOptions(false)
                  }}
                  disabled={saving}
                  role="menuitem"
                >
                  <Icon className="h-4 w-4 text-slate-500" />
                  <span className="truncate">{item.label}</span>
                </button>
              )
            })}

            <div className="mt-1 border-t border-slate-100 pt-1">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
                onClick={() => setShowTemplateFieldOptions((prev) => !prev)}
                onMouseEnter={() => setShowTemplateFieldOptions(true)}
                disabled={saving}
                role="menuitem"
                aria-expanded={showTemplateFieldOptions}
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  <Tags className="h-4 w-4 text-slate-500" />
                  <span className="truncate">Campos Dinámicos...</span>
                </span>
                <ChevronRight className={`h-3.5 w-3.5 text-slate-400 transition ${showTemplateFieldOptions ? 'rotate-90' : ''}`} />
              </button>

              {showTemplateFieldOptions && (
                <div className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50 p-1">
                  {templateFieldItems.length === 0 ? (
                    <p className="px-2 py-2 text-xs font-semibold text-slate-500">Sin campos dinámicos disponibles.</p>
                  ) : (
                    templateFieldItems.map((item) => {
                      const Icon = item.icon
                      return (
                        <button
                          key={`${nodeId}-field-${item.id}`}
                          type="button"
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-semibold text-slate-700 transition hover:bg-white"
                          onClick={() => {
                            onAddPart(nodeId, item.kind, item.fieldKey)
                            setShowInsertMenu(false)
                            setShowTemplateFieldOptions(false)
                          }}
                          disabled={saving}
                          role="menuitem"
                        >
                          <Icon className="h-4 w-4 text-slate-500" />
                          <span className="truncate">{item.label}</span>
                        </button>
                      )
                    })
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </SortableContext>
  )
}

type RuleBuilderNodeCardProps = {
  node: ClassificationRuleNodeDraft
  nodeIndex: number
  fieldOptions: RuleFieldOption[]
  paletteItems: RulePaletteItem[]
  saving: boolean
  onLiteralChange: (nodeId: string, partId: string, value: string) => void
  onRemovePart: (nodeId: string, partId: string) => void
  onAddPart: (nodeId: string, sourceKind: RulePaletteItemKind, fieldKey?: string) => void
  onRemoveFolderLevel: (nodeId: string) => void
}

function RuleBuilderNodeCard({
  node,
  nodeIndex,
  fieldOptions,
  paletteItems,
  saving,
  onLiteralChange,
  onRemovePart,
  onAddPart,
  onRemoveFolderLevel,
}: RuleBuilderNodeCardProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: buildRuleDropDndId(node.id),
    data: {
      nodeId: node.id,
      kind: 'rule-drop',
    },
  })

  return (
    <div className="relative w-full pl-14">
      <span className="pointer-events-none absolute left-[15px] top-0 h-full border-l border-dashed border-slate-300" />
      <span className="pointer-events-none absolute left-[15px] top-7 w-8 border-t border-dashed border-slate-300" />
      <span className="absolute left-0 top-3 inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-[11px] font-extrabold text-slate-600">
        {node.nodeType === 'folder' ? nodeIndex + 1 : <FileText className="h-4 w-4 text-green-700" />}
      </span>

      <article
        ref={setNodeRef}
        className="w-full rounded-xl border border-slate-200 bg-white p-3.5 transition-colors"
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <strong className="text-base font-extrabold text-slate-800">
            {node.nodeType === 'folder' ? `Carpeta nivel ${nodeIndex + 1}` : 'Archivo final'}
          </strong>
          {node.nodeType === 'folder' && (
            <button
              type="button"
              className="text-sm font-bold text-red-500 transition hover:text-red-600"
              onClick={() => onRemoveFolderLevel(node.id)}
              disabled={saving}
            >
              Eliminar nivel
            </button>
          )}
        </div>

        {node.nodeType === 'file' && (
          <p className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.08em] text-slate-500">
            Arrastrá y ordená chips para componer el nombre final del archivo.
          </p>
        )}

        <div className="flex items-start gap-2">
          {node.nodeType === 'file' && <span className="text-sm font-bold text-slate-600">Archivo:</span>}
          <div className="min-w-0 flex-1">
            <RuleBuilderLane
              nodeId={node.id}
              nodeType={node.nodeType}
              parts={node.nameParts}
              fieldOptions={fieldOptions}
              paletteItems={paletteItems}
              saving={saving}
              isOver={isOver}
              onLiteralChange={onLiteralChange}
              onRemove={onRemovePart}
              onAddPart={onAddPart}
            />
          </div>
        </div>

        <p className="text-xs text-slate-500">
          Vista previa nodo:{' '}
          <strong className="font-semibold text-slate-700">{buildRuleNodePreview(node, fieldOptions)}</strong>
        </p>
      </article>
    </div>
  )
}

type RuleSortableChipProps = {
  nodeId: string
  part: ClassificationRuleNamePartDraft
  fieldOptions: RuleFieldOption[]
  saving: boolean
  onLiteralChange: (nodeId: string, partId: string, value: string) => void
  onRemove: (nodeId: string, partId: string) => void
}

function RuleSortableChip({ nodeId, part, fieldOptions, saving, onLiteralChange, onRemove }: RuleSortableChipProps) {
  const sortableId = buildRulePartDndId(nodeId, part.id)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    data: {
      nodeId,
      partId: part.id,
      kind: 'rule-part',
    },
    disabled: saving,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const sharedChipClassName = `inline-flex h-8 w-auto shrink-0 items-center gap-1 rounded-full border px-2 text-[13px] font-semibold ${
    isDragging ? 'opacity-40' : ''
  }`

  if (part.partType === 'literal') {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={`${sharedChipClassName} border-slate-300 bg-white text-slate-700`}
      >
        <button
          type="button"
          className="inline-flex h-6 w-5 items-center justify-center rounded text-slate-400 transition hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
          {...attributes}
          {...listeners}
          disabled={saving}
          aria-label="Mover texto"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <Tag className="h-3.5 w-3.5 text-slate-400" />
        <input
          style={{ width: `${Math.max(part.literalValue.length, 5)}ch` }}
          className="h-6 min-w-[5ch] border-0 bg-transparent px-0 text-[13px] font-semibold text-slate-700 outline-none placeholder:text-slate-400"
          value={part.literalValue}
          onChange={(event) => onLiteralChange(nodeId, part.id, event.target.value)}
          placeholder="Texto..."
          disabled={saving}
        />
        <button
          type="button"
          className="inline-flex h-6 w-5 items-center justify-center rounded text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => onRemove(nodeId, part.id)}
          disabled={saving}
          aria-label="Eliminar texto"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  const chipLabel =
    part.partType === 'field'
      ? resolveRuleFieldLabel(part.fieldKey, fieldOptions)
      : part.partType === 'space'
        ? 'ESPACIO [ _ ]'
        : `Indice ${getRuleIndexPreview(part)}`

  const chipTone =
    part.partType === 'field'
      ? 'border-slate-200 bg-slate-100 text-slate-700'
      : part.partType === 'index'
        ? 'border-green-300 bg-green-100 text-green-800'
        : 'border-green-200 bg-green-50 text-green-800'

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`${sharedChipClassName} ${chipTone}`}
    >
      <button
        type="button"
        className="inline-flex h-6 w-5 items-center justify-center rounded text-slate-400 transition hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
        {...attributes}
        {...listeners}
        disabled={saving}
        aria-label={`Mover ${chipLabel}`}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <span>{chipLabel}</span>
      <button
        type="button"
        className="inline-flex h-6 w-5 items-center justify-center rounded text-slate-500 transition hover:bg-white/70 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => onRemove(nodeId, part.id)}
        disabled={saving}
        aria-label={`Eliminar ${chipLabel}`}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
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

function buildTemplateNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.pdf$/i, '').trim()
  return base || 'Nueva plantilla'
}

function createEmptyTemplateEditor(): TemplateEditorState {
  return {
    name: '',
    description: '',
    isActive: true,
    sourcePdfBlob: null,
    previewImageDataUrl: '',
    pageSize: null,
    textTokens: [],
    fields: [],
    sampleFileId: '',
    sampleFileName: '',
  }
}

function createEmptyTemplateFieldDraft(): TemplateFieldDraftForm {
  return {
    name: '',
    label: '',
    type: 'string',
    detectedValue: '',
    suggestedLabel: '',
    required: false,
  }
}

function clampUnit(value: number): number {
  if (value < 0) {
    return 0
  }
  if (value > 1) {
    return 1
  }
  return value
}

function sanitizeFieldKey(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || fallback
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `fld-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

function normalizeTransformOperation(value: unknown): TemplateFieldTransformOperation {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'replace' || raw === 'remove_chars' || raw === 'split' || raw === 'case' || raw === 'date_format') {
    return raw
  }
  return 'trim'
}

function createTransformStepDraft(operation: TemplateFieldTransformOperation = 'trim'): TemplateFieldTransformStepDraft {
  return {
    id: randomId(),
    operation,
    from: '',
    to: '',
    chars: '',
    delimiter: '',
    index: '1',
    mode: 'lower',
    output: 'YYYY',
  }
}

function mapApiStepToDraft(step: TemplateFieldTransformStep): TemplateFieldTransformStepDraft {
  const operation = normalizeTransformOperation(step.operation)
  const draft = createTransformStepDraft(operation)
  draft.from = typeof step.from === 'string' ? step.from : ''
  draft.to = typeof step.to === 'string' ? step.to : ''
  draft.chars = typeof step.chars === 'string' ? step.chars : ''
  draft.delimiter = typeof step.delimiter === 'string' ? step.delimiter : ''
  draft.index = typeof step.index === 'number' && Number.isFinite(step.index) && step.index >= 1 ? String(step.index) : '1'
  if (step.mode === 'upper' || step.mode === 'lower' || step.mode === 'title') {
    draft.mode = step.mode
  }
  if (
    step.output === 'DD' ||
    step.output === 'MM' ||
    step.output === 'YYYY' ||
    step.output === 'MM/YYYY' ||
    step.output === 'YYYY-MM' ||
    step.output === 'MMM' ||
    step.output === 'MMMM'
  ) {
    draft.output = step.output
  }
  return draft
}

function mapDraftStepToApi(step: TemplateFieldTransformStepDraft): TemplateFieldTransformStep {
  const operation = normalizeTransformOperation(step.operation)
  if (operation === 'replace') {
    return { operation, from: step.from, to: step.to }
  }
  if (operation === 'remove_chars') {
    return { operation, chars: step.chars }
  }
  if (operation === 'split') {
    const parsedIndex = Number.parseInt(step.index, 10)
    return { operation, delimiter: step.delimiter, index: Number.isFinite(parsedIndex) && parsedIndex >= 1 ? parsedIndex : 1 }
  }
  if (operation === 'case') {
    return { operation, mode: step.mode }
  }
  if (operation === 'date_format') {
    return { operation, output: step.output }
  }
  return { operation }
}

function mapFieldTransformsByKey(
  fieldTransforms: TemplateFieldTransformGroup[] | null | undefined,
): Map<string, TemplateFieldTransformStepDraft[]> {
  const byKey = new Map<string, TemplateFieldTransformStepDraft[]>()
  const groups = Array.isArray(fieldTransforms) ? fieldTransforms : []
  for (const group of groups) {
    const key = typeof group.field_key === 'string' ? group.field_key.trim() : ''
    if (!key) {
      continue
    }
    const steps = Array.isArray(group.steps) ? group.steps.slice(0, 3).map(mapApiStepToDraft) : []
    byKey.set(key, steps)
  }
  return byKey
}

function serializeTemplateFieldTransforms(fields: TemplateEditorField[]): TemplateFieldTransformGroup[] {
  const out: TemplateFieldTransformGroup[] = []
  for (const field of fields) {
    const key = field.key.trim()
    if (!key) {
      continue
    }
    const steps = (Array.isArray(field.transforms) ? field.transforms : []).slice(0, 3).map(mapDraftStepToApi)
    if (steps.length === 0) {
      continue
    }
    out.push({
      field_key: key,
      steps,
    })
  }
  return out
}

type DateParts = { day: number | null; month: number | null; year: number | null }
type TransformPipelinePreview = {
  snapshots: string[]
  result: string
  error: string | null
}

const transformSpanishMonths: Record<string, number> = {
  enero: 1,
  ene: 1,
  febrero: 2,
  feb: 2,
  marzo: 3,
  mar: 3,
  abril: 4,
  abr: 4,
  mayo: 5,
  may: 5,
  junio: 6,
  jun: 6,
  julio: 7,
  jul: 7,
  agosto: 8,
  ago: 8,
  septiembre: 9,
  setiembre: 9,
  sep: 9,
  set: 9,
  octubre: 10,
  oct: 10,
  noviembre: 11,
  nov: 11,
  diciembre: 12,
  dic: 12,
}

const transformMonthAbbr: Record<number, string> = {
  1: 'ENE',
  2: 'FEB',
  3: 'MAR',
  4: 'ABR',
  5: 'MAY',
  6: 'JUN',
  7: 'JUL',
  8: 'AGO',
  9: 'SEP',
  10: 'OCT',
  11: 'NOV',
  12: 'DIC',
}

const transformMonthFull: Record<number, string> = {
  1: 'ENERO',
  2: 'FEBRERO',
  3: 'MARZO',
  4: 'ABRIL',
  5: 'MAYO',
  6: 'JUNIO',
  7: 'JULIO',
  8: 'AGOSTO',
  9: 'SEPTIEMBRE',
  10: 'OCTUBRE',
  11: 'NOVIEMBRE',
  12: 'DICIEMBRE',
}

function parseDatePartsForTransform(rawValue: string): DateParts | null {
  const text = String(rawValue || '').replace(/\s+/g, ' ').trim()
  if (!text) {
    return null
  }

  const compact = text.replace(/[.-]/g, '/')
  let match = compact.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (match) {
    return {
      day: Number(match[1]),
      month: Number(match[2]),
      year: Number(match[3]),
    }
  }

  match = compact.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/)
  if (match) {
    return {
      day: Number(match[3]),
      month: Number(match[2]),
      year: Number(match[1]),
    }
  }

  match = compact.match(/^(\d{1,2})\/(\d{4})$/)
  if (match) {
    return {
      day: null,
      month: Number(match[1]),
      year: Number(match[2]),
    }
  }

  match = compact.match(/^(\d{4})$/)
  if (match) {
    return {
      day: null,
      month: null,
      year: Number(match[1]),
    }
  }

  const normalized = text
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/[-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  match = normalized.match(/^([a-záéíóúñ]+)\s+(\d{4})$/)
  if (match) {
    const month = transformSpanishMonths[match[1]]
    if (!month) {
      return null
    }
    return { day: null, month, year: Number(match[2]) }
  }

  match = normalized.match(/^(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})$/)
  if (match) {
    const month = transformSpanishMonths[match[2]]
    if (!month) {
      return null
    }
    return { day: Number(match[1]), month, year: Number(match[3]) }
  }

  return null
}

function assertDatePartsForOutput(parts: DateParts, output: TemplateFieldTransformDateOutput, fieldKey: string): void {
  const { day, month, year } = parts
  if (month !== null && (month < 1 || month > 12)) {
    throw new Error(`Campo '${fieldKey}': el mes detectado no es valido`)
  }
  if (day !== null && (day < 1 || day > 31)) {
    throw new Error(`Campo '${fieldKey}': el dia detectado no es valido`)
  }
  if (output === 'DD' && day === null) {
    throw new Error(`Campo '${fieldKey}': el formato DD requiere dia`)
  }
  if ((output === 'MM' || output === 'MM/YYYY' || output === 'YYYY-MM' || output === 'MMM' || output === 'MMMM') && month === null) {
    throw new Error(`Campo '${fieldKey}': el formato ${output} requiere mes`)
  }
  if ((output === 'YYYY' || output === 'MM/YYYY' || output === 'YYYY-MM') && year === null) {
    throw new Error(`Campo '${fieldKey}': el formato ${output} requiere año`)
  }
}

function formatDateOutput(parts: DateParts, output: TemplateFieldTransformDateOutput): string {
  const { day, month, year } = parts
  if (output === 'DD') {
    return String(day || 0).padStart(2, '0')
  }
  if (output === 'MM') {
    return String(month || 0).padStart(2, '0')
  }
  if (output === 'YYYY') {
    return String(year || 0).padStart(4, '0')
  }
  if (output === 'MM/YYYY') {
    return `${String(month || 0).padStart(2, '0')}/${String(year || 0).padStart(4, '0')}`
  }
  if (output === 'YYYY-MM') {
    return `${String(year || 0).padStart(4, '0')}-${String(month || 0).padStart(2, '0')}`
  }
  if (output === 'MMM') {
    return transformMonthAbbr[month || 0] || ''
  }
  return transformMonthFull[month || 0] || ''
}

function applyTemplateFieldTransformStep(value: string, step: TemplateFieldTransformStepDraft, fieldKey: string): string {
  const current = String(value || '')
  if (!current.trim()) {
    return ''
  }

  const operation = normalizeTransformOperation(step.operation)
  if (operation === 'trim') {
    return current.trim()
  }
  if (operation === 'replace') {
    if (!step.from.trim()) {
      throw new Error(`Campo '${fieldKey}': replace requiere 'from'`)
    }
    return current.split(step.from).join(step.to)
  }
  if (operation === 'remove_chars') {
    if (!step.chars.trim()) {
      throw new Error(`Campo '${fieldKey}': remove_chars requiere 'chars'`)
    }
    const removeSet = new Set(step.chars.split(''))
    return current
      .split('')
      .filter((char) => !removeSet.has(char))
      .join('')
  }
  if (operation === 'split') {
    if (!step.delimiter.trim()) {
      throw new Error(`Campo '${fieldKey}': split requiere delimiter`)
    }
    const parsedIndex = Number.parseInt(step.index, 10)
    if (!Number.isFinite(parsedIndex) || parsedIndex < 1) {
      throw new Error(`Campo '${fieldKey}': split index debe ser >= 1`)
    }
    const parts = current.split(step.delimiter)
    if (parsedIndex > parts.length) {
      throw new Error(`Campo '${fieldKey}': split index fuera de rango`)
    }
    return parts[parsedIndex - 1]
  }
  if (operation === 'case') {
    if (step.mode === 'upper') {
      return current.toUpperCase()
    }
    if (step.mode === 'lower') {
      return current.toLowerCase()
    }
    return current
      .toLowerCase()
      .replace(/(^|\s)\S/g, (match) => match.toUpperCase())
  }
  if (operation === 'date_format') {
    const parsed = parseDatePartsForTransform(current)
    if (!parsed) {
      throw new Error(`Campo '${fieldKey}': no se pudo parsear fecha`)
    }
    assertDatePartsForOutput(parsed, step.output, fieldKey)
    return formatDateOutput(parsed, step.output)
  }

  return current
}

function buildTransformPipelinePreview(
  value: string | null | undefined,
  steps: TemplateFieldTransformStepDraft[],
  fieldKey: string,
): TransformPipelinePreview {
  const snapshots = [String(value || '')]
  let current = snapshots[0]
  try {
    for (const step of steps.slice(0, 3)) {
      current = applyTemplateFieldTransformStep(current, step, fieldKey)
      snapshots.push(current)
    }
    return {
      snapshots,
      result: current,
      error: null,
    }
  } catch (error) {
    return {
      snapshots,
      result: current,
      error: error instanceof Error ? error.message : 'Error de transformacion',
    }
  }
}

function normalizeRect(start: { x: number; y: number }, end: { x: number; y: number }): TemplateRect {
  const x1 = clampUnit(Math.min(start.x, end.x))
  const y1 = clampUnit(Math.min(start.y, end.y))
  const x2 = clampUnit(Math.max(start.x, end.x))
  const y2 = clampUnit(Math.max(start.y, end.y))
  return {
    page: 1,
    x: x1,
    y: y1,
    w: clampUnit(x2 - x1),
    h: clampUnit(y2 - y1),
  }
}

function rectIntersects(a: TemplateRect, b: TemplateRect): boolean {
  const ax2 = a.x + a.w
  const ay2 = a.y + a.h
  const bx2 = b.x + b.w
  const by2 = b.y + b.h
  return a.x < bx2 && ax2 > b.x && a.y < by2 && ay2 > b.y
}

function overlapRatioX(a: TemplateRect, b: TemplateRect): number {
  const left = Math.max(a.x, b.x)
  const right = Math.min(a.x + a.w, b.x + b.w)
  if (right <= left) {
    return 0
  }
  const minWidth = Math.max(Math.min(a.w, b.w), 0.0001)
  return (right - left) / minWidth
}

function detectTextByRect(tokens: PdfTextToken[], rect: TemplateRect): string {
  const selected = tokens
    .filter((token) =>
      rectIntersects(rect, {
        page: 1,
        x: token.x,
        y: token.y,
        w: token.w,
        h: token.h,
      }),
    )
    .sort((a, b) => {
      const dy = a.y - b.y
      if (Math.abs(dy) <= 0.008) {
        return a.x - b.x
      }
      return dy
    })

  if (selected.length === 0) {
    return ''
  }

  const lines: string[] = []
  let currentLine = ''
  let currentY = selected[0].y
  for (const token of selected) {
    if (Math.abs(token.y - currentY) > 0.01) {
      if (currentLine.trim()) {
        lines.push(currentLine.trim().replace(/\s+/g, ' '))
      }
      currentLine = token.text
      currentY = token.y
      continue
    }
    currentLine = `${currentLine} ${token.text}`.trim()
  }
  if (currentLine.trim()) {
    lines.push(currentLine.trim().replace(/\s+/g, ' '))
  }
  return lines.join('\n').trim()
}

function suggestLabelByRect(tokens: PdfTextToken[], rect: TemplateRect): string {
  const centerY = rect.y + rect.h / 2
  const leftCandidates = tokens
    .filter((token) => {
      const tokenCenterY = token.y + token.h / 2
      return Math.abs(tokenCenterY - centerY) <= 0.02 && token.x + token.w <= rect.x + 0.002
    })
    .sort((a, b) => b.x + b.w - (a.x + a.w))

  if (leftCandidates.length > 0) {
    return leftCandidates[0].text.replace(/[:\-\s]+$/g, '').trim()
  }

  const aboveCandidates = tokens
    .filter(
      (token) =>
        token.y + token.h <= rect.y + 0.002 &&
        overlapRatioX(
          rect,
          {
            page: 1,
            x: token.x,
            y: token.y,
            w: token.w,
            h: token.h,
          },
        ) > 0.2,
    )
    .sort((a, b) => b.y + b.h - (a.y + a.h))

  if (aboveCandidates.length > 0) {
    return aboveCandidates[0].text.replace(/[:\-\s]+$/g, '').trim()
  }
  return ''
}

function resolveTemplateMode(template: { template_mode?: TemplateMode; custom_model?: TemplateCustomModel | null }): TemplateMode {
  if (template.template_mode === 'document' || template.template_mode === 'processing') {
    return template.template_mode
  }
  if (template.custom_model?.mode === 'document') {
    return 'document'
  }
  return 'processing'
}

function mapDocumentFields(
  customModel: TemplateCustomModel | null | undefined,
  fieldTransforms?: TemplateFieldTransformGroup[] | null,
): TemplateEditorField[] {
  const result: TemplateEditorField[] = []
  const transformsByKey = mapFieldTransformsByKey(fieldTransforms)
  const fields = Array.isArray(customModel?.fields) ? customModel.fields : []
  for (const item of fields) {
    const raw = item as Record<string, unknown>
    if (typeof raw.name !== 'string') {
      continue
    }
    const rectRaw = raw.rect
    if (!rectRaw || typeof rectRaw !== 'object') {
      continue
    }
    const rectObj = rectRaw as Record<string, unknown>
    const rect: TemplateRect = {
      page: 1,
      x: clampUnit(Number(rectObj.x || 0)),
      y: clampUnit(Number(rectObj.y || 0)),
      w: clampUnit(Number(rectObj.w || 0)),
      h: clampUnit(Number(rectObj.h || 0)),
    }
    if (rect.w <= 0 || rect.h <= 0) {
      continue
    }
    const name = raw.name.trim()
    const key = typeof raw.key === 'string' ? raw.key.trim() : ''
    const resolvedKey = key || sanitizeFieldKey(name, `field_${result.length + 1}`)
    result.push({
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomId(),
      key: resolvedKey,
      name,
      label: typeof raw.label === 'string' ? raw.label.trim() || null : null,
      suggestedLabel: typeof raw.suggested_label === 'string' ? raw.suggested_label.trim() || null : null,
      type:
        raw.type === 'number' || raw.type === 'date' || raw.type === 'array' || raw.type === 'string'
          ? raw.type
          : 'string',
      rect,
      detectedValue: typeof raw.detected_value === 'string' ? raw.detected_value : null,
      sampleValue: typeof raw.sample_value === 'string' ? raw.sample_value : null,
      required: Boolean(raw.required),
      transforms: transformsByKey.get(resolvedKey)?.slice(0, 3) || [],
    })
  }
  return result
}

function mapRuleFieldOptions(
  customModel: TemplateCustomModel | null | undefined,
  fieldTransforms?: TemplateFieldTransformGroup[] | null,
): RuleFieldOption[] {
  const fields = mapDocumentFields(customModel, fieldTransforms)
  return fields.map((field) => ({
    key: field.key,
    label: field.name || field.label || field.key,
    required: field.required,
    previewValue: (() => {
      const fallback = field.label?.trim() || field.name || field.key
      const source = field.detectedValue?.trim() || field.sampleValue?.trim() || ''
      if (!source) {
        return fallback
      }
      const preview = buildTransformPipelinePreview(source, field.transforms, field.key)
      if (preview.error) {
        return `${source} [error]`
      }
      return preview.result.trim() || fallback
    })(),
  }))
}

function createRulePartDraft(partType: RulePartTypeDraft, fieldKey = '', literalValue = ''): ClassificationRuleNamePartDraft {
  return {
    id: randomId(),
    partType,
    fieldKey,
    literalValue,
    indexKind: 'numeric',
    indexStartNumeric: '',
    indexStartAlpha: '',
    indexDirection: 'incremental',
  }
}

function createRulePartFromPalette(
  sourceKind: RulePaletteItemKind,
  fieldKey: string,
  fallbackFieldKey: string,
): ClassificationRuleNamePartDraft {
  if (sourceKind === 'index') {
    return createRulePartDraft('index')
  }
  if (sourceKind === 'space') {
    return createRulePartDraft('space', '', ' ')
  }
  if (sourceKind === 'literal') {
    return createRulePartDraft('literal', '', '')
  }
  return createRulePartDraft('field', fieldKey || fallbackFieldKey)
}

function getRuleIndexPreview(part: ClassificationRuleNamePartDraft): string {
  if (part.indexDirection === 'incremental') {
    return part.indexKind === 'alphabetic' ? '[A+]' : '[0+]'
  }
  if (part.indexKind === 'alphabetic') {
    const alpha = part.indexStartAlpha.trim().toUpperCase() || '?'
    return `[${alpha}-]`
  }
  const numeric = Number.parseInt(part.indexStartNumeric, 10)
  const base = Number.isFinite(numeric) ? String(numeric) : '?'
  return `[${base}-]`
}

function createRuleNodeDraft(
  nodeType: 'folder' | 'file',
  fieldOptions: RuleFieldOption[],
  conflictPolicy: 'use_existing' | 'create_new' | null = null,
): ClassificationRuleNodeDraft {
  const defaultFieldKey = fieldOptions[0]?.key || ''
  return {
    id: randomId(),
    nodeType,
    conflictPolicy: nodeType === 'folder' ? conflictPolicy || 'use_existing' : null,
    nameParts: defaultFieldKey
      ? [createRulePartDraft('field', defaultFieldKey)]
      : [createRulePartDraft('literal', '', nodeType === 'folder' ? 'Carpeta' : 'Documento')],
  }
}

function buildDefaultRuleNodes(fieldOptions: RuleFieldOption[]): ClassificationRuleNodeDraft[] {
  const folderNode = createRuleNodeDraft('folder', fieldOptions, 'use_existing')
  const fileNode = createRuleNodeDraft('file', fieldOptions, null)
  return [folderNode, fileNode]
}

function mapRuleToDraftNodes(rule: ClassificationRule | null | undefined, fieldOptions: RuleFieldOption[]): ClassificationRuleNodeDraft[] {
  const nodes = Array.isArray(rule?.nodes) ? [...rule.nodes] : []
  if (nodes.length === 0) {
    return buildDefaultRuleNodes(fieldOptions)
  }

  const mapped: ClassificationRuleNodeDraft[] = nodes
    .sort((a, b) => (a.node_order || 0) - (b.node_order || 0))
    .map((node) => {
      const nodeType = node.node_type === 'folder' ? 'folder' : 'file'
      const parts = Array.isArray(node.name_parts) ? [...node.name_parts] : []
      const mappedParts: ClassificationRuleNamePartDraft[] = parts
        .sort((a, b) => (a.part_order || 0) - (b.part_order || 0))
        .map((part) => ({
          id: part.part_id || randomId(),
          partType:
            part.part_type === 'index'
              ? 'index'
              : part.part_type === 'literal'
                ? (part.literal_value || '') === ' '
                  ? 'space'
                  : 'literal'
                : 'field',
          fieldKey: typeof part.field_key === 'string' ? part.field_key : '',
          literalValue: typeof part.literal_value === 'string' ? part.literal_value : '',
          indexKind: part.index_kind === 'alphabetic' ? 'alphabetic' : 'numeric',
          indexStartNumeric:
            typeof part.index_start_numeric === 'number' && Number.isFinite(part.index_start_numeric)
              ? String(part.index_start_numeric)
              : '',
          indexStartAlpha:
            typeof part.index_start_alpha === 'string' && /^[A-Za-z]$/.test(part.index_start_alpha.trim())
              ? part.index_start_alpha.trim().toUpperCase()
              : '',
          indexDirection: part.index_direction === 'decremental' ? 'decremental' : 'incremental',
        }))

      return {
        id: node.node_id || randomId(),
        nodeType,
        conflictPolicy:
          nodeType === 'folder' && (node.conflict_policy === 'create_new' || node.conflict_policy === 'use_existing')
            ? node.conflict_policy
            : nodeType === 'folder'
              ? 'use_existing'
              : null,
        nameParts: mappedParts,
      }
    })

  const folderNodes = mapped.filter((node) => node.nodeType === 'folder')
  const fileNodes = mapped.filter((node) => node.nodeType === 'file')
  const fileNode = fileNodes[fileNodes.length - 1] || createRuleNodeDraft('file', fieldOptions, null)
  return [...folderNodes, fileNode]
}

function buildClassificationRulePayload(nodes: ClassificationRuleNodeDraft[]): ClassificationRulePayload {
  return {
    nodes: nodes.map((node, index) => ({
      node_type: index === nodes.length - 1 ? 'file' : 'folder',
      conflict_policy: index === nodes.length - 1 ? null : node.conflictPolicy || 'use_existing',
      name_parts: node.nameParts.map((part) => ({
        part_type: part.partType === 'space' ? 'literal' : part.partType,
        field_key: part.partType === 'field' ? part.fieldKey.trim() || null : null,
        literal_value: part.partType === 'space' ? ' ' : part.partType === 'literal' ? part.literalValue.trim() : null,
        index_kind: part.partType === 'index' ? part.indexKind : null,
        index_start_numeric:
          part.partType === 'index' && part.indexKind === 'numeric' && part.indexDirection === 'decremental'
            ? Number.parseInt(part.indexStartNumeric, 10)
            : null,
        index_start_alpha:
          part.partType === 'index' && part.indexKind === 'alphabetic' && part.indexDirection === 'decremental'
            ? part.indexStartAlpha.trim().toUpperCase()
            : null,
        index_direction: part.partType === 'index' ? part.indexDirection : null,
      })),
    })),
  }
}

function resolveRuleFieldPreviewValue(fieldKey: string, fieldOptions: RuleFieldOption[]): string {
  const found = fieldOptions.find((field) => field.key === fieldKey)
  if (!found) {
    return `{${fieldKey}}`
  }
  return found.previewValue || `{${fieldKey}}`
}

function buildRuleNodePreview(node: ClassificationRuleNodeDraft, fieldOptions: RuleFieldOption[]): string {
  const text = node.nameParts
    .map((part) => {
      if (part.partType === 'space') {
        return ' '
      }
      if (part.partType === 'field') {
        return resolveRuleFieldPreviewValue(part.fieldKey, fieldOptions)
      }
      if (part.partType === 'index') {
        return getRuleIndexPreview(part)
      }
      return part.literalValue
    })
    .join('')
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact || '(vacio)'
}

function buildRulePathPreview(
  nodes: ClassificationRuleNodeDraft[],
  fieldOptions: RuleFieldOption[],
): { folders: string[]; fileName: string } {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { folders: [], fileName: '(archivo)' }
  }
  const folderNodes = nodes.slice(0, Math.max(nodes.length - 1, 0))
  const fileNode = nodes[nodes.length - 1] || null
  return {
    folders: folderNodes.map((node) => buildRuleNodePreview(node, fieldOptions)),
    fileName: fileNode ? buildRuleNodePreview(fileNode, fieldOptions) : '(archivo)',
  }
}

function resolveRuleStatusLabel(status: RuleStatus | undefined): string {
  if (status === 'ready') {
    return 'Regla lista'
  }
  if (status === 'invalid') {
    return 'Regla invalida'
  }
  return 'Sin regla'
}

async function fetchPdfBlob(url: string): Promise<Blob> {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  })
  if (!response.ok) {
    throw new Error(`No se pudo cargar el PDF (${response.status}).`)
  }
  const blob = await response.blob()
  if (blob.size === 0) {
    throw new Error('El PDF esta vacio.')
  }
  return blob
}

async function buildPdfPreviewFromBlob(blob: Blob): Promise<{
  previewImageDataUrl: string
  pageSize: { width: number; height: number }
  textTokens: PdfTextToken[]
}> {
  const data = await blob.arrayBuffer()
  const task = getDocument({ data })
  let pdf: Awaited<typeof task.promise> | null = null
  try {
    pdf = await task.promise
    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    const renderScale = Math.max(1.2, Math.min(2.2, 1500 / Math.max(viewport.width, 1)))
    const renderViewport = page.getViewport({ scale: renderScale })

    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(renderViewport.width)
    canvas.height = Math.ceil(renderViewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('No se pudo crear el canvas para el PDF.')
    }
    await page.render({ canvasContext: ctx, viewport: renderViewport }).promise
    const previewImageDataUrl = canvas.toDataURL('image/png')

    const textContent = await page.getTextContent()
    const textTokens: PdfTextToken[] = []
    for (const rawItem of textContent.items as Array<Record<string, unknown>>) {
      const text = typeof rawItem.str === 'string' ? rawItem.str.trim() : ''
      const transform = Array.isArray(rawItem.transform) ? rawItem.transform : null
      const width = typeof rawItem.width === 'number' ? rawItem.width : 0
      const baseHeight =
        typeof rawItem.height === 'number'
          ? rawItem.height
          : transform && typeof transform[0] === 'number'
            ? Number(transform[0])
            : 0
      if (!text || !transform || transform.length < 6 || width <= 0) {
        continue
      }
      const tokenHeight = Math.max(Math.abs(baseHeight), 1)
      const x = Number(transform[4] || 0)
      const yBottom = Number(transform[5] || 0)
      const yTop = viewport.height - yBottom - tokenHeight
      const token: PdfTextToken = {
        text,
        x: clampUnit(x / viewport.width),
        y: clampUnit(yTop / viewport.height),
        w: clampUnit(width / viewport.width),
        h: clampUnit(tokenHeight / viewport.height),
      }
      if (token.w > 0 && token.h > 0) {
        textTokens.push(token)
      }
    }

    return {
      previewImageDataUrl,
      pageSize: {
        width: viewport.width,
        height: viewport.height,
      },
      textTokens,
    }
  } catch (error) {
    console.error('[templates] Error al cargar preview PDF', error)
    if (isPdfWorkerLoadError(error)) {
      throw new Error(pdfWorkerLoadErrorMessage)
    }
    if (error instanceof Error) {
      throw error
    }
    throw new Error('No se pudo procesar el PDF seleccionado.')
  } finally {
    if (pdf) {
      await pdf.destroy()
    } else {
      task.destroy()
    }
  }
}

function BackofficeApp() {
  const environmentChip = getEnvironmentChip()
  const [tenantId, setTenantId] = useState<string>(() => {
    if (typeof window === 'undefined') {
      return defaultTenant
    }
    const saved = normalizeTenantId(window.localStorage.getItem(tenantStorageKey))
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
  const [processingMode, setProcessingMode] = useState<ProcessingMode>('default')
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [showProcessModeModal, setShowProcessModeModal] = useState(false)
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
  const [showTutorialModal, setShowTutorialModal] = useState(false)
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
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templateDraftLoading, setTemplateDraftLoading] = useState(false)
  const [templateSaving, setTemplateSaving] = useState(false)
  const [templateActionLoadingId, setTemplateActionLoadingId] = useState<string | null>(null)
  const [templateError, setTemplateError] = useState('')
  const [templateSuccess, setTemplateSuccess] = useState('')
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null)
  const [selectedDraftFileId, setSelectedDraftFileId] = useState('')
  const [uploadedTemplateFile, setUploadedTemplateFile] = useState<File | null>(null)
  const [showTemplateEditorModal, setShowTemplateEditorModal] = useState(false)
  const [templateEditor, setTemplateEditor] = useState<TemplateEditorState>(createEmptyTemplateEditor)
  const [templateFieldDraft, setTemplateFieldDraft] = useState<TemplateFieldDraftForm>(createEmptyTemplateFieldDraft)
  const [templatePendingRect, setTemplatePendingRect] = useState<TemplateRect | null>(null)
  const [templateDrawingStart, setTemplateDrawingStart] = useState<{ x: number; y: number } | null>(null)
  const [templateHoveredFieldId, setTemplateHoveredFieldId] = useState<string | null>(null)
  const [showClassificationRuleModal, setShowClassificationRuleModal] = useState(false)
  const [classificationRuleMandatory, setClassificationRuleMandatory] = useState(false)
  const [classificationRuleLoading, setClassificationRuleLoading] = useState(false)
  const [classificationRuleSaving, setClassificationRuleSaving] = useState(false)
  const [classificationRuleTemplateId, setClassificationRuleTemplateId] = useState('')
  const [classificationRuleTemplateName, setClassificationRuleTemplateName] = useState('')
  const [classificationRuleFieldOptions, setClassificationRuleFieldOptions] = useState<RuleFieldOption[]>([])
  const [classificationRuleNodes, setClassificationRuleNodes] = useState<ClassificationRuleNodeDraft[]>([])
  const [classificationRuleActiveOverlay, setClassificationRuleActiveOverlay] = useState<RuleDragOverlayChipDraft | null>(null)
  const [classificationRuleError, setClassificationRuleError] = useState('')
  const [classificationRuleSuccess, setClassificationRuleSuccess] = useState('')
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [authEmail] = useState<string>(() => {
    if (typeof window === 'undefined') {
      return ''
    }
    return window.localStorage.getItem(authEmailStorageKey)?.trim() || ''
  })
  const profilePopoverRef = useRef<HTMLDivElement | null>(null)
  const templateCanvasRef = useRef<HTMLDivElement | null>(null)
  const templateUploadInputRef = useRef<HTMLInputElement | null>(null)

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
    window.localStorage.setItem(tenantStorageKey, normalizeTenantId(tenantId) || defaultTenant)
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

  const loadTemplatesForTenant = useCallback(
    async (includeInactive = true) => {
      setTemplatesLoading(true)
      setTemplateError('')
      const response = await listTemplates(tenantId, includeInactive)
      setTemplatesLoading(false)
      if (!response.ok || !response.data) {
        setTemplates([])
        setTemplateError(response.error || 'No se pudieron cargar las plantillas.')
        return
      }
      setTemplates(response.data.templates || [])
    },
    [tenantId],
  )

  const resetTemplateEditor = useCallback(() => {
    setEditingTemplateId(null)
    setSelectedDraftFileId('')
    setUploadedTemplateFile(null)
    setTemplateEditor(createEmptyTemplateEditor())
    setTemplateFieldDraft(createEmptyTemplateFieldDraft())
    setTemplatePendingRect(null)
    setTemplateDrawingStart(null)
    setTemplateHoveredFieldId(null)
    setShowTemplateEditorModal(false)
    setTemplateError('')
  }, [])

  const createTemplateDraft = useCallback(async () => {
    let sourceBlob: Blob | null = null
    let sourceFileId = ''
    let sourceFileName = ''

    if (templateLocalUploadEnabled && uploadedTemplateFile) {
      sourceBlob = uploadedTemplateFile
      sourceFileName = uploadedTemplateFile.name
    } else if (selectedDraftFileId) {
      const selectedFile = pendingFiles.find((file) => file.id === selectedDraftFileId)
      if (!selectedFile) {
        setTemplateError('No se encontró el archivo seleccionado en INPUT.')
        return
      }
      sourceFileId = selectedFile.id
      sourceFileName = selectedFile.name
      try {
        sourceBlob = await fetchPdfBlob(buildDrivePdfDownloadUrl(tenantId, selectedFile.id))
      } catch (error) {
        setTemplateError(error instanceof Error ? error.message : 'No se pudo descargar el PDF desde Drive.')
        return
      }
    }

    if (!sourceBlob) {
      setTemplateError(
        templateLocalUploadEnabled
          ? 'Selecciona un PDF desde INPUT o sube un archivo modelo.'
          : 'Selecciona un PDF desde INPUT.',
      )
      return
    }

    setTemplateDraftLoading(true)
    setTemplateError('')
    setTemplateSuccess('')
    try {
      const preview = await buildPdfPreviewFromBlob(sourceBlob)
      setEditingTemplateId(null)
      setTemplateEditor({
        name: buildTemplateNameFromFile(sourceFileName || 'Nueva plantilla'),
        description: '',
        isActive: true,
        sourcePdfBlob: sourceBlob,
        previewImageDataUrl: preview.previewImageDataUrl,
        pageSize: preview.pageSize,
        textTokens: preview.textTokens,
        fields: [],
        sampleFileId: sourceFileId,
        sampleFileName: sourceFileName,
      })
      setTemplateFieldDraft(createEmptyTemplateFieldDraft())
      setTemplatePendingRect(null)
      setTemplateDrawingStart(null)
      setTemplateHoveredFieldId(null)
      setShowTemplateEditorModal(true)
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : 'No se pudo procesar el PDF seleccionado.')
    } finally {
      setTemplateDraftLoading(false)
    }
  }, [pendingFiles, selectedDraftFileId, tenantId, uploadedTemplateFile])

  const loadTemplateIntoEditor = useCallback(
    async (templateId: string) => {
      setTemplateActionLoadingId(templateId)
      setTemplateError('')
      setTemplateSuccess('')
      const response = await getTemplate(tenantId, templateId)
      if (!response.ok || !response.data) {
        setTemplateActionLoadingId(null)
        setTemplateError(response.error || 'No se pudo cargar la plantilla.')
        return
      }

      if (resolveTemplateMode(response.data) !== 'document') {
        setTemplateActionLoadingId(null)
        setTemplateError('Esta plantilla pertenece al flujo legado y no se edita desde el nuevo ABM.')
        return
      }

      const sample = response.data.sample_file_metadata || {}
      const sampleFileId = typeof sample.file_id === 'string' ? sample.file_id : ''
      const sampleFileName = typeof sample.file_name === 'string' ? sample.file_name : response.data.name

      try {
        let sourceBlob: Blob
        try {
          sourceBlob = await fetchPdfBlob(buildTemplateSourcePdfUrl(tenantId, templateId))
        } catch {
          if (!sampleFileId) {
            throw new Error('No hay PDF fuente asociado a la plantilla.')
          }
          sourceBlob = await fetchPdfBlob(buildDrivePdfDownloadUrl(tenantId, sampleFileId))
        }

        const preview = await buildPdfPreviewFromBlob(sourceBlob)
        setEditingTemplateId(templateId)
        setTemplateEditor({
          name: response.data.name,
          description: response.data.description || '',
          isActive: response.data.is_active,
          sourcePdfBlob: sourceBlob,
          previewImageDataUrl: preview.previewImageDataUrl,
          pageSize: preview.pageSize,
          textTokens: preview.textTokens,
          fields: mapDocumentFields(response.data.custom_model, response.data.field_transforms),
          sampleFileId,
          sampleFileName,
        })
        setTemplateFieldDraft(createEmptyTemplateFieldDraft())
        setTemplatePendingRect(null)
        setTemplateDrawingStart(null)
        setTemplateHoveredFieldId(null)
        setShowTemplateEditorModal(true)
      } catch (error) {
        setTemplateError(error instanceof Error ? error.message : 'No se pudo cargar el PDF de la plantilla.')
      } finally {
        setTemplateActionLoadingId(null)
      }
    },
    [tenantId],
  )

  const resetClassificationRuleEditor = useCallback(() => {
    setShowClassificationRuleModal(false)
    setClassificationRuleMandatory(false)
    setClassificationRuleLoading(false)
    setClassificationRuleSaving(false)
    setClassificationRuleTemplateId('')
    setClassificationRuleTemplateName('')
    setClassificationRuleFieldOptions([])
    setClassificationRuleNodes([])
    setClassificationRuleActiveOverlay(null)
    setClassificationRuleError('')
    setClassificationRuleSuccess('')
  }, [])

  const openClassificationRuleEditor = useCallback(
    async (templateId: string, mandatory = false) => {
      if (!templateId) {
        return
      }
      setClassificationRuleLoading(true)
      setClassificationRuleSaving(false)
      setClassificationRuleTemplateId(templateId)
      setClassificationRuleError('')
      setClassificationRuleSuccess('')
      setClassificationRuleMandatory(mandatory)
      setShowClassificationRuleModal(true)

      const [templateResponse, ruleResponse] = await Promise.all([
        getTemplate(tenantId, templateId),
        getTemplateClassificationRule(tenantId, templateId),
      ])
      setClassificationRuleLoading(false)

      if (!templateResponse.ok || !templateResponse.data) {
        setClassificationRuleError(templateResponse.error || 'No se pudo cargar la plantilla para editar la regla.')
        setClassificationRuleFieldOptions([])
        setClassificationRuleNodes([])
        return
      }

      if (resolveTemplateMode(templateResponse.data) !== 'document') {
        setClassificationRuleError('Solo las plantillas ABM de documentos admiten reglas de clasificacion.')
        setClassificationRuleFieldOptions([])
        setClassificationRuleNodes([])
        return
      }

      const fieldOptions = mapRuleFieldOptions(templateResponse.data.custom_model, templateResponse.data.field_transforms)
      setClassificationRuleTemplateName(templateResponse.data.name)
      setClassificationRuleFieldOptions(fieldOptions)

      if (!ruleResponse.ok && ruleResponse.status !== 404) {
        setClassificationRuleError(ruleResponse.error || 'No se pudo cargar la regla de clasificacion.')
        setClassificationRuleNodes(buildDefaultRuleNodes(fieldOptions))
        return
      }

      const existingRule = (ruleResponse.ok ? ruleResponse.data?.classification_rule : null) || templateResponse.data.classification_rule
      setClassificationRuleNodes(mapRuleToDraftNodes(existingRule || null, fieldOptions))
      if (ruleResponse.ok && ruleResponse.data?.rule_status === 'invalid') {
        setClassificationRuleError('La regla actual es invalida. Revisala y volve a guardarla.')
      }
    },
    [tenantId],
  )

  const addClassificationRuleFolderNode = useCallback(() => {
    setClassificationRuleNodes((prev) => {
      const folder = createRuleNodeDraft('folder', classificationRuleFieldOptions, 'use_existing')
      if (prev.length === 0) {
        return [folder, createRuleNodeDraft('file', classificationRuleFieldOptions, null)]
      }
      const next = [...prev]
      next.splice(Math.max(next.length - 1, 0), 0, folder)
      return next
    })
    setClassificationRuleError('')
    setClassificationRuleSuccess('')
  }, [classificationRuleFieldOptions])

  const removeClassificationRuleFolderNode = useCallback((nodeId: string) => {
    setClassificationRuleNodes((prev) => {
      const next = prev.filter((node) => !(node.id === nodeId && node.nodeType === 'folder'))
      const fileNode = next.find((node) => node.nodeType === 'file')
      if (!fileNode) {
        next.push(createRuleNodeDraft('file', classificationRuleFieldOptions, null))
      }
      return next
    })
    setClassificationRuleError('')
    setClassificationRuleSuccess('')
  }, [classificationRuleFieldOptions])

  const updateClassificationRuleNamePart = useCallback(
    (nodeId: string, partId: string, updater: (part: ClassificationRuleNamePartDraft) => ClassificationRuleNamePartDraft) => {
      setClassificationRuleNodes((prev) =>
        prev.map((node) => {
          if (node.id !== nodeId) {
            return node
          }
          return {
            ...node,
            nameParts: node.nameParts.map((part) => (part.id === partId ? updater(part) : part)),
          }
        }),
      )
      setClassificationRuleError('')
      setClassificationRuleSuccess('')
    },
    [],
  )

  const removeClassificationRuleNamePart = useCallback((nodeId: string, partId: string) => {
    setClassificationRuleNodes((prev) =>
      prev.map((node) => {
        if (node.id !== nodeId) {
          return node
        }
        return {
          ...node,
          nameParts: node.nameParts.filter((part) => part.id !== partId),
        }
      }),
    )
    setClassificationRuleError('')
    setClassificationRuleSuccess('')
  }, [])

  const addClassificationRulePart = useCallback(
    (nodeId: string, sourceKind: RulePaletteItemKind, sourceFieldKey = '') => {
      const fallbackField = classificationRuleFieldOptions[0]?.key || ''
      const newPart = createRulePartFromPalette(sourceKind, sourceFieldKey, fallbackField)
      setClassificationRuleNodes((prev) =>
        prev.map((node) => {
          if (node.id !== nodeId) {
            return node
          }
          return {
            ...node,
            nameParts: [...node.nameParts, newPart],
          }
        }),
      )
      setClassificationRuleError('')
      setClassificationRuleSuccess('')
    },
    [classificationRuleFieldOptions],
  )

  const updateClassificationRuleLiteralPart = useCallback((nodeId: string, partId: string, nextValue: string) => {
    setClassificationRuleNodes((prev) =>
      prev.map((node) => {
        if (node.id !== nodeId) {
          return node
        }
        return {
          ...node,
          nameParts: node.nameParts.map((part) => (part.id === partId ? { ...part, literalValue: nextValue } : part)),
        }
      }),
    )
    setClassificationRuleError('')
    setClassificationRuleSuccess('')
  }, [])

  const handleClassificationRuleDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeId = String(event.active.id)
      if (activeId.startsWith(`${RULE_DND_SOURCE_PREFIX}:`)) {
        const sourceKindRaw = event.active.data.current?.sourceKind
        const sourceKind: RulePaletteItemKind =
          sourceKindRaw === 'index' || sourceKindRaw === 'space' || sourceKindRaw === 'field' || sourceKindRaw === 'literal'
            ? sourceKindRaw
            : 'field'
        const rawLabel = typeof event.active.data.current?.label === 'string' ? event.active.data.current.label.trim() : ''
        const fallbackLabel =
          sourceKind === 'space'
            ? 'ESPACIO [ _ ]'
            : sourceKind === 'index'
              ? 'Indice'
              : sourceKind === 'literal'
                ? 'Texto'
                : 'Campo'
        setClassificationRuleActiveOverlay({
          kind: sourceKind,
          label: rawLabel || fallbackLabel,
        })
        return
      }

      const activePart = parseRulePartDndId(activeId)
      if (!activePart) {
        setClassificationRuleActiveOverlay(null)
        return
      }

      const sourceNode = classificationRuleNodes.find((node) => node.id === activePart.nodeId)
      const sourcePart = sourceNode?.nameParts.find((part) => part.id === activePart.partId)
      if (!sourcePart) {
        setClassificationRuleActiveOverlay(null)
        return
      }

      if (sourcePart.partType === 'field') {
        setClassificationRuleActiveOverlay({
          kind: 'field',
          label: resolveRuleFieldLabel(sourcePart.fieldKey, classificationRuleFieldOptions),
        })
        return
      }
      if (sourcePart.partType === 'index') {
        setClassificationRuleActiveOverlay({
          kind: 'index',
          label: `Indice ${getRuleIndexPreview(sourcePart)}`,
        })
        return
      }
      if (sourcePart.partType === 'space') {
        setClassificationRuleActiveOverlay({
          kind: 'space',
          label: 'ESPACIO [ _ ]',
        })
        return
      }
      setClassificationRuleActiveOverlay({
        kind: 'literal',
        label: sourcePart.literalValue.trim() || 'Texto',
      })
    },
    [classificationRuleFieldOptions, classificationRuleNodes],
  )

  const handleClassificationRuleDragCancel = useCallback(() => {
    setClassificationRuleActiveOverlay(null)
  }, [])

  const handleClassificationRuleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setClassificationRuleActiveOverlay(null)
      if (!over) {
        return
      }

      const activeId = String(active.id)
      const overId = String(over.id)
      const activePart = parseRulePartDndId(activeId)
      const overPart = parseRulePartDndId(overId)
      const overDrop = parseRuleDropDndId(overId)
      const targetNodeId = overPart?.nodeId || overDrop?.nodeId || null

      if (!targetNodeId) {
        return
      }

      if (activePart) {
        setClassificationRuleNodes((prev) => {
          const fromNodeId = activePart.nodeId
          const fromPartId = activePart.partId
          const toPartId = overPart?.partId || null

          if (fromNodeId === targetNodeId) {
            return prev.map((node) => {
              if (node.id !== fromNodeId) {
                return node
              }
              const oldIndex = node.nameParts.findIndex((part) => part.id === fromPartId)
              if (oldIndex < 0) {
                return node
              }
              if (!toPartId) {
                const destination = node.nameParts.length - 1
                if (destination === oldIndex) {
                  return node
                }
                return {
                  ...node,
                  nameParts: arrayMove(node.nameParts, oldIndex, destination),
                }
              }
              const newIndex = node.nameParts.findIndex((part) => part.id === toPartId)
              if (newIndex < 0 || newIndex === oldIndex) {
                return node
              }
              return {
                ...node,
                nameParts: arrayMove(node.nameParts, oldIndex, newIndex),
              }
            })
          }

          let movingPart: ClassificationRuleNamePartDraft | null = null
          const withoutSource = prev.map((node) => {
            if (node.id !== fromNodeId) {
              return node
            }
            const filtered = node.nameParts.filter((part) => {
              if (part.id === fromPartId) {
                movingPart = part
                return false
              }
              return true
            })
            return {
              ...node,
              nameParts: filtered,
            }
          })

          if (!movingPart) {
            return prev
          }

          return withoutSource.map((node) => {
            if (node.id !== targetNodeId) {
              return node
            }
            const nextParts = [...node.nameParts]
            if (toPartId) {
              const insertIndex = nextParts.findIndex((part) => part.id === toPartId)
              if (insertIndex >= 0) {
                nextParts.splice(insertIndex, 0, movingPart as ClassificationRuleNamePartDraft)
              } else {
                nextParts.push(movingPart as ClassificationRuleNamePartDraft)
              }
            } else {
              nextParts.push(movingPart as ClassificationRuleNamePartDraft)
            }
            return {
              ...node,
              nameParts: nextParts,
            }
          })
        })
        setClassificationRuleError('')
        setClassificationRuleSuccess('')
        return
      }

      if (!activeId.startsWith(`${RULE_DND_SOURCE_PREFIX}:`)) {
        return
      }

      const sourceKindRaw = active.data.current?.sourceKind
      const sourceKind: RulePaletteItemKind =
        sourceKindRaw === 'index' || sourceKindRaw === 'space' || sourceKindRaw === 'field' || sourceKindRaw === 'literal'
          ? sourceKindRaw
          : 'field'
      const fieldKey = typeof active.data.current?.fieldKey === 'string' ? active.data.current.fieldKey : ''
      const fallbackField = classificationRuleFieldOptions[0]?.key || ''
      const newPart = createRulePartFromPalette(sourceKind, fieldKey, fallbackField)

      setClassificationRuleNodes((prev) =>
        prev.map((node) => {
          if (node.id !== targetNodeId) {
            return node
          }
          const nextParts = [...node.nameParts]
          if (overPart?.partId) {
            const insertIndex = nextParts.findIndex((part) => part.id === overPart.partId)
            if (insertIndex >= 0) {
              nextParts.splice(insertIndex, 0, newPart)
            } else {
              nextParts.push(newPart)
            }
          } else {
            nextParts.push(newPart)
          }
          return {
            ...node,
            nameParts: nextParts,
          }
        }),
      )
      setClassificationRuleError('')
      setClassificationRuleSuccess('')
    },
    [classificationRuleFieldOptions],
  )

  const closeClassificationRuleEditor = useCallback(() => {
    if (classificationRuleMandatory) {
      setTemplateSuccess('La plantilla quedó guardada pero no podra usarse en Procesar hasta completar su regla.')
    }
    resetClassificationRuleEditor()
  }, [classificationRuleMandatory, resetClassificationRuleEditor])

  const saveClassificationRuleEditor = useCallback(async () => {
    const templateId = classificationRuleTemplateId.trim()
    if (!templateId) {
      setClassificationRuleError('No se pudo resolver la plantilla de la regla.')
      return
    }

    if (classificationRuleNodes.length === 0) {
      setClassificationRuleError('Agrega al menos un nodo de carpeta y un nodo de archivo.')
      return
    }

    if (classificationRuleNodes.some((node) => node.nameParts.length === 0)) {
      setClassificationRuleError('Hay niveles sin configurar.')
      const exitWithoutSaving = window.confirm(
        'Hay niveles sin configurar.\n\nAceptar: salir sin guardar cambios.\nCancelar: continuar editando.',
      )
      if (exitWithoutSaving) {
        closeClassificationRuleEditor()
      }
      return
    }

    for (let nodeIndex = 0; nodeIndex < classificationRuleNodes.length; nodeIndex += 1) {
      const node = classificationRuleNodes[nodeIndex]
      const shouldBeFolder = nodeIndex < classificationRuleNodes.length - 1
      if (shouldBeFolder && node.nodeType !== 'folder') {
        setClassificationRuleError('Todos los nodos intermedios deben ser carpetas.')
        return
      }
      if (!shouldBeFolder && node.nodeType !== 'file') {
        setClassificationRuleError('El ultimo nodo debe ser un archivo.')
        return
      }
      for (const part of node.nameParts) {
        if (part.partType === 'field') {
          if (!part.fieldKey.trim()) {
            setClassificationRuleError('Todos los chips de campo deben seleccionar un campo.')
            return
          }
        } else if (part.partType === 'index') {
          if (part.indexDirection === 'decremental') {
            if (part.indexKind === 'numeric') {
              const numericStart = Number.parseInt(part.indexStartNumeric, 10)
              if (!Number.isFinite(numericStart) || numericStart < 0 || numericStart > 9999) {
                setClassificationRuleError('En indice decremental numerico, el inicio debe estar entre 0 y 9999.')
                return
              }
            } else {
              const alphaStart = part.indexStartAlpha.trim().toUpperCase()
              if (!/^[A-Z]$/.test(alphaStart)) {
                setClassificationRuleError('En indice decremental alfabetico, el inicio debe ser una letra entre A y Z.')
                return
              }
            }
          }
        } else if (part.partType === 'literal') {
          const literal = part.literalValue.trim()
          if (!literal) {
            setClassificationRuleError('Las partes literales no pueden estar vacias.')
            return
          }
          if (!/^[a-z0-9 #$%&/()@._,-]+$/i.test(literal)) {
            setClassificationRuleError('Los literales admiten alfanumericos, espacios y #$%&/()@._,-.')
            return
          }
        }
      }
    }

    setClassificationRuleSaving(true)
    setClassificationRuleError('')
    setClassificationRuleSuccess('')
    const payload: ClassificationRulePayload = buildClassificationRulePayload(classificationRuleNodes)
    const response = await putTemplateClassificationRule(tenantId, templateId, payload)
    setClassificationRuleSaving(false)
    if (!response.ok || !response.data) {
      setClassificationRuleError(response.error || 'No se pudo guardar la regla de clasificacion.')
      return
    }

    setClassificationRuleSuccess('Regla de clasificacion guardada.')
    await loadTemplatesForTenant(true)
    resetClassificationRuleEditor()
  }, [classificationRuleNodes, classificationRuleTemplateId, closeClassificationRuleEditor, loadTemplatesForTenant, resetClassificationRuleEditor, tenantId])

  const saveTemplateEditor = useCallback(async () => {
    if (!templateEditor.name.trim()) {
      setTemplateError('El nombre de la plantilla es obligatorio.')
      return
    }
    if (!templateEditor.sourcePdfBlob) {
      setTemplateError('Selecciona un PDF base para la plantilla.')
      return
    }
    if (templateEditor.fields.length === 0) {
      setTemplateError('Agrega al menos un campo dibujando zonas en el PDF.')
      return
    }
    setTemplateSaving(true)
    setTemplateError('')
    setTemplateSuccess('')
    const isNewTemplate = !editingTemplateId

    const mappedFields: DocumentTemplateField[] = templateEditor.fields.map((field) => ({
      id: field.id,
      key: field.key,
      name: field.name,
      label: field.label,
      suggested_label: field.suggestedLabel,
      type: field.type,
      rect: field.rect,
      detected_value: field.detectedValue,
      sample_value: field.sampleValue,
      required: field.required,
    }))

    const fieldTransforms = serializeTemplateFieldTransforms(templateEditor.fields)

    const payload = {
      name: templateEditor.name.trim(),
      description: templateEditor.description.trim() || null,
      is_active: templateEditor.isActive,
      original_model: {
        schema_version: '2',
        sample: {
          file_id: templateEditor.sampleFileId || null,
          file_name: templateEditor.sampleFileName || `${templateEditor.name.trim()}.pdf`,
        },
        page_size: templateEditor.pageSize,
        fields: [],
      },
      custom_model: {
        mode: 'document' as const,
        fields: mappedFields,
      },
      sample_file_metadata: {
        file_id: templateEditor.sampleFileId || null,
        file_name: templateEditor.sampleFileName || `${templateEditor.name.trim()}.pdf`,
        source_kind: templateEditor.sampleFileId ? 'drive' : 'upload',
      },
      field_transforms: fieldTransforms,
    }
    const response = editingTemplateId
      ? await updateTemplate(tenantId, editingTemplateId, payload)
      : await createTemplate(tenantId, payload)
    if (!response.ok || !response.data) {
      setTemplateSaving(false)
      setTemplateError(response.error || 'No se pudo guardar la plantilla.')
      return
    }

    const uploadResponse = await uploadTemplateSourcePdf(
      tenantId,
      response.data.template_id,
      templateEditor.sourcePdfBlob,
      templateEditor.sampleFileName || `${templateEditor.name.trim()}.pdf`,
    )
    setTemplateSaving(false)
    if (!uploadResponse.ok) {
      setTemplateError(uploadResponse.error || 'La plantilla se guardó pero no se pudo asociar el PDF fuente.')
      await loadTemplatesForTenant(true)
      return
    }

    setTemplateSuccess('Plantilla guardada.')
    await loadTemplatesForTenant(true)
    setShowTemplateEditorModal(false)
    setEditingTemplateId(null)
    setTemplateEditor(createEmptyTemplateEditor())
    setTemplateFieldDraft(createEmptyTemplateFieldDraft())
    setTemplatePendingRect(null)
    setTemplateDrawingStart(null)
    setSelectedDraftFileId('')
    setUploadedTemplateFile(null)
    if (isNewTemplate) {
      await openClassificationRuleEditor(response.data.template_id, true)
    }
  }, [editingTemplateId, loadTemplatesForTenant, openClassificationRuleEditor, templateEditor, tenantId])

  const removeTemplate = useCallback(
    async (templateId: string) => {
      setTemplateActionLoadingId(templateId)
      setTemplateError('')
      setTemplateSuccess('')
      const response = await deleteTemplate(tenantId, templateId)
      setTemplateActionLoadingId(null)
      if (!response.ok) {
        setTemplateError(response.error || 'No se pudo eliminar la plantilla.')
        return
      }
      if (editingTemplateId === templateId) {
        resetTemplateEditor()
      }
      if (selectedTemplateId === templateId) {
        setSelectedTemplateId('')
      }
      setTemplateSuccess('Plantilla eliminada.')
      await loadTemplatesForTenant(true)
    },
    [editingTemplateId, loadTemplatesForTenant, resetTemplateEditor, selectedTemplateId, tenantId],
  )

  const addTemplateFieldTransformStep = useCallback((fieldId: string) => {
    setTemplateEditor((prev) => ({
      ...prev,
      fields: prev.fields.map((field) => {
        if (field.id !== fieldId) {
          return field
        }
        if (field.transforms.length >= 3) {
          return field
        }
        return {
          ...field,
          transforms: [...field.transforms, createTransformStepDraft('trim')],
        }
      }),
    }))
    setTemplateError('')
    setTemplateSuccess('')
  }, [])

  const updateTemplateFieldTransformStep = useCallback(
    (
      fieldId: string,
      stepId: string,
      updater: (step: TemplateFieldTransformStepDraft) => TemplateFieldTransformStepDraft,
    ) => {
      setTemplateEditor((prev) => ({
        ...prev,
        fields: prev.fields.map((field) => {
          if (field.id !== fieldId) {
            return field
          }
          return {
            ...field,
            transforms: field.transforms.map((step) => (step.id === stepId ? updater(step) : step)),
          }
        }),
      }))
      setTemplateError('')
      setTemplateSuccess('')
    },
    [],
  )

  const removeTemplateFieldTransformStep = useCallback((fieldId: string, stepId: string) => {
    setTemplateEditor((prev) => ({
      ...prev,
      fields: prev.fields.map((field) => {
        if (field.id !== fieldId) {
          return field
        }
        return {
          ...field,
          transforms: field.transforms.filter((step) => step.id !== stepId),
        }
      }),
    }))
    setTemplateError('')
    setTemplateSuccess('')
  }, [])

  const addFieldToTemplate = useCallback(() => {
    if (!templatePendingRect) {
      setTemplateError('Dibuja una zona sobre el PDF antes de agregar el campo.')
      return
    }
    const fieldName = templateFieldDraft.name.trim()
    if (!fieldName) {
      setTemplateError('El campo es obligatorio.')
      return
    }

    setTemplateEditor((prev) => ({
      ...prev,
      fields: [
        ...prev.fields,
        {
          id: randomId(),
          key: sanitizeFieldKey(fieldName, `field_${prev.fields.length + 1}`),
          name: fieldName,
          label: templateFieldDraft.label.trim() || null,
          suggestedLabel: templateFieldDraft.suggestedLabel.trim() || null,
          type: templateFieldDraft.type,
          rect: templatePendingRect,
          detectedValue: templateFieldDraft.detectedValue.trim() || null,
          sampleValue: templateFieldDraft.detectedValue.trim() || null,
          required: templateFieldDraft.required,
          transforms: [],
        },
      ],
    }))
    setTemplateFieldDraft(createEmptyTemplateFieldDraft())
    setTemplatePendingRect(null)
    setTemplateError('')
    setTemplateSuccess('')
  }, [templateFieldDraft, templatePendingRect])

  const removeTemplateFieldFromEditor = useCallback((fieldId: string) => {
    setTemplateEditor((prev) => ({
      ...prev,
      fields: prev.fields.filter((field) => field.id !== fieldId),
    }))
    setTemplateError('')
    setTemplateSuccess('')
  }, [])

  const toCanvasRelativePoint = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: clampUnit((event.clientX - bounds.left) / Math.max(bounds.width, 1)),
      y: clampUnit((event.clientY - bounds.top) / Math.max(bounds.height, 1)),
    }
  }, [])

  const finalizePendingRect = useCallback(
    (nextRect: TemplateRect | null) => {
      if (!nextRect || nextRect.w < 0.004 || nextRect.h < 0.004) {
        setTemplatePendingRect(null)
        setTemplateFieldDraft(createEmptyTemplateFieldDraft())
        return
      }
      const detected = detectTextByRect(templateEditor.textTokens, nextRect)
      const suggested = suggestLabelByRect(templateEditor.textTokens, nextRect)
      setTemplatePendingRect(nextRect)
      setTemplateFieldDraft({
        name: suggested || '',
        label: '',
        type: 'string',
        detectedValue: detected,
        suggestedLabel: suggested,
        required: false,
      })
      setTemplateError('')
    },
    [templateEditor.textTokens],
  )

  const startTemplateDrawing = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!templateEditor.previewImageDataUrl) {
        return
      }
      const point = toCanvasRelativePoint(event)
      setTemplateDrawingStart(point)
      setTemplatePendingRect({
        page: 1,
        x: point.x,
        y: point.y,
        w: 0,
        h: 0,
      })
    },
    [templateEditor.previewImageDataUrl, toCanvasRelativePoint],
  )

  const moveTemplateDrawing = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!templateDrawingStart) {
        return
      }
      const point = toCanvasRelativePoint(event)
      setTemplatePendingRect(normalizeRect(templateDrawingStart, point))
    },
    [templateDrawingStart, toCanvasRelativePoint],
  )

  const endTemplateDrawing = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!templateDrawingStart) {
        return
      }
      const point = toCanvasRelativePoint(event)
      const rect = normalizeRect(templateDrawingStart, point)
      setTemplateDrawingStart(null)
      finalizePendingRect(rect)
    },
    [finalizePendingRect, templateDrawingStart, toCanvasRelativePoint],
  )

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
        const oauthTenantId = normalizeTenantId(event.data.tenant_id)
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
    const nextTenantId = normalizeTenantId(tenantId || window.localStorage.getItem(tenantStorageKey) || defaultTenant) || defaultTenant
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

  async function logoutCurrentSession() {
    try {
      await signOutFirebaseUser()
    } catch (error) {
      setOauthFeedback({
        type: 'error',
        text: error instanceof Error ? error.message : 'No se pudo cerrar sesión.',
      })
    } finally {
      setShowProfilePopover(false)
    }
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
    setShowProcessModeModal(false)
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
        void loadTemplatesForTenant(false)
      }
      if (section === 'nomina') {
        void loadNominaEmployees()
      }
      if (section === 'configuracion') {
        void loadProcessingPreferences()
        void loadPendingFiles()
        void loadTemplatesForTenant(true)
      }
    },
    [isConnected, loadNominaEmployees, loadPendingFiles, loadProcessingPreferences, loadTemplatesForTenant, refreshPendingFiles],
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
    const documentActiveTemplates = templates.filter(
      (template) => template.is_active && resolveTemplateMode(template) === 'document',
    )
    const readyTemplates = documentActiveTemplates.filter((template) => template.rule_status === 'ready')
    if (documentActiveTemplates.length === 0) {
      if (processingMode === 'template') {
        setSelectedTemplateId('')
      }
      return
    }
    if (selectedTemplateId && readyTemplates.some((template) => template.template_id === selectedTemplateId)) {
      return
    }
    if (processingMode === 'template') {
      setSelectedTemplateId(readyTemplates[0]?.template_id || '')
    }
  }, [processingMode, selectedTemplateId, templates])

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

  function changeProcessingMode(nextMode: ProcessingMode) {
    setProcessingMode(nextMode)
    setProcessError('')
    if (nextMode === 'default') {
      setSelectedTemplateId('')
      return
    }
    setSelectedTemplateId((currentTemplateId) => {
      if (currentTemplateId && readyProcessTemplates.some((template) => template.template_id === currentTemplateId)) {
        return currentTemplateId
      }
      return readyProcessTemplates[0]?.template_id || ''
    })
  }

  function openProcessModeSelector() {
    if (!isConnected) {
      setShowConnectRequiredModal(true)
      return
    }
    if (
      processingMode === 'template' &&
      (!selectedTemplateId || !readyProcessTemplates.some((template) => template.template_id === selectedTemplateId))
    ) {
      setSelectedTemplateId(readyProcessTemplates[0]?.template_id || '')
    }
    setProcessError('')
    setShowProcessModeModal(true)
  }

  async function triggerProcess() {
    if (!isConnected) {
      setShowConnectRequiredModal(true)
      setShowProcessModeModal(false)
      return
    }

    if (processingMode === 'template' && !selectedTemplateId) {
      setProcessError('Selecciona una plantilla con regla lista para procesar.')
      return
    }
    if (
      processingMode === 'template' &&
      !readyProcessTemplates.some((template) => template.template_id === selectedTemplateId)
    ) {
      setProcessError('La plantilla seleccionada no tiene una regla de clasificacion valida.')
      return
    }

    setProcessError('')
    const response = await ingestDrive(tenantId, {
      processing_mode: processingMode,
      template_id: processingMode === 'template' ? selectedTemplateId : null,
    })

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
      name:
        processingMode === 'template'
          ? `Proceso plantilla ${new Date(now).toLocaleString()}`
          : `Proceso ${new Date(now).toLocaleString()}`,
      state: 'running',
      detail: null,
      createdAt: now,
    }

    setProcessItems((prev) => [item, ...prev])
    setShowProcessModeModal(false)
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
  const processTemplates = useMemo(
    () => templates.filter((template) => template.is_active && resolveTemplateMode(template) === 'document'),
    [templates],
  )
  const readyProcessTemplates = useMemo(
    () => processTemplates.filter((template) => template.rule_status === 'ready'),
    [processTemplates],
  )
  const documentTemplates = useMemo(
    () => templates.filter((template) => resolveTemplateMode(template) === 'document'),
    [templates],
  )
  const classificationRulePathPreview = useMemo(
    () => buildRulePathPreview(classificationRuleNodes, classificationRuleFieldOptions),
    [classificationRuleNodes, classificationRuleFieldOptions],
  )
  const classificationRuleTemplateLabel = useMemo(
    () => classificationRuleTemplateName.trim() || 'N/D',
    [classificationRuleTemplateName],
  )
  const classificationRuleDndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
  )
  const classificationRulePaletteItems = useMemo<RulePaletteItem[]>(
    () => [
      ...classificationRuleFieldOptions.map((field) => {
        const normalized = field.label.toLowerCase()
        const icon: LucideIcon =
          normalized.includes('fecha') || normalized.includes('mes') || normalized.includes('año')
            ? CalendarDays
            : normalized.includes('nombre')
              ? Type
              : Tags
        return {
          id: `field:${field.key}`,
          label: field.label,
          kind: 'field' as const,
          fieldKey: field.key,
          icon,
        }
      }),
      {
        id: 'space',
        label: 'ESPACIO [ _ ]',
        kind: 'space' as const,
        icon: Type,
        highlighted: true,
      },
      {
        id: 'index',
        label: 'Indice',
        kind: 'index' as const,
        icon: ListOrdered,
      },
      {
        id: 'literal',
        label: 'Texto',
        kind: 'literal' as const,
        icon: Type,
      },
    ],
    [classificationRuleFieldOptions],
  )
  const folderRuleNodes = useMemo(
    () => classificationRuleNodes.filter((node) => node.nodeType === 'folder'),
    [classificationRuleNodes],
  )
  const createIfMissingEnabled = useMemo(
    () => folderRuleNodes.length > 0 && folderRuleNodes.every((node) => node.conflictPolicy === 'create_new'),
    [folderRuleNodes],
  )
  const firstIndexEditorTarget = useMemo(() => {
    for (const node of classificationRuleNodes) {
      const found = node.nameParts.find((part) => part.partType === 'index')
      if (found) {
        return { nodeId: node.id, part: found }
      }
    }
    return null
  }, [classificationRuleNodes])
  const visibleEmployees = useMemo(() => {
    const query = normalizeSearchText(collaboratorSearch)
    const filtered = employees.filter((employee) => normalizeSearchText(employee.name).includes(query))
    return [...filtered].sort((a, b) => {
      const cmp = compareEmployeeFolders(a, b)
      return collaboratorSort === 'asc' ? cmp : -cmp
    })
  }, [employees, collaboratorSearch, collaboratorSort])
  const topbarUserName = (authEmail?.split('@')[0] || 'Admin User').trim() || 'Admin User'
  const connectedEmail = (authEmail || 'Cuenta conectada').trim() || 'Cuenta conectada'

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <img className="brand-icon" src="/assets/branding/logo512.svg" alt="RECIBOX" />
          <span className="brand-text">RECIBOX</span>
          {environmentChip && <span className={`env-chip env-chip-${environmentChip.tone}`}>{environmentChip.label.toUpperCase()}</span>}
        </div>
        <div className="topbar-right">
          <button
            type="button"
            className="topbar-menu-btn"
            aria-label="Abrir menu"
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen(true)}
          >
            <span translate="no" className="material-symbols-outlined notranslate" aria-hidden="true">
              menu
            </span>
          </button>
          <button type="button" className="topbar-icon-btn" aria-label="Notificaciones">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 1 0-14 0v5l-2 2v1h18v-1l-2-2Z" />
            </svg>
          </button>
          <span className="topbar-divider" aria-hidden="true"></span>
          <div className="topbar-user-text">
            <p>{topbarUserName}</p>
            <span>Administrador</span>
          </div>
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
                  <span>Email</span>
                  <strong>{authEmail || 'N/D'}</strong>
                </p>
                <p className="profile-popover-line">
                  <span>Tenant</span>
                  <strong>{tenantId}</strong>
                </p>
                <p className="profile-popover-line">
                  <span>Estado</span>
                  <strong>{isConnected ? 'Conectado' : 'Sin conectar'}</strong>
                </p>
                <button type="button" className="profile-logout-btn" onClick={() => void logoutCurrentSession()}>
                  Cerrar sesion
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div
        className={`mobile-menu-overlay ${mobileMenuOpen ? 'open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Menu principal"
        onClick={() => setMobileMenuOpen(false)}
      >
        <div className="mobile-menu-panel" onClick={(event) => event.stopPropagation()}>
          <div className="mobile-menu-header">
            <div className="brand-wrap">
              <img className="brand-icon" src="/assets/branding/logo512.svg" alt="RECIBOX" />
              <span className="brand-text">RECIBOX</span>
            </div>
            <button type="button" className="mobile-menu-close" aria-label="Cerrar menu" onClick={() => setMobileMenuOpen(false)}>
              <span translate="no" className="material-symbols-outlined notranslate" aria-hidden="true">
                close
              </span>
            </button>
          </div>
          <nav className="mobile-menu-nav">
            <button
              type="button"
              className={`menu-item ${activeSection === 'cuenta' ? 'active' : ''}`}
              onClick={() => {
                handleSectionChange('cuenta')
                setMobileMenuOpen(false)
              }}
            >
              <span className="menu-item-inner">
                <span className="menu-glyph" aria-hidden="true">
                  <span translate="no" className="material-symbols-outlined notranslate">grid_view</span>
                </span>
                <span>Cuentas</span>
              </span>
            </button>
            <button
              type="button"
              className={`menu-item ${activeSection === 'nomina' ? 'active' : ''}`}
              onClick={() => {
                handleSectionChange('nomina')
                setMobileMenuOpen(false)
              }}
            >
              <span className="menu-item-inner">
                <span className="menu-glyph" aria-hidden="true">
                  <span translate="no" className="material-symbols-outlined notranslate">group</span>
                </span>
                <span>Colaboradores</span>
              </span>
            </button>
            <button
              type="button"
              className={`menu-item ${activeSection === 'procesar' ? 'active' : ''}`}
              onClick={() => {
                handleSectionChange('procesar')
                setMobileMenuOpen(false)
              }}
            >
              <span className="menu-item-inner">
                <span className="menu-glyph" aria-hidden="true">
                  <span translate="no" className="material-symbols-outlined notranslate">sync</span>
                </span>
                <span>Procesar</span>
              </span>
            </button>
            <button type="button" className="menu-item menu-item-disabled">
              <span className="menu-item-inner">
                <span className="menu-glyph" aria-hidden="true">
                  <span translate="no" className="material-symbols-outlined notranslate">assessment</span>
                </span>
                <span>Reportes</span>
              </span>
            </button>
            <button
              type="button"
              className={`menu-item ${activeSection === 'configuracion' ? 'active' : ''}`}
              onClick={() => {
                handleSectionChange('configuracion')
                setMobileMenuOpen(false)
              }}
            >
              <span className="menu-item-inner">
                <span className="menu-glyph" aria-hidden="true">
                  <span translate="no" className="material-symbols-outlined notranslate">settings</span>
                </span>
                <span>Configuracion</span>
              </span>
            </button>
          </nav>
          <div className="mobile-menu-footer">
            <div className="mobile-user">
              <div className="mobile-user-avatar">
                <span translate="no" className="material-symbols-outlined notranslate" aria-hidden="true">
                  person
                </span>
              </div>
              <div className="mobile-user-text">
                <p>{topbarUserName}</p>
                <span>Administrador</span>
              </div>
            </div>
            <button type="button" className="profile-logout-btn" onClick={() => void logoutCurrentSession()}>
              Cerrar sesion
            </button>
          </div>
        </div>
      </div>

      <div className="body-layout">
        <aside className="sidebar">
          <nav className="menu">
            <button
              type="button"
              className={`menu-item ${activeSection === 'cuenta' ? 'active' : ''}`}
              onClick={() => handleSectionChange('cuenta')}
            >
              <span className="menu-item-inner">
                <span className="menu-glyph" aria-hidden="true">
                  <span translate="no" className="material-symbols-outlined notranslate">grid_view</span>
                </span>
                <span>Cuentas</span>
              </span>
            </button>
            <button
              type="button"
              className={`menu-item ${activeSection === 'nomina' ? 'active' : ''}`}
              onClick={() => handleSectionChange('nomina')}
            >
              <span className="menu-item-inner">
                <span className="menu-glyph" aria-hidden="true">
                  <span translate="no" className="material-symbols-outlined notranslate">group</span>
                </span>
                <span>Colaboradores</span>
              </span>
            </button>
            <button
              type="button"
              className={`menu-item ${activeSection === 'procesar' ? 'active' : ''}`}
              onClick={() => handleSectionChange('procesar')}
            >
              <span className="menu-item-inner">
                <span className="menu-glyph" aria-hidden="true">
                  <span translate="no" className="material-symbols-outlined notranslate">sync</span>
                </span>
                <span>Procesar</span>
              </span>
            </button>
            <button
              type="button"
              className="menu-item menu-item-disabled"
              disabled
            >
              <span className="menu-item-inner">
                <span className="menu-glyph" aria-hidden="true">
                  <span translate="no" className="material-symbols-outlined notranslate">analytics</span>
                </span>
                <span>Reportes</span>
              </span>
            </button>
            <button
              type="button"
              className={`menu-item ${activeSection === 'configuracion' ? 'active' : ''}`}
              onClick={() => handleSectionChange('configuracion')}
            >
              <span className="menu-item-inner">
                <span className="menu-glyph" aria-hidden="true">
                  <span translate="no" className="material-symbols-outlined notranslate">settings</span>
                </span>
                <span>Configuracion</span>
              </span>
            </button>
          </nav>
          <div className="sidebar-plan-card">
            <p className="sidebar-plan-label">Plan actual</p>
            <p className="sidebar-plan-name">Empresarial Pro</p>
            <div className="sidebar-plan-meter">
              <span />
            </div>
            <p className="sidebar-plan-usage">75% del almacenamiento</p>
          </div>
        </aside>

        {activeSection === 'cuenta' && (
          <main className={`content ${isConnected ? 'connected-mode' : ''}`}>
            {initialLoading ? (
              <>
                <section className="accounts-header" aria-label="Encabezado de cuentas">
                  <h2>Cuentas de Almacenamiento</h2>
                  <p>Gestiona tus conexiones de Google Drive y configura las rutas de sincronizacion.</p>
                </section>
                <section className="accounts-panel" aria-label="Cargando estado OAuth">
                  <div className="account-card-stack">
                    <article className="account-row">
                      <div className="account-row-main">
                        <div className="account-avatar">
                          <img className="drive-mini" src="/assets/branding/google_drive.svg" alt="Google Drive" />
                        </div>
                        <div className="account-meta">
                          <h3>{connectedEmail}</h3>
                          <p>Mi Drive / RECIBOX</p>
                        </div>
                      </div>
                      <div className="account-actions">
                        <button type="button" className="open-storage-btn" disabled>
                          Abrir carpeta
                        </button>
                        <button type="button" className="disconnect-btn" disabled>
                          Desconectar
                        </button>
                      </div>
                    </article>
                    <div className="account-row-overlay account-row-overlay-soft" aria-live="polite">
                      <div className="account-row-overlay-avatar">
                        <img className="drive-mini" src="/assets/branding/google_drive.svg" alt="" />
                        <span className="account-row-overlay-spinner" aria-hidden="true" />
                      </div>
                      <p>Verificando conexion de la cuenta...</p>
                    </div>
                  </div>
                </section>
              </>
            ) : isConnected ? (
              <>
                <section className="accounts-header" aria-label="Encabezado de cuentas">
                  <h2>Cuentas de Almacenamiento</h2>
                  <p>Gestiona tus conexiones de Google Drive y configura las rutas de sincronizacion.</p>
                </section>
                <section className="accounts-panel" aria-label="Cuentas conectadas">
                  <div className="account-card-stack">
                    <article className="account-row" aria-label="Cuenta conectada de Google Drive">
                      <div className="account-row-main">
                        <div className="account-avatar">
                          <img className="drive-mini" src="/assets/branding/google_drive.svg" alt="Google Drive" />
                        </div>
                        <div className="account-meta">
                          <h3>{connectedEmail}</h3>
                          <p>Mi Drive / RECIBOX</p>
                        </div>
                      </div>
                      <div className="account-actions">
                        <button
                          type="button"
                          className="open-storage-btn"
                          disabled={!storageInfo?.reciboxFolderId}
                          onClick={() => {
                            if (storageInfo?.reciboxFolderId) {
                              window.open(`https://drive.google.com/drive/folders/${storageInfo.reciboxFolderId}`, '_blank')
                            }
                          }}
                        >
                          <span translate="no" className="material-symbols-outlined notranslate account-action-symbol" aria-hidden="true">
                            open_in_new
                          </span>
                          Abrir carpeta
                        </button>
                        <button type="button" className="disconnect-btn" onClick={disconnectGoogleDrive} disabled={actionLoading}>
                          {!actionLoading && (
                            <span translate="no" className="material-symbols-outlined notranslate account-action-symbol" aria-hidden="true">
                              logout
                            </span>
                          )}
                          {actionLoading ? 'Desconectando...' : 'Desconectar'}
                        </button>
                      </div>
                    </article>
                    {actionLoading && (
                      <div className="account-row-overlay" aria-live="polite">
                        <div className="account-row-overlay-avatar">
                          <img className="drive-mini" src="/assets/branding/google_drive.svg" alt="" />
                          <span className="account-row-overlay-spinner" aria-hidden="true" />
                        </div>
                        <p>Actualizando conexion...</p>
                      </div>
                    )}
                  </div>
                  <button type="button" className="add-connection-row" disabled>
                    <span className="add-connection-circle">+</span>
                    <span>Anadir nueva conexion de Google Drive</span>
                  </button>
                </section>
                <section className="accounts-help-card" aria-label="Ayuda para rutas">
                  <div className="accounts-help-left">
                    <div className="accounts-help-icon">i</div>
                    <div>
                      <p className="accounts-help-title">¿Necesitas ayuda con las rutas?</p>
                      <p className="accounts-help-text">Consulta nuestra guia sobre como organizar tus carpetas de Drive.</p>
                    </div>
                  </div>
                  <button type="button" className="accounts-help-link" onClick={() => setShowTutorialModal(true)}>
                    Ver tutorial
                  </button>
                </section>
                {storageLoading && <p className="oauth-feedback">Verificando estructura de almacenamiento...</p>}
                {!storageLoading && storageError && <p className="oauth-feedback error">{storageError}</p>}
              </>
            ) : (
              <section className="main-card" aria-label="Conectar Google Drive">
                <h1>Para iniciar</h1>
                <h2 className="connect-title">Conectá tu cuenta de Google Drive</h2>

                <div className="logos-row">
                  <img className="recibox-large" src="/assets/branding/logo512.svg" alt="Recibox" />
                  <span className="arrow">→</span>
                  <img className="drive-large" src="/assets/branding/google-drive.svg" alt="Google Drive" />
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
            <section className="section-page-header" aria-label="Encabezado de procesar">
              <h2>Procesar documentos</h2>
              <p>Gestiona archivos pendientes, ejecuta procesos y revisa resultados.</p>
            </section>
            <div className="process-stack">
              <div className="process-summary">
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
              </div>

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
                    onClick={openProcessModeSelector}
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
            <section className="section-page-header" aria-label="Encabezado de configuracion">
              <h2>Configuracion</h2>
              <p>Administra preferencias de procesamiento y automatizacion.</p>
            </section>
            <div className="process-layout settings-layout">
              <div className="settings-cards-grid">
                <section className="pending-card settings-card settings-card-half" aria-label="Configuración de preferencias">
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

                <section className="pending-card settings-card settings-card-half" aria-label="Reglas de automatizacion">
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

                <section className="pending-card settings-card settings-card-full" aria-label="ABM de plantillas de documentos">
                  <div className="settings-body">
                    <div className="settings-card-header">
                      <h4>Plantillas de documentos</h4>
                      <span className="settings-chip">ABM</span>
                    </div>
                    <p className="settings-preview">
                      Definí plantillas para detectar zonas de un PDF y guardar campos reutilizables. Cada plantilla
                      permite dibujar áreas, validar el valor detectado y asignar un campo editable.
                    </p>
                    <p className="settings-preview">
                      Podés crear la plantilla desde un PDF de <strong>INPUT</strong>.
                    </p>
                    <div className="settings-field">
                      <label htmlFor="template-source-file">Archivo de ejemplo</label>
                      <select
                        id="template-source-file"
                        className="year-select"
                        value={selectedDraftFileId}
                        onChange={(event) => {
                          setSelectedDraftFileId(event.target.value)
                          if (event.target.value) {
                            setUploadedTemplateFile(null)
                            if (templateUploadInputRef.current) {
                              templateUploadInputRef.current.value = ''
                            }
                          }
                          setTemplateError('')
                          setTemplateSuccess('')
                        }}
                        disabled={templateDraftLoading || templatesLoading}
                      >
                        <option value="">Seleccionar PDF de INPUT</option>
                        {pendingFiles.map((file) => (
                          <option key={file.id} value={file.id}>
                            {file.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    {templateLocalUploadEnabled && (
                      <div className="settings-field">
                        <label htmlFor="template-source-local-file">Subir archivo modelo (PDF)</label>
                        <input
                          id="template-source-local-file"
                          ref={templateUploadInputRef}
                          className="settings-input"
                          type="file"
                          accept="application/pdf,.pdf"
                          onChange={(event) => {
                            const file = event.target.files && event.target.files.length > 0 ? event.target.files[0] : null
                            setUploadedTemplateFile(file)
                            if (file) {
                              setSelectedDraftFileId('')
                            }
                            setTemplateError('')
                            setTemplateSuccess('')
                          }}
                          disabled={templateDraftLoading}
                        />
                        {uploadedTemplateFile && <p className="settings-preview">Archivo local: {uploadedTemplateFile.name}</p>}
                      </div>
                    )}
                    <div className="settings-actions">
                      <button
                        type="button"
                        className="modal-primary"
                        onClick={() => void createTemplateDraft()}
                        disabled={(!selectedDraftFileId && (!templateLocalUploadEnabled || !uploadedTemplateFile)) || templateDraftLoading}
                      >
                        {templateDraftLoading ? 'Cargando PDF...' : 'Crear plantilla'}
                      </button>
                      <button
                        type="button"
                        className="modal-secondary"
                        onClick={() => {
                          setSelectedDraftFileId('')
                          setUploadedTemplateFile(null)
                          if (templateUploadInputRef.current) {
                            templateUploadInputRef.current.value = ''
                          }
                          setTemplateError('')
                          setTemplateSuccess('')
                        }}
                        disabled={templateSaving}
                      >
                        Limpiar
                      </button>
                    </div>
                    <hr className="settings-divider" />
                    <div className="settings-card-header">
                      <h4>Plantillas guardadas</h4>
                      <span className="settings-chip">{documentTemplates.length}</span>
                    </div>
                    <div className="template-saved-list">
                      {templatesLoading && <p>Cargando plantillas...</p>}
                      {!templatesLoading && documentTemplates.length === 0 && <p>No hay plantillas guardadas todavía.</p>}
                      {!templatesLoading &&
                        documentTemplates.map((template) => (
                          <article key={template.template_id} className="template-saved-item">
                            <div>
                              <strong>{template.name}</strong>
                              <p>{template.description || 'Sin descripcion'}</p>
                              <span>
                                {template.is_active ? 'Activa' : 'Inactiva'} · {resolveRuleStatusLabel(template.rule_status)} · Actualizada{' '}
                                {formatDateTime(template.updated_at)}
                              </span>
                            </div>
                            <div className="template-item-actions">
                              <button
                                type="button"
                                className="link-btn"
                                onClick={() => void loadTemplateIntoEditor(template.template_id)}
                                disabled={templateActionLoadingId === template.template_id}
                              >
                                {templateActionLoadingId === template.template_id ? 'Cargando...' : 'Editar'}
                              </button>
                              <button
                                type="button"
                                className="link-btn"
                                onClick={() => void openClassificationRuleEditor(template.template_id, false)}
                                disabled={templateActionLoadingId === template.template_id}
                              >
                                Editar regla
                              </button>
                              <button
                                type="button"
                                className="link-btn link-btn-danger"
                                onClick={() => void removeTemplate(template.template_id)}
                                disabled={templateActionLoadingId === template.template_id}
                              >
                                Eliminar
                              </button>
                            </div>
                          </article>
                        ))}
                    </div>
                    {templateError && <p className="oauth-feedback error">{templateError}</p>}
                    {templateSuccess && <p className="oauth-feedback success">{templateSuccess}</p>}
                  </div>
                </section>
              </div>
            </div>
          </main>
        )}

        {activeSection === 'nomina' && isConnected && (
          <main className="content process-content">
            <section className="section-page-header" aria-label="Encabezado de nomina">
              <h2>Nomina y colaboradores</h2>
              <p>Visualiza colaboradores y administra sus documentos por año.</p>
            </section>
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
                    <div className="collaborator-search-wrap">
                      <span translate="no" className="material-symbols-outlined notranslate collaborator-search-icon" aria-hidden="true">
                        search
                      </span>
                      <input
                        className="collaborator-search"
                        type="text"
                        value={collaboratorSearch}
                        onChange={(event) => setCollaboratorSearch(event.target.value)}
                        placeholder="Buscar colaborador..."
                      />
                    </div>
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

      {showTutorialModal && (
        <div className="modal-overlay tutorial-modal-overlay" role="dialog" aria-modal="true" aria-label="Tutorial de carpetas Drive">
          <div className="modal-card tutorial-structure-modal">
            <div className="tutorial-structure-header">
              <div className="tutorial-structure-brand">
                <div className="tutorial-structure-logo">
                  <span translate="no" className="material-symbols-outlined notranslate" aria-hidden="true">
                    folder_managed
                  </span>
                </div>
                <div>
                  <p className="tutorial-structure-brand-title">Recibox</p>
                  <p className="tutorial-structure-brand-subtitle">Estructura de archivos</p>
                </div>
              </div>
              <button type="button" className="tutorial-close-btn" onClick={() => setShowTutorialModal(false)} aria-label="Cerrar tutorial">
                ✕
              </button>
            </div>

            <div className="tutorial-structure-body">
              <h3>Como organiza RECIBOX las carpetas</h3>
              <p className="tutorial-structure-subtitle">
                Estructura recomendada para mantener el procesamiento ordenado en Google Drive.
              </p>

              <div className="tutorial-structure-grid">
                <section className="tutorial-tree-card" aria-label="Estructura de carpetas">
                  <div className="tutorial-tree-root tutorial-tree-item-main">
                    <div className="tutorial-tree-root-icon">
                      <span translate="no" className="material-symbols-outlined notranslate" aria-hidden="true">
                        folder
                      </span>
                    </div>
                    <div>
                      <p className="tutorial-tree-kicker">Carpeta principal</p>
                      <p className="tutorial-tree-title">RECIBOX (carpeta principal)</p>
                    </div>
                  </div>

                  <div className="tutorial-tree-node tutorial-tree-node-level-1">
                    <span className="tutorial-node-icon" aria-hidden="true">
                      <span translate="no" className="material-symbols-outlined notranslate">folder_data</span>
                    </span>
                    <div className="tutorial-tree-copy">
                      <p className="tutorial-node-title">#0 INPUT</p>
                      <p className="tutorial-node-text">Carpeta de entrada para archivos a procesar</p>
                    </div>
                  </div>

                  <div className="tutorial-tree-node tutorial-tree-node-level-1">
                    <span className="tutorial-node-icon" aria-hidden="true">
                      <span translate="no" className="material-symbols-outlined notranslate">groups</span>
                    </span>
                    <div className="tutorial-tree-copy">
                      <p className="tutorial-node-title">Carpeta de colaborador</p>
                      <p className="tutorial-node-text">Una carpeta por cada colaborador</p>
                    </div>
                  </div>

                  <div className="tutorial-tree-node tutorial-tree-node-level-2">
                    <span className="tutorial-node-icon tutorial-node-icon-min" aria-hidden="true">
                      <span translate="no" className="material-symbols-outlined notranslate">calendar_month</span>
                    </span>
                    <div className="tutorial-tree-copy">
                      <p className="tutorial-tree-subnode">Año</p>
                    </div>
                  </div>

                  <div className="tutorial-tree-node tutorial-tree-node-level-3">
                    <span className="tutorial-node-icon tutorial-node-icon-min" aria-hidden="true">
                      <span translate="no" className="material-symbols-outlined notranslate">description</span>
                    </span>
                    <div className="tutorial-tree-copy">
                      <p className="tutorial-tree-subnode tutorial-tree-subnode-italic">
                        Documento del colaborador (Ej. Recibo de sueldo)
                      </p>
                    </div>
                  </div>
                </section>

                <div className="tutorial-info-col">
                  <section className="tutorial-info-card tutorial-info-card-primary" aria-label="Regla principal">
                    <h4>
                      <span translate="no" className="material-symbols-outlined notranslate" aria-hidden="true">
                        info
                      </span>
                      Funcionamiento automatico
                    </h4>
                    <p>
                      RECIBOX organiza todo en una carpeta principal (por defecto <strong>RECIBOX</strong>) y requiere la
                      subcarpeta <strong>#0 INPUT</strong> para recibir archivos.
                    </p>
                    <p>
                      Si eliges una carpeta existente, se renombrara a <strong>RECIBOX</strong> y si no tiene{' '}
                      <strong>#0 INPUT</strong>, se creara automaticamente.
                    </p>
                  </section>

                  <section className="tutorial-info-card" aria-label="Pregunta frecuente">
                    <h4>
                      <span translate="no" className="material-symbols-outlined notranslate" aria-hidden="true">
                        auto_fix_high
                      </span>
                      ¿Como funciona el flujo?
                    </h4>
                    <p>Sube archivos en <strong>#0 INPUT</strong> y ejecuta el procesamiento desde Backoffice.</p>
                    <p>RECIBOX los clasifica por colaborador y luego por año para mantener trazabilidad documental.</p>
                  </section>
                </div>
              </div>
            </div>

            <div className="tutorial-structure-footer">
              <button type="button" className="modal-secondary" onClick={() => setShowTutorialModal(false)}>
                Cerrar
              </button>
              <button type="button" className="modal-primary tutorial-ok-btn" onClick={() => setShowTutorialModal(false)}>
                Entendido
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

      {showProcessModeModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Elegir modo de procesamiento">
          <div className="modal-card process-mode-modal">
            <h3>Elegir flujo de proceso</h3>
            <p>Seleccioná cómo querés procesar los archivos pendientes.</p>
            <div className="settings-field">
              <label htmlFor="processing-mode-select-modal">Modo de procesamiento</label>
              <select
                id="processing-mode-select-modal"
                className="year-select"
                value={processingMode}
                onChange={(event) => changeProcessingMode(event.target.value as ProcessingMode)}
              >
                <option value="default">Flujo actual</option>
                <option value="template">Usar plantilla</option>
              </select>
            </div>
            {processingMode === 'template' && (
              <>
                <div className="settings-field">
                  <label htmlFor="processing-template-select-modal">Plantilla</label>
                  <select
                    id="processing-template-select-modal"
                    className="year-select"
                    value={selectedTemplateId}
                    onChange={(event) => setSelectedTemplateId(event.target.value)}
                    disabled={templatesLoading || processTemplates.length === 0}
                  >
                    {processTemplates.length === 0 && <option value="">Sin plantillas activas</option>}
                    {processTemplates.map((template) => (
                      <option
                        key={template.template_id}
                        value={template.template_id}
                        disabled={template.rule_status !== 'ready'}
                      >
                        {template.name}
                        {template.rule_status === 'ready' ? '' : ' (regla incompleta)'}
                      </option>
                    ))}
                  </select>
                </div>
                {readyProcessTemplates.length === 0 ? (
                  <p className="settings-preview">No hay plantillas listas. Completá una regla de clasificacion en Configuracion.</p>
                ) : (
                  <p className="settings-preview">Este modo usa una plantilla ABM con su regla de clasificacion asociada.</p>
                )}
              </>
            )}
            {processError && <p className="oauth-feedback error">{processError}</p>}
            <div className="modal-actions">
              <button type="button" className="modal-secondary" onClick={() => setShowProcessModeModal(false)}>
                Cancelar
              </button>
              <button
                type="button"
                className="modal-primary"
                onClick={() => void triggerProcess()}
                disabled={
                  processingMode === 'template' &&
                  (!selectedTemplateId || !readyProcessTemplates.some((template) => template.template_id === selectedTemplateId))
                }
              >
                Procesar
              </button>
            </div>
          </div>
        </div>
      )}

      {showTemplateEditorModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Editor de plantilla">
          <div className="modal-card template-editor-modal">
            <div className="template-editor-header-row">
              <input
                className="template-title-input"
                value={templateEditor.name}
                onChange={(event) => setTemplateEditor((prev) => ({ ...prev, name: event.target.value }))}
                placeholder={editingTemplateId ? 'Editar plantilla' : 'Nueva plantilla'}
              />
              <div className="template-editor-header-actions">
                <button type="button" className="modal-secondary" onClick={resetTemplateEditor} disabled={templateSaving}>
                  Cancelar
                </button>
                <button
                  type="button"
                  className="modal-primary"
                  onClick={() => void saveTemplateEditor()}
                  disabled={templateSaving || !templateEditor.name.trim()}
                >
                  {templateSaving ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </div>
            <p className="settings-preview">
              Archivo base: {templateEditor.sampleFileName || 'N/D'}
            </p>

            <div className="template-editor-layout">
              <div className="template-canvas-panel">
                <div
                  ref={templateCanvasRef}
                  className="template-canvas-wrapper"
                  onMouseDown={startTemplateDrawing}
                  onMouseMove={moveTemplateDrawing}
                  onMouseUp={endTemplateDrawing}
                  onMouseLeave={endTemplateDrawing}
                >
                  {templateEditor.previewImageDataUrl && (
                    <img src={templateEditor.previewImageDataUrl} className="template-canvas-image" alt="PDF de plantilla" />
                  )}
                  {!templateEditor.previewImageDataUrl && (
                    <p className="template-canvas-empty">No se pudo cargar la vista previa del PDF.</p>
                  )}
                  {templateEditor.previewImageDataUrl && (
                    <div className="template-canvas-overlay">
                      {templateEditor.fields.map((field, index) => (
                        <div
                          key={field.id}
                          className={`template-zone ${templateHoveredFieldId === field.id ? 'template-zone-active' : ''}`}
                          style={{
                            left: `${field.rect.x * 100}%`,
                            top: `${field.rect.y * 100}%`,
                            width: `${field.rect.w * 100}%`,
                            height: `${field.rect.h * 100}%`,
                          }}
                          onMouseEnter={() => setTemplateHoveredFieldId(field.id)}
                          onMouseLeave={() => setTemplateHoveredFieldId((prev) => (prev === field.id ? null : prev))}
                          title={`${field.name} (${index + 1})`}
                        />
                      ))}
                      {templatePendingRect && (
                        <div
                          className="template-zone template-zone-pending"
                          style={{
                            left: `${templatePendingRect.x * 100}%`,
                            top: `${templatePendingRect.y * 100}%`,
                            width: `${templatePendingRect.w * 100}%`,
                            height: `${templatePendingRect.h * 100}%`,
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
                <p className="settings-preview">
                  Dibuja una zona con el mouse sobre el PDF. Al soltar, se autocompleta el dato detectado y la etiqueta
                  sugerida.
                </p>
              </div>

              <div className="template-form-panel">
                <div className="settings-field">
                  <label htmlFor="template-description-modal">Descripcion</label>
                  <input
                    id="template-description-modal"
                    className="settings-input"
                    value={templateEditor.description}
                    onChange={(event) => setTemplateEditor((prev) => ({ ...prev, description: event.target.value }))}
                    placeholder="Uso interno"
                  />
                </div>
                <div className="settings-field">
                  <label htmlFor="template-field-detected-value">Dato detectado</label>
                  <textarea
                    id="template-field-detected-value"
                    className="settings-input template-detected-input"
                    value={templateFieldDraft.detectedValue}
                    onChange={(event) =>
                      setTemplateFieldDraft((prev) => ({
                        ...prev,
                        detectedValue: event.target.value,
                      }))
                    }
                    placeholder="Dato detectado en la zona"
                  />
                </div>
                <div className="settings-field">
                  <label htmlFor="template-field-suggested-label">Etiqueta sugerida</label>
                  <input
                    id="template-field-suggested-label"
                    className="settings-input"
                    value={templateFieldDraft.suggestedLabel}
                    onChange={(event) =>
                      setTemplateFieldDraft((prev) => ({
                        ...prev,
                        suggestedLabel: event.target.value,
                      }))
                    }
                    placeholder="Etiqueta sugerida"
                  />
                </div>
                <div className="settings-field">
                  <label htmlFor="template-field-name">Campo</label>
                  <input
                    id="template-field-name"
                    className="settings-input"
                    value={templateFieldDraft.name}
                    onChange={(event) =>
                      setTemplateFieldDraft((prev) => ({
                        ...prev,
                        name: event.target.value,
                      }))
                    }
                    placeholder="Ej. total_neto"
                  />
                </div>
                <div className="settings-field">
                  <label htmlFor="template-field-type">Tipo</label>
                  <select
                    id="template-field-type"
                    className="year-select"
                    value={templateFieldDraft.type}
                    onChange={(event) =>
                      setTemplateFieldDraft((prev) => ({
                        ...prev,
                        type: event.target.value as TemplateFieldType,
                      }))
                    }
                  >
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="date">date</option>
                    <option value="array">array</option>
                  </select>
                </div>
                <label className="template-toggle">
                  <input
                    type="checkbox"
                    checked={templateFieldDraft.required}
                    onChange={(event) =>
                      setTemplateFieldDraft((prev) => ({
                        ...prev,
                        required: event.target.checked,
                      }))
                    }
                  />
                  <span>Campo requerido</span>
                </label>
                <div className="settings-actions">
                  <button
                    type="button"
                    className="modal-primary"
                    onClick={addFieldToTemplate}
                    disabled={!templatePendingRect || !templateFieldDraft.name.trim()}
                  >
                    Agregar campo
                  </button>
                </div>
                <hr className="settings-divider" />
                <p className="template-box-title">Campos agregados</p>
                <div className="template-field-list">
                  {templateEditor.fields.length === 0 && <p>No hay campos agregados todavía.</p>}
                  {templateEditor.fields.map((field) => {
                    const sourceValue = field.detectedValue || field.sampleValue || ''
                    const preview = buildTransformPipelinePreview(sourceValue, field.transforms, field.key)
                    return (
                      <article
                        key={field.id}
                        className={`template-saved-item ${templateHoveredFieldId === field.id ? 'template-saved-item-active' : ''}`}
                        onMouseEnter={() => setTemplateHoveredFieldId(field.id)}
                        onMouseLeave={() => setTemplateHoveredFieldId((prev) => (prev === field.id ? null : prev))}
                      >
                        <div className="template-saved-main">
                          <div>
                            <strong>{field.name}</strong>
                            <p>{field.suggestedLabel || field.label || 'Sin etiqueta sugerida'}</p>
                            <span>{sourceValue || 'Sin valor detectado'}</span>
                          </div>

                          <div className="template-field-transform-panel">
                            <div className="template-field-transform-header">
                              <span>Transformaciones ({field.transforms.length}/3)</span>
                              <button
                                type="button"
                                className="modal-secondary"
                                onClick={() => addTemplateFieldTransformStep(field.id)}
                                disabled={field.transforms.length >= 3}
                              >
                                + Paso
                              </button>
                            </div>

                            {field.transforms.length === 0 ? (
                              <p className="settings-preview">Sin transformaciones (valor identidad).</p>
                            ) : (
                              <div className="template-transform-steps">
                                {field.transforms.map((step, stepIndex) => (
                                  <div key={step.id} className="template-transform-step-row">
                                    <span className="template-transform-step-index">Paso {stepIndex + 1}</span>
                                    <select
                                      className="year-select"
                                      value={step.operation}
                                      onChange={(event) =>
                                        updateTemplateFieldTransformStep(field.id, step.id, (current) => {
                                          const operation = normalizeTransformOperation(event.target.value)
                                          const next = createTransformStepDraft(operation)
                                          next.id = current.id
                                          return next
                                        })
                                      }
                                    >
                                      {transformOperationOptions.map((option) => (
                                        <option key={`${step.id}-${option.value}`} value={option.value}>
                                          {option.label}
                                        </option>
                                      ))}
                                    </select>

                                    {step.operation === 'replace' && (
                                      <div className="template-transform-params">
                                        <input
                                          className="settings-input"
                                          placeholder="from"
                                          value={step.from}
                                          onChange={(event) =>
                                            updateTemplateFieldTransformStep(field.id, step.id, (current) => ({
                                              ...current,
                                              from: event.target.value,
                                            }))
                                          }
                                        />
                                        <input
                                          className="settings-input"
                                          placeholder="to"
                                          value={step.to}
                                          onChange={(event) =>
                                            updateTemplateFieldTransformStep(field.id, step.id, (current) => ({
                                              ...current,
                                              to: event.target.value,
                                            }))
                                          }
                                        />
                                      </div>
                                    )}

                                    {step.operation === 'remove_chars' && (
                                      <div className="template-transform-params">
                                        <input
                                          className="settings-input"
                                          placeholder="Caracteres a remover"
                                          value={step.chars}
                                          onChange={(event) =>
                                            updateTemplateFieldTransformStep(field.id, step.id, (current) => ({
                                              ...current,
                                              chars: event.target.value,
                                            }))
                                          }
                                        />
                                      </div>
                                    )}

                                    {step.operation === 'split' && (
                                      <div className="template-transform-params">
                                        <input
                                          className="settings-input"
                                          placeholder="Separador"
                                          value={step.delimiter}
                                          onChange={(event) =>
                                            updateTemplateFieldTransformStep(field.id, step.id, (current) => ({
                                              ...current,
                                              delimiter: event.target.value,
                                            }))
                                          }
                                        />
                                        <input
                                          className="settings-input"
                                          placeholder="Indice (1..n)"
                                          value={step.index}
                                          onChange={(event) =>
                                            updateTemplateFieldTransformStep(field.id, step.id, (current) => ({
                                              ...current,
                                              index: event.target.value,
                                            }))
                                          }
                                        />
                                      </div>
                                    )}

                                    {step.operation === 'case' && (
                                      <div className="template-transform-params">
                                        <select
                                          className="year-select"
                                          value={step.mode}
                                          onChange={(event) =>
                                            updateTemplateFieldTransformStep(field.id, step.id, (current) => ({
                                              ...current,
                                              mode:
                                                event.target.value === 'upper'
                                                  ? 'upper'
                                                  : event.target.value === 'title'
                                                    ? 'title'
                                                    : 'lower',
                                            }))
                                          }
                                        >
                                          {transformCaseModeOptions.map((option) => (
                                            <option key={`${step.id}-${option.value}`} value={option.value}>
                                              {option.label}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                    )}

                                    {step.operation === 'date_format' && (
                                      <div className="template-transform-params">
                                        <select
                                          className="year-select"
                                          value={step.output}
                                          onChange={(event) =>
                                            updateTemplateFieldTransformStep(field.id, step.id, (current) => ({
                                              ...current,
                                              output:
                                                event.target.value === 'DD' ||
                                                event.target.value === 'MM' ||
                                                event.target.value === 'YYYY' ||
                                                event.target.value === 'MM/YYYY' ||
                                                event.target.value === 'YYYY-MM' ||
                                                event.target.value === 'MMM' ||
                                                event.target.value === 'MMMM'
                                                  ? event.target.value
                                                  : 'YYYY',
                                            }))
                                          }
                                        >
                                          {transformDateOutputOptions.map((option) => (
                                            <option key={`${step.id}-${option.value}`} value={option.value}>
                                              {option.label}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                    )}

                                    {step.operation === 'trim' && <p className="settings-preview">Sin parámetros.</p>}

                                    <button
                                      type="button"
                                      className="link-btn link-btn-danger"
                                      onClick={() => removeTemplateFieldTransformStep(field.id, step.id)}
                                    >
                                      Quitar
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}

                            <div className="template-transform-preview">
                              <p className="settings-preview"><strong>Vista previa:</strong></p>
                              <p className="settings-preview">Original: {preview.snapshots[0] || '(vacio)'}</p>
                              {field.transforms.map((step, stepIndex) => (
                                <p key={`${field.id}-preview-${step.id}`} className="settings-preview">
                                  Paso {stepIndex + 1}: {preview.snapshots[stepIndex + 1] || '(vacio)'}
                                </p>
                              ))}
                              <p className="settings-preview"><strong>Resultado:</strong> {preview.result || '(vacio)'}</p>
                              {preview.error && <p className="settings-hint">{preview.error}</p>}
                            </div>
                          </div>
                        </div>
                        <div className="template-item-actions">
                          <button
                            type="button"
                            className="link-btn link-btn-danger"
                            onClick={() => removeTemplateFieldFromEditor(field.id)}
                          >
                            Eliminar
                          </button>
                        </div>
                      </article>
                    )
                  })}
                </div>
              </div>
            </div>

            {templateError && <p className="oauth-feedback error">{templateError}</p>}
            {templateSuccess && <p className="oauth-feedback success">{templateSuccess}</p>}
          </div>
        </div>
      )}

      {showClassificationRuleModal && (
        <div className="fixed inset-0 z-[1000] bg-slate-900/35 p-2.5 backdrop-blur-[1px]" role="dialog" aria-modal="true" aria-label="Editor de regla de clasificacion">
          <div className="mx-auto flex h-[min(90vh,860px)] w-full max-w-[1160px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
            <header className="flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 md:px-5">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#3a5f0b] text-white">
                  <SlidersHorizontal className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-extrabold tracking-tight text-slate-800 md:text-[22px]">Configurar Regla de Procesamiento</h3>
                    {classificationRuleMandatory && <span className="inline-flex h-6 items-center rounded-full border border-blue-200 bg-blue-50 px-2 text-[11px] font-bold text-blue-700">Obligatorio</span>}
                  </div>
                  <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500">
                    RECIBOX <ChevronRight className="h-3 w-3" /> Folder <ChevronRight className="h-3 w-3" /> File
                  </p>
                  <p className="text-xs text-slate-500">
                    Plantilla: <strong className="text-slate-700">{classificationRuleTemplateLabel}</strong>
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-55"
                onClick={closeClassificationRuleEditor}
                disabled={classificationRuleSaving}
                aria-label="Cerrar editor de regla"
              >
                <X className="h-5 w-5" />
              </button>
            </header>

            <DndContext
              sensors={classificationRuleDndSensors}
              collisionDetection={closestCenter}
              onDragStart={handleClassificationRuleDragStart}
              onDragEnd={handleClassificationRuleDragEnd}
              onDragCancel={handleClassificationRuleDragCancel}
            >
              <div className="grid min-h-0 flex-1 grid-cols-1 bg-slate-50 lg:grid-cols-[264px_minmax(0,1fr)]">
                <aside className="min-w-[248px] overflow-x-hidden border-b border-slate-200 bg-slate-100/80 p-3.5 lg:border-b-0 lg:border-r">
                  <p className="mb-2.5 text-[11px] font-extrabold uppercase tracking-[0.08em] text-slate-600">Campos dinámicos</p>
                  <div className="grid max-h-[260px] gap-2 overflow-x-hidden overflow-y-auto pr-1 lg:max-h-none">
                    {classificationRulePaletteItems.map((item) => (
                      <RulePaletteChip
                        key={item.id}
                        item={item}
                        disabled={classificationRuleSaving || classificationRuleLoading}
                        metaText={
                          item.kind === 'field'
                            ? classificationRuleFieldOptions.find((field) => field.key === item.fieldKey)?.previewValue || ''
                            : ''
                        }
                      />
                    ))}
                  </div>

                  <div className="mt-3.5 rounded-lg border border-green-200 bg-green-50/70 p-3 lg:mt-5">
                    <p className="mb-1.5 inline-flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.04em] text-green-800">
                      <Info className="h-3.5 w-3.5" />
                      Ayuda de sistema
                    </p>
                    <p className="text-xs leading-relaxed text-green-800/85">
                      Arrastrá los campos a la ruta para automatizar la organización de tus archivos.
                    </p>
                  </div>
                </aside>

                <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
                  <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 md:px-5">
                    <h4 className="text-lg font-extrabold tracking-tight text-slate-800 md:text-xl">Constructor de Ruta Dinámica</h4>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <label className="inline-flex items-center gap-2.5 text-[11px] font-semibold text-slate-600">
                        Crear si no existe
                        <button
                          type="button"
                          role="switch"
                          aria-checked={createIfMissingEnabled}
                          onClick={() => {
                            const nextEnabled = !createIfMissingEnabled
                            setClassificationRuleNodes((prev) =>
                              prev.map((node) =>
                                node.nodeType === 'folder'
                                  ? {
                                      ...node,
                                      conflictPolicy: nextEnabled ? 'create_new' : 'use_existing',
                                    }
                                  : node,
                              ),
                            )
                          }}
                          disabled={classificationRuleSaving || classificationRuleLoading || folderRuleNodes.length === 0}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${
                            createIfMissingEnabled ? 'border-green-700 bg-green-700' : 'border-slate-300 bg-slate-200'
                          } disabled:cursor-not-allowed disabled:opacity-50`}
                        >
                          <span
                            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                              createIfMissingEnabled ? 'translate-x-5' : 'translate-x-0.5'
                            }`}
                          />
                        </button>
                      </label>
                      <button
                        type="button"
                        className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 text-[13px] font-semibold text-slate-700 transition hover:border-slate-400"
                        onClick={addClassificationRuleFolderNode}
                        disabled={classificationRuleSaving || classificationRuleLoading}
                      >
                        <Plus className="h-3.5 w-3.5" /> Carpeta
                      </button>
                    </div>
                  </div>

                  {classificationRuleLoading ? (
                    <div className="flex items-center justify-center p-6 text-sm font-semibold text-slate-500">Cargando regla...</div>
                  ) : (
                    <div className="space-y-4 overflow-y-auto px-4 py-4 md:px-5">
                      <div className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-green-100 text-green-800">
                          <GitBranchPlus className="h-4 w-4" />
                        </span>
                        <Folder className="h-4 w-4 text-slate-700" />
                        <strong className="text-[13px] text-slate-800">RECIBOX</strong>
                      </div>

                      <div className="space-y-4">
                        {classificationRuleNodes.map((node, nodeIndex) => (
                          <RuleBuilderNodeCard
                            key={node.id}
                            node={node}
                            nodeIndex={nodeIndex}
                            fieldOptions={classificationRuleFieldOptions}
                            paletteItems={classificationRulePaletteItems}
                            saving={classificationRuleSaving}
                            onLiteralChange={updateClassificationRuleLiteralPart}
                            onRemovePart={removeClassificationRuleNamePart}
                            onAddPart={addClassificationRulePart}
                            onRemoveFolderLevel={removeClassificationRuleFolderNode}
                          />
                        ))}
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                        <div className="inline-flex items-center gap-2.5">
                          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-green-700 text-white">
                            <Settings className="h-3.5 w-3.5" />
                          </span>
                          <h5 className="text-base font-extrabold text-slate-800">Configuración del Índice</h5>
                        </div>
                        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1">
                          <button
                            type="button"
                            className={`rounded-md px-3 py-1 text-[11px] font-extrabold transition ${
                              firstIndexEditorTarget?.part.indexKind === 'numeric'
                                ? 'bg-green-100 text-green-800 shadow-sm'
                                : 'text-slate-500'
                            }`}
                            onClick={() => {
                              if (!firstIndexEditorTarget) {
                                return
                              }
                              updateClassificationRuleNamePart(firstIndexEditorTarget.nodeId, firstIndexEditorTarget.part.id, (current) => ({
                                ...current,
                                indexKind: 'numeric',
                              }))
                            }}
                            disabled={classificationRuleSaving || !firstIndexEditorTarget}
                          >
                            NUMÉRICO
                          </button>
                          <button
                            type="button"
                            className={`rounded-md px-3 py-1 text-[11px] font-extrabold transition ${
                              firstIndexEditorTarget?.part.indexKind === 'alphabetic'
                                ? 'bg-green-100 text-green-800 shadow-sm'
                                : 'text-slate-500'
                            }`}
                            onClick={() => {
                              if (!firstIndexEditorTarget) {
                                return
                              }
                              updateClassificationRuleNamePart(firstIndexEditorTarget.nodeId, firstIndexEditorTarget.part.id, (current) => ({
                                ...current,
                                indexKind: 'alphabetic',
                              }))
                            }}
                            disabled={classificationRuleSaving || !firstIndexEditorTarget}
                          >
                            ALFABÉTICO
                          </button>
                        </div>
                      </div>

                      {!firstIndexEditorTarget ? (
                        <p className="text-xs font-semibold text-slate-500">Agregá un chip de índice para configurar ordenación e inicio.</p>
                      ) : (
                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="space-y-2">
                            <p className="text-xs font-extrabold uppercase tracking-[0.08em] text-slate-600">Ordenación</p>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-[13px] font-bold transition ${
                                  firstIndexEditorTarget.part.indexDirection === 'incremental'
                                    ? 'border-green-300 bg-green-100 text-green-800'
                                    : 'border-slate-200 bg-white text-slate-500'
                                }`}
                                onClick={() =>
                                  updateClassificationRuleNamePart(firstIndexEditorTarget.nodeId, firstIndexEditorTarget.part.id, (current) => ({
                                    ...current,
                                    indexDirection: 'incremental',
                                  }))
                                }
                                disabled={classificationRuleSaving}
                              >
                                <ArrowUp className="h-4 w-4" /> Ascendente
                              </button>
                              <button
                                type="button"
                                className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-[13px] font-bold transition ${
                                  firstIndexEditorTarget.part.indexDirection === 'decremental'
                                    ? 'border-green-300 bg-green-100 text-green-800'
                                    : 'border-slate-200 bg-white text-slate-500'
                                }`}
                                onClick={() =>
                                  updateClassificationRuleNamePart(firstIndexEditorTarget.nodeId, firstIndexEditorTarget.part.id, (current) => ({
                                    ...current,
                                    indexDirection: 'decremental',
                                  }))
                                }
                                disabled={classificationRuleSaving}
                              >
                                <ArrowDown className="h-4 w-4" /> Descendente
                              </button>
                            </div>
                          </div>

                          <div className="space-y-2">
                            <p className="text-xs font-extrabold uppercase tracking-[0.08em] text-slate-600">Valor inicial</p>
                            <label className="relative block">
                              <input
                                className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 pr-14 text-[13px] font-semibold text-slate-700 outline-none placeholder:text-slate-400 focus:border-green-500"
                                value={
                                  firstIndexEditorTarget.part.indexKind === 'alphabetic'
                                    ? firstIndexEditorTarget.part.indexStartAlpha
                                    : firstIndexEditorTarget.part.indexStartNumeric
                                }
                                onChange={(event) =>
                                  updateClassificationRuleNamePart(firstIndexEditorTarget.nodeId, firstIndexEditorTarget.part.id, (current) =>
                                    current.indexKind === 'alphabetic'
                                      ? { ...current, indexStartAlpha: event.target.value.toUpperCase() }
                                      : { ...current, indexStartNumeric: event.target.value },
                                  )
                                }
                                placeholder={firstIndexEditorTarget.part.indexKind === 'alphabetic' ? 'A' : '001'}
                                disabled={classificationRuleSaving}
                              />
                              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-slate-400">
                                Inicio
                              </span>
                            </label>
                          </div>
                        </div>
                      )}
                    </div>
                    </div>
                  )}
                </section>
              </div>
              <DragOverlay modifiers={[snapCenterToCursor]}>
                {classificationRuleActiveOverlay ? (
                  <RuleDragOverlayChip
                    label={classificationRuleActiveOverlay.label}
                    kind={classificationRuleActiveOverlay.kind}
                    overlay
                  />
                ) : null}
              </DragOverlay>
            </DndContext>

            {classificationRuleError && <p className="mx-4 mt-3 text-sm font-semibold text-red-600 md:mx-5">{classificationRuleError}</p>}
            {classificationRuleSuccess && <p className="mx-4 mt-3 text-sm font-semibold text-green-700 md:mx-5">{classificationRuleSuccess}</p>}

            <footer className="flex flex-col gap-3 border-t border-slate-200 bg-slate-100/90 px-4 py-3 md:flex-row md:items-end md:justify-between md:px-5">
              <div className="min-w-0">
                <p className="text-[11px] font-extrabold uppercase tracking-[0.2em] text-slate-600">Vista previa del resultado</p>
                <div className="mt-1.5 inline-flex max-w-full flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] font-semibold text-slate-700">
                  <span>RECIBOX</span>
                  {classificationRulePathPreview.folders.map((folder, index) => (
                    <span key={`preview-folder-${index}`} className="inline-flex items-center gap-1">
                      <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                      <span>{folder}</span>
                    </span>
                  ))}
                  <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                  <span className="inline-flex items-center gap-1 rounded-md border border-green-300 bg-green-100 px-2 py-1 text-green-800">
                    <FileText className="h-3.5 w-3.5" />
                    {classificationRulePathPreview.fileName}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  className="inline-flex h-10 items-center rounded-lg px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-200/70 disabled:cursor-not-allowed disabled:opacity-55"
                  onClick={closeClassificationRuleEditor}
                  disabled={classificationRuleSaving}
                >
                  {classificationRuleMandatory ? 'Cerrar (pendiente)' : 'Cancelar'}
                </button>
                <button
                  type="button"
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#3a5f0b] px-5 text-sm font-extrabold text-white shadow-lg shadow-green-900/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-55"
                  onClick={() => void saveClassificationRuleEditor()}
                  disabled={classificationRuleLoading || classificationRuleSaving}
                >
                  <Save className="h-4 w-4" />
                  {classificationRuleSaving ? 'Guardando...' : 'Guardar Regla'}
                </button>
              </div>
            </footer>
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

function App() {
  return <BackofficeApp />
}

export default App
