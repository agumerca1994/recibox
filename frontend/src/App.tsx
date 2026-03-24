import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import {
  AlertTriangle,
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
  MoreHorizontal,
  Pencil,
  Plus,
  Save,
  Settings,
  SlidersHorizontal,
  Tag,
  Tags,
  Trash2,
  Type,
  X,
  type LucideIcon,
} from 'lucide-react'
import { DragOverlay, DndContext, type DragEndEvent, type DragStartEvent, PointerSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import { snapCenterToCursor } from '@dnd-kit/modifiers'
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import './App.css'
import { ReportsScreen } from './reports/ReportsScreen'
import {
  adoptReciboxFolder,
  buildDrivePdfDownloadUrl,
  buildTemplateSourcePdfUrl,
  checkReciboxStructure,
  createTemplateGroup,
  createTemplate,
  createReciboxStructure,
  deleteTemplate,
  getTemplate,
  getTemplateClassificationRule,
  getGoogleOAuthStatus,
  ingestDrive,
  listFolderContents,
  listFilesInFolder,
  listDriveFiles,
  listProcessRuns,
  listPickerFolders,
  listTemplates,
  listTemplateGroups,
  putTemplateClassificationRule,
  putTenantDriveConfig,
  stopJob,
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
  JobStatusResponse,
  ProcessRunRecord,
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
  TemplateGroup,
  TemplateSummary,
} from './types/api'

const defaultTenant = normalizeTenantId(import.meta.env.VITE_TENANT_ID || 'acme') || 'acme'
const apiBasePath = import.meta.env.VITE_API_BASE_PATH || '/api'
const pdfWorkerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
const templateLocalUploadEnabled = (getRuntimeSetting('VITE_TEMPLATE_LOCAL_UPLOAD_ENABLED') || 'false').toLowerCase() === 'true'
const templateListCacheTtlMs = 30_000
const templateGroupCacheTtlMs = 60_000
const legacyProcessingFlowEnabled =
  (getRuntimeSetting('VITE_ENABLE_LEGACY_PROCESSING_FLOW') || 'false').toLowerCase() === 'true'
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

type FloatingMenuPosition = {
  top: number
  left: number
  openUp?: boolean
}

type Section = 'cuenta' | 'procesar' | 'nomina' | 'reportes' | 'configuracion'
type ProcessState = 'running' | 'success' | 'error' | 'paused'
type SortOrder = 'asc' | 'desc'
type ProcessingMode = 'default' | 'template'

type ProcessItem = {
  id: string
  jobId: string
  name: string
  state: ProcessState
  detail: JobStatusResponse | null
  createdAt: number
  createdAtIso: string | null
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
  type: TemplateFieldType
  detectedValue: string
  suggestedLabel: string
}

type TemplateEditorState = {
  name: string
  groupId: string
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

type NominaFolderContentsCacheEntry = {
  folders: DriveFolder[]
  files: DriveFile[]
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
  reportes: '/reportes',
  configuracion: '/configuracion',
}

const transformOperationOptions: Array<{ value: TemplateFieldTransformOperation; label: string }> = [
  { value: 'trim', label: 'Recortar espacios' },
  { value: 'replace', label: 'Reemplazar texto' },
  { value: 'remove_chars', label: 'Quitar caracteres' },
  { value: 'split', label: 'Dividir por separador' },
  { value: 'case', label: 'Cambiar mayusculas y minusculas' },
  { value: 'date_format', label: 'Formatear fecha' },
]

const transformCaseModeOptions: Array<{ value: TemplateFieldTransformCaseMode; label: string }> = [
  { value: 'upper', label: 'MAYUSCULAS' },
  { value: 'lower', label: 'minusculas' },
  { value: 'title', label: 'Iniciar con mayuscula' },
]

const transformDateOutputOptions: Array<{ value: TemplateFieldTransformDateOutput; label: string }> = [
  { value: 'DD', label: 'DD' },
  { value: 'MM', label: 'MM' },
  { value: 'YYYY', label: 'YYYY' },
  { value: 'MM/YYYY', label: 'MM/YYYY' },
  { value: 'MM-YYYY', label: 'MM-YYYY' },
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
  const [insertMenuPosition, setInsertMenuPosition] = useState<FloatingMenuPosition | null>(null)
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
    const viewportPadding = 12
    const menuWidth = 224
    const menuHeight = 280
    const preferredLeft = rect.left
    const openUp = window.innerHeight - rect.bottom < menuHeight + 12 && rect.top > menuHeight + viewportPadding
    const maxLeft = Math.max(window.innerWidth - menuWidth - viewportPadding, viewportPadding)
    setInsertMenuPosition({
      left: Math.min(Math.max(preferredLeft, viewportPadding), maxLeft),
      top: openUp ? rect.top - 8 : Math.max(rect.bottom + 8, viewportPadding),
      openUp,
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
            className="fixed z-[1200] max-h-[calc(100vh-24px)] w-56 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-2xl"
            style={{
              left: insertMenuPosition.left,
              top: insertMenuPosition.top,
              transform: insertMenuPosition.openUp ? 'translateY(-100%)' : undefined,
            }}
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
          Vista previa:{' '}
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


function compareEmployeeFolders(a: DriveFolder, b: DriveFolder): number {
  const cmp = employeeNameCollator.compare(normalizeSearchText(a.name), normalizeSearchText(b.name))
  if (cmp !== 0) {
    return cmp
  }
  return a.id.localeCompare(b.id)
}

function compareTemplateGroups(a: TemplateGroup, b: TemplateGroup): number {
  const cmp = employeeNameCollator.compare(normalizeSearchText(a.name), normalizeSearchText(b.name))
  if (cmp !== 0) {
    return cmp
  }
  return a.group_id.localeCompare(b.group_id)
}

function mapProcessRunItem(record: ProcessRunRecord): ProcessItem {
  const createdAtIso = record.created_at || record.detail?.created_at || null
  const createdAt = createdAtIso ? new Date(createdAtIso).getTime() : 0
  return {
    id: record.id || record.job_id,
    jobId: record.job_id,
    name: record.name,
    state: record.state,
    detail: record.detail || null,
    createdAt: Number.isNaN(createdAt) ? 0 : createdAt,
    createdAtIso,
  }
}

function getProcessStateLabel(state: ProcessState): string {
  if (state === 'running') {
    return 'En curso'
  }
  if (state === 'success') {
    return 'Exito'
  }
  if (state === 'paused') {
    return 'Pausado'
  }
  return 'Error'
}

function formatProcessName(item: ProcessItem): string {
  const timestamp = item.createdAtIso || item.detail?.created_at || null
  return `${item.name} - ${formatDateTime(timestamp)}`
}

function extractRunMetrics(detail: JobStatusResponse | null): RunMetrics {
  const asNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null)
  const asText = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  const progress =
    detail?.progress && typeof detail.progress === 'object' ? (detail.progress as Record<string, unknown>) : null

  if (!detail?.result || typeof detail.result !== 'object') {
    return {
      totalProcessed: asNumber(progress?.processed),
      success: asNumber(progress?.ok),
      error: asNumber(progress?.error),
      flowStatus: asText(progress?.status),
      message: asText(progress?.message),
      logPath: null,
    }
  }

  const result = detail.result as Record<string, unknown>

  return {
    totalProcessed: asNumber(result.processed) ?? asNumber(progress?.processed),
    success: asNumber(result.ok) ?? asNumber(progress?.ok),
    error: asNumber(result.error) ?? asNumber(progress?.error),
    flowStatus: asText(result.status) ?? asText(progress?.status),
    message: asText(result.message) ?? asText(progress?.message),
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
  if (value === '/reportes') {
    return 'reportes'
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
    groupId: '',
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
    type: 'string',
    detectedValue: '',
    suggestedLabel: '',
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
  draft.index = typeof step.index === 'number' && Number.isFinite(step.index) && step.index >= 2 ? '2' : '1'
  if (step.mode === 'upper' || step.mode === 'lower' || step.mode === 'title') {
    draft.mode = step.mode
  }
  if (
    step.output === 'DD' ||
    step.output === 'MM' ||
    step.output === 'YYYY' ||
    step.output === 'MM/YYYY' ||
    step.output === 'MM-YYYY' ||
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
    return { operation, delimiter: step.delimiter, index: step.index === '2' ? 2 : 1 }
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
  if ((output === 'MM' || output === 'MM/YYYY' || output === 'MM-YYYY' || output === 'YYYY-MM' || output === 'MMM' || output === 'MMMM') && month === null) {
    throw new Error(`Campo '${fieldKey}': el formato ${output} requiere mes`)
  }
  if ((output === 'YYYY' || output === 'MM/YYYY' || output === 'MM-YYYY' || output === 'YYYY-MM') && year === null) {
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
  if (output === 'MM-YYYY') {
    return `${String(month || 0).padStart(2, '0')}-${String(year || 0).padStart(4, '0')}`
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
    const parts = current.split(step.delimiter)
    if (parts.length < 2) {
      throw new Error(`Campo '${fieldKey}': no se encontro el separador indicado`)
    }
    if (step.index === '2') {
      return parts.slice(1).join(step.delimiter).trim()
    }
    return parts[0].trim()
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

type TemplateFieldFormatEditorProps = {
  fieldKey: string
  steps: TemplateFieldTransformStepDraft[]
  sourceValue: string
  onAddStep: () => void
  onUpdateStep: (stepId: string, updater: (step: TemplateFieldTransformStepDraft) => TemplateFieldTransformStepDraft) => void
  onRemoveStep: (stepId: string) => void
}

function TemplateFieldFormatEditor({
  fieldKey,
  steps,
  sourceValue,
  onAddStep,
  onUpdateStep,
  onRemoveStep,
}: TemplateFieldFormatEditorProps) {
  const preview = buildTransformPipelinePreview(sourceValue, steps, fieldKey)
  const normalizedSourceValue = preview.snapshots[0] || '(vacio)'
  const firstFormatValue =
    steps.length > 0
      ? preview.snapshots[1] || '(vacio)'
      : 'Sin formato aplicado.'

  return (
    <div className="template-field-format-editor">
      <div className="template-field-transform-header">
        <span>Editar valor detectado</span>
        <button
          type="button"
          className="template-transform-add-btn"
          onClick={onAddStep}
          disabled={steps.length >= 3}
          aria-label="Agregar formato"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <div className="template-format-divider" />

      {steps.length === 0 ? (
        <p className="settings-preview">Todavia no agregaste reglas de formato.</p>
      ) : (
        <div className="template-transform-steps">
          {steps.map((step, stepIndex) => (
            <div key={step.id} className="template-transform-step-row">
              <div className="template-transform-step-head">
                <span className="template-transform-step-index">Formato {stepIndex + 1}</span>
                <button type="button" className="link-btn link-btn-danger" onClick={() => onRemoveStep(step.id)}>
                  Quitar
                </button>
              </div>
              <select
                className="year-select"
                value={step.operation}
                onChange={(event) =>
                  onUpdateStep(step.id, (current) => {
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
                    placeholder="Texto a reemplazar"
                    value={step.from}
                    onChange={(event) =>
                      onUpdateStep(step.id, (current) => ({
                        ...current,
                        from: event.target.value,
                      }))
                    }
                  />
                  <input
                    className="settings-input"
                    placeholder="Nuevo texto"
                    value={step.to}
                    onChange={(event) =>
                      onUpdateStep(step.id, (current) => ({
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
                    placeholder="Caracteres a quitar"
                    value={step.chars}
                    onChange={(event) =>
                      onUpdateStep(step.id, (current) => ({
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
                      onUpdateStep(step.id, (current) => ({
                        ...current,
                        delimiter: event.target.value,
                      }))
                    }
                  />
                  <select
                    className="year-select"
                    value={step.index}
                    onChange={(event) =>
                      onUpdateStep(step.id, (current) => ({
                        ...current,
                        index: event.target.value,
                      }))
                    }
                  >
                    <option value="1">Antes del separador</option>
                    <option value="2">Despues del separador</option>
                  </select>
                </div>
              )}

              {step.operation === 'case' && (
                <div className="template-transform-params">
                  <select
                    className="year-select"
                    value={step.mode}
                    onChange={(event) =>
                      onUpdateStep(step.id, (current) => ({
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
                      onUpdateStep(step.id, (current) => ({
                        ...current,
                        output:
                          event.target.value === 'DD' ||
                          event.target.value === 'MM' ||
                          event.target.value === 'YYYY' ||
                          event.target.value === 'MM/YYYY' ||
                          event.target.value === 'MM-YYYY' ||
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

              {step.operation === 'trim' && <p className="settings-preview">Sin parametros.</p>}
            </div>
          ))}
        </div>
      )}

      <div className="template-format-divider" />
      <div className="template-transform-preview">
        <p className="template-transform-preview-title">Vista previa</p>
        <p className="settings-preview">Valor detectado: {normalizedSourceValue}</p>
        <p className="settings-preview">Formato 1: {firstFormatValue}</p>
        {steps.map((step, stepIndex) => (
          stepIndex > 0 ? (
            <p key={`${step.id}-preview-${stepIndex}`} className="settings-preview">
              Formato {stepIndex + 1}: {preview.snapshots[stepIndex + 1] || '(vacio)'}
            </p>
          ) : null
        ))}
        <p className="settings-preview">Resultado: {preview.result || '(vacio)'}</p>
        {preview.error && <p className="settings-hint">{preview.error}</p>}
      </div>
    </div>
  )
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
      const normalizePreviewValue = (value: string) => {
        const trimmed = value.trim()
        if (!trimmed) {
          return ''
        }

        const labelCandidates = [field.label, field.name, field.key]
          .map((candidate) => String(candidate || '').trim())
          .filter(Boolean)

        for (const candidate of labelCandidates) {
          const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const withoutLabel = trimmed.replace(new RegExp(`^${escaped}\\s*:\\s*`, 'i'), '').trim()
          if (withoutLabel !== trimmed) {
            return withoutLabel
          }
        }

        return trimmed
      }

      if (preview.error) {
        return `${normalizePreviewValue(source)} [error]`
      }
      return normalizePreviewValue(preview.result) || fallback
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
  const folderNode = createRuleNodeDraft('folder', fieldOptions, 'create_new')
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
  rootLabel?: string,
): { folders: string[]; fileName: string } {
  const normalizedRootLabel = rootLabel?.trim() || ''
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return {
      folders: normalizedRootLabel ? [normalizedRootLabel] : [],
      fileName: '(archivo)',
    }
  }
  const folderNodes = nodes.slice(0, Math.max(nodes.length - 1, 0))
  const fileNode = nodes[nodes.length - 1] || null
  const folders = folderNodes.map((node) => buildRuleNodePreview(node, fieldOptions))
  if (normalizedRootLabel) {
    folders.unshift(normalizedRootLabel)
  }
  return {
    folders,
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
  const [processingMode, setProcessingMode] = useState<ProcessingMode>('template')
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [selectedPendingFileIds, setSelectedPendingFileIds] = useState<string[]>([])
  const [showProcessModeModal, setShowProcessModeModal] = useState(false)
  const [processItems, setProcessItems] = useState<ProcessItem[]>([])
  const [selectedProcess, setSelectedProcess] = useState<ProcessItem | null>(null)
  const [processPauseCandidate, setProcessPauseCandidate] = useState<ProcessItem | null>(null)
  const [stoppingProcessId, setStoppingProcessId] = useState<string | null>(null)
  const [nominaSelectedGroupId, setNominaSelectedGroupId] = useState('')
  const [nominaFolders, setNominaFolders] = useState<DriveFolder[]>([])
  const [nominaFolderStack, setNominaFolderStack] = useState<DriveFolder[]>([])
  const [nominaFiles, setNominaFiles] = useState<DriveFile[]>([])
  const [nominaLoading, setNominaLoading] = useState(false)
  const [nominaFilesLoading, setNominaFilesLoading] = useState(false)
  const [nominaError, setNominaError] = useState('')
  const [folderSearch, setFolderSearch] = useState('')
  const [folderSort, setFolderSort] = useState<SortOrder>('asc')
  const nominaFolderContentsCacheRef = useRef<Record<string, NominaFolderContentsCacheEntry>>({})
  const templatesCacheRef = useRef<{
    tenantId: string
    includeInactive: boolean
    items: TemplateSummary[]
    loadedAt: number
  } | null>(null)
  const templateGroupsCacheRef = useRef<{
    tenantId: string
    items: TemplateGroup[]
    loadedAt: number
  } | null>(null)

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
  const [templateGroups, setTemplateGroups] = useState<TemplateGroup[]>([])
  const [templateGroupsLoading, setTemplateGroupsLoading] = useState(false)
  const [templateGroupsError, setTemplateGroupsError] = useState('')
  const [showTemplateGroupCreateModal, setShowTemplateGroupCreateModal] = useState(false)
  const [templateGroupDraftName, setTemplateGroupDraftName] = useState('')
  const [templateGroupSaving, setTemplateGroupSaving] = useState(false)
  const [templateGroupCreateError, setTemplateGroupCreateError] = useState('')
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
  const [templateFormatFieldId, setTemplateFormatFieldId] = useState<string | null>(null)
  const [templateFormatDraftSteps, setTemplateFormatDraftSteps] = useState<TemplateFieldTransformStepDraft[]>([])
  const [templateFormatNameDraft, setTemplateFormatNameDraft] = useState('')
  const [templateFormatNameEditing, setTemplateFormatNameEditing] = useState(false)
  const [templateListActionMenuId, setTemplateListActionMenuId] = useState<string | null>(null)
  const [templateListActionMenuPosition, setTemplateListActionMenuPosition] = useState<FloatingMenuPosition | null>(null)
  const [showClassificationRuleModal, setShowClassificationRuleModal] = useState(false)
  const [classificationRuleMandatory, setClassificationRuleMandatory] = useState(false)
  const [classificationRuleLoading, setClassificationRuleLoading] = useState(false)
  const [classificationRuleSaving, setClassificationRuleSaving] = useState(false)
  const [classificationRuleTemplateId, setClassificationRuleTemplateId] = useState('')
  const [classificationRuleTemplateName, setClassificationRuleTemplateName] = useState('')
  const [classificationRuleGroupName, setClassificationRuleGroupName] = useState('')
  const [classificationRuleFieldOptions, setClassificationRuleFieldOptions] = useState<RuleFieldOption[]>([])
  const [classificationRuleNodes, setClassificationRuleNodes] = useState<ClassificationRuleNodeDraft[]>([])
  const [classificationRuleActiveOverlay, setClassificationRuleActiveOverlay] = useState<RuleDragOverlayChipDraft | null>(null)
  const [classificationRuleError, setClassificationRuleError] = useState('')
  const [classificationRuleSuccess, setClassificationRuleSuccess] = useState('')
  const [showClassificationRuleExitConfirmModal, setShowClassificationRuleExitConfirmModal] = useState(false)
  const [cronDateTime, setCronDateTime] = useState('')
  const [retryOnError, setRetryOnError] = useState('0')
  const [notifyOnFailure, setNotifyOnFailure] = useState(false)
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
  const pendingSelectAllRef = useRef<HTMLInputElement | null>(null)
  const processItemsRef = useRef<ProcessItem[]>([])
  const profilePopoverRef = useRef<HTMLDivElement | null>(null)
  const templateListMenuWrapRef = useRef<HTMLDivElement | null>(null)
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
        setIsConnected(false)
        if (showError) {
          setOauthFeedback({
            type: 'error',
            text: response.error || 'No se pudo verificar el estado de OAuth.',
          })
        }
        return false
      }
      const data = response.data
      const connected = Boolean(data?.operable ?? (data?.has_token && data?.valid && !data?.tenant_disabled))
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
    if (!templateSuccess) {
      return
    }
    const timeoutId = window.setTimeout(() => {
      setTemplateSuccess('')
    }, 5000)
    return () => window.clearTimeout(timeoutId)
  }, [templateSuccess])

  const closeTemplateListActionMenu = useCallback(() => {
    setTemplateListActionMenuId(null)
    setTemplateListActionMenuPosition(null)
  }, [])

  const toggleTemplateListActionMenu = useCallback(
    (templateId: string, triggerButton: HTMLButtonElement) => {
      if (templateListActionMenuId === templateId) {
        closeTemplateListActionMenu()
        return
      }

      const rect = triggerButton.getBoundingClientRect()
      const viewportPadding = 12
      const menuWidth = 220
      const menuHeight = 168
      const preferredLeft = rect.right - menuWidth
      const openUp = window.innerHeight - rect.bottom < menuHeight + 12 && rect.top > menuHeight + viewportPadding
      const maxLeft = Math.max(window.innerWidth - menuWidth - viewportPadding, viewportPadding)

      setTemplateListActionMenuPosition({
        left: Math.min(Math.max(preferredLeft, viewportPadding), maxLeft),
        top: openUp ? rect.top - 8 : Math.max(rect.bottom + 8, viewportPadding),
        openUp,
      })
      setTemplateListActionMenuId(templateId)
    },
    [closeTemplateListActionMenu, templateListActionMenuId],
  )

  useEffect(() => {
    if (!templateListActionMenuId) {
      return
    }

    const onDocumentPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target || templateListMenuWrapRef.current?.contains(target)) {
        return
      }
      closeTemplateListActionMenu()
    }

    const onViewportChange = () => {
      closeTemplateListActionMenu()
    }

    document.addEventListener('mousedown', onDocumentPointerDown)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      document.removeEventListener('mousedown', onDocumentPointerDown)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [closeTemplateListActionMenu, templateListActionMenuId])

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

  const loadAutomationRules = useCallback(() => {
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
    async (includeInactive = true, options?: { force?: boolean }): Promise<TemplateSummary[]> => {
      const cached = templatesCacheRef.current
      const canReuseCache =
        !options?.force &&
        cached?.tenantId === tenantId &&
        cached.includeInactive === includeInactive &&
        Date.now() - cached.loadedAt < templateListCacheTtlMs
      if (canReuseCache && cached) {
        setTemplateError('')
        setTemplates(cached.items)
        return cached.items
      }

      setTemplatesLoading(true)
      setTemplateError('')
      const response = await listTemplates(tenantId, includeInactive)
      setTemplatesLoading(false)
      if (!response.ok || !response.data) {
        setTemplates([])
        setTemplateError(response.error || 'No se pudieron cargar las plantillas.')
        return []
      }
      const nextTemplates = response.data.templates || []
      setTemplates(nextTemplates)
      templatesCacheRef.current = {
        tenantId,
        includeInactive,
        items: nextTemplates,
        loadedAt: Date.now(),
      }
      return nextTemplates
    },
    [tenantId],
  )

  const loadTemplateGroupsForTenant = useCallback(async (options?: { force?: boolean; sync?: boolean }): Promise<TemplateGroup[]> => {
    const cached = templateGroupsCacheRef.current
    const canReuseCache =
      !options?.force &&
      !options?.sync &&
      cached?.tenantId === tenantId &&
      Date.now() - cached.loadedAt < templateGroupCacheTtlMs
    if (canReuseCache && cached) {
      setTemplateGroupsError('')
      setTemplateGroups(cached.items)
      return cached.items
    }

    setTemplateGroupsLoading(true)
    setTemplateGroupsError('')
    const response = await listTemplateGroups(tenantId, { sync: options?.sync })
    setTemplateGroupsLoading(false)
    if (!response.ok || !response.data) {
      setTemplateGroups([])
      setTemplateGroupsError(response.error || 'No se pudieron cargar los grupos.')
      return []
    }
    const groups = [...(response.data.groups || [])].sort(compareTemplateGroups)
    setTemplateGroups(groups)
    templateGroupsCacheRef.current = {
      tenantId,
      items: groups,
      loadedAt: Date.now(),
    }
    return groups
  }, [tenantId])

  const resetTemplateEditor = useCallback(() => {
    setEditingTemplateId(null)
    setSelectedDraftFileId('')
    setUploadedTemplateFile(null)
    setTemplateEditor(createEmptyTemplateEditor())
    setTemplateFieldDraft(createEmptyTemplateFieldDraft())
    setTemplatePendingRect(null)
    setTemplateDrawingStart(null)
    setTemplateHoveredFieldId(null)
    setTemplateFormatFieldId(null)
    setTemplateFormatDraftSteps([])
    setTemplateFormatNameDraft('')
    setTemplateFormatNameEditing(false)
    setShowTemplateGroupCreateModal(false)
    setTemplateGroupDraftName('')
    setTemplateGroupSaving(false)
    setTemplateGroupCreateError('')
    closeTemplateListActionMenu()
    setShowTemplateEditorModal(false)
    setTemplateError('')
  }, [closeTemplateListActionMenu])

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
      if (templateGroups.length === 0) {
        await loadTemplateGroupsForTenant()
      }
      setShowTemplateGroupCreateModal(false)
      setTemplateGroupDraftName('')
      setTemplateGroupCreateError('')
      setEditingTemplateId(null)
      setTemplateEditor({
        name: buildTemplateNameFromFile(sourceFileName || 'Nueva plantilla'),
        groupId: '',
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
  }, [loadTemplateGroupsForTenant, pendingFiles, selectedDraftFileId, templateGroups.length, tenantId, uploadedTemplateFile])

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
        if (templateGroups.length === 0) {
          await loadTemplateGroupsForTenant()
        }
        setShowTemplateGroupCreateModal(false)
        setTemplateGroupDraftName('')
        setTemplateGroupCreateError('')
        setEditingTemplateId(templateId)
        setTemplateEditor({
          name: response.data.name,
          groupId: response.data.group_id || '',
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
    [loadTemplateGroupsForTenant, templateGroups.length, tenantId],
  )

  const createTemplateGroupFromModal = useCallback(async () => {
    const normalizedName = templateGroupDraftName.trim()
    if (!normalizedName) {
      setTemplateGroupCreateError('El nombre del grupo es obligatorio.')
      return
    }

    setTemplateGroupSaving(true)
    setTemplateGroupCreateError('')
    const response = await createTemplateGroup(tenantId, normalizedName)
    setTemplateGroupSaving(false)
    if (!response.ok || !response.data?.group) {
      setTemplateGroupCreateError(response.error || 'No se pudo crear el grupo.')
      return
    }

    const createdGroup = response.data.group
    setTemplateGroups((prev) => {
      const nextGroups = [...prev, createdGroup].sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
      templateGroupsCacheRef.current = {
        tenantId,
        items: nextGroups,
        loadedAt: Date.now(),
      }
      return nextGroups
    })
    setTemplateEditor((prev) => ({
      ...prev,
      groupId: createdGroup.group_id,
    }))
    setShowTemplateGroupCreateModal(false)
    setTemplateGroupDraftName('')
    setTemplateGroupCreateError('')
    setTemplateGroupsError('')
  }, [templateGroupDraftName, tenantId])

  const openTemplateGroupCreateModal = useCallback(() => {
    setShowTemplateGroupCreateModal(true)
    setTemplateGroupDraftName('')
    setTemplateGroupCreateError('')
  }, [])

  const handleTemplateGroupChange = useCallback((nextValue: string) => {
    if (nextValue === '__create_group__') {
      openTemplateGroupCreateModal()
      return
    }
    setTemplateEditor((prev) => ({
      ...prev,
      groupId: nextValue,
    }))
    setTemplateError('')
  }, [openTemplateGroupCreateModal])

  const resetClassificationRuleEditor = useCallback(() => {
    setShowClassificationRuleModal(false)
    setClassificationRuleMandatory(false)
    setClassificationRuleLoading(false)
    setClassificationRuleSaving(false)
    setClassificationRuleTemplateId('')
    setClassificationRuleTemplateName('')
    setClassificationRuleGroupName('')
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
      setClassificationRuleGroupName(templateResponse.data.group_name || '')
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
      const folder = createRuleNodeDraft('folder', classificationRuleFieldOptions, 'create_new')
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
    setShowClassificationRuleExitConfirmModal(false)
    resetClassificationRuleEditor()
  }, [resetClassificationRuleEditor])

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
      setShowClassificationRuleExitConfirmModal(true)
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
    await loadTemplatesForTenant(true, { force: true })
    resetClassificationRuleEditor()
  }, [classificationRuleNodes, classificationRuleTemplateId, closeClassificationRuleEditor, loadTemplatesForTenant, resetClassificationRuleEditor, tenantId])

  const saveTemplateEditor = useCallback(async () => {
    if (!templateEditor.name.trim()) {
      setTemplateError('El nombre de la plantilla es obligatorio.')
      return
    }
    if (!templateEditor.groupId.trim()) {
      setTemplateError('Debes seleccionar un grupo para la plantilla.')
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
      group_id: templateEditor.groupId.trim(),
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
      await loadTemplatesForTenant(true, { force: true })
      return
    }

    setTemplateSuccess(isNewTemplate ? 'Plantilla creada.' : 'Plantilla actualizada.')
    await loadTemplatesForTenant(true, { force: true })
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
      closeTemplateListActionMenu()
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
      await loadTemplatesForTenant(true, { force: true })
    },
    [closeTemplateListActionMenu, editingTemplateId, loadTemplatesForTenant, resetTemplateEditor, selectedTemplateId, tenantId],
  )

  const addFieldToTemplate = useCallback(() => {
    if (!templatePendingRect) {
      setTemplateError('Dibuja una zona sobre el PDF antes de agregar el campo.')
      return
    }
    const fieldName = templateFieldDraft.name.trim()
    if (!fieldName) {
      setTemplateError('El nombre del campo es obligatorio.')
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
          label: null,
          suggestedLabel: templateFieldDraft.suggestedLabel.trim() || null,
          type: templateFieldDraft.type,
          rect: templatePendingRect,
          detectedValue: templateFieldDraft.detectedValue.trim() || null,
          sampleValue: templateFieldDraft.detectedValue.trim() || null,
          required: false,
          transforms: [],
        },
      ],
    }))
    setTemplateFieldDraft(createEmptyTemplateFieldDraft())
    setTemplatePendingRect(null)
    setTemplateError('')
    setTemplateSuccess('')
  }, [templateFieldDraft, templatePendingRect])

  const openTemplateFieldFormatModal = useCallback((fieldId: string) => {
    const field = templateEditor.fields.find((current) => current.id === fieldId)
    if (!field) {
      return
    }
    setTemplateFormatFieldId(fieldId)
    setTemplateFormatDraftSteps(field.transforms.map((step) => ({ ...step })))
    setTemplateFormatNameDraft(field.name)
    setTemplateFormatNameEditing(false)
    setTemplateError('')
    setTemplateSuccess('')
  }, [templateEditor.fields])

  const closeTemplateFieldFormatModal = useCallback(() => {
    setTemplateFormatFieldId(null)
    setTemplateFormatDraftSteps([])
    setTemplateFormatNameDraft('')
    setTemplateFormatNameEditing(false)
  }, [])

  const addTemplateFieldFormatDraftStep = useCallback(() => {
    setTemplateFormatDraftSteps((prev) => (prev.length >= 3 ? prev : [...prev, createTransformStepDraft('trim')]))
  }, [])

  const updateTemplateFieldFormatDraftStep = useCallback(
    (stepId: string, updater: (step: TemplateFieldTransformStepDraft) => TemplateFieldTransformStepDraft) => {
      setTemplateFormatDraftSteps((prev) => prev.map((step) => (step.id === stepId ? updater(step) : step)))
    },
    [],
  )

  const removeTemplateFieldFormatDraftStep = useCallback((stepId: string) => {
    setTemplateFormatDraftSteps((prev) => prev.filter((step) => step.id !== stepId))
  }, [])

  const saveTemplateFieldFormat = useCallback(() => {
    if (!templateFormatFieldId) {
      return
    }
    const nextName = templateFormatNameDraft.trim()
    if (!nextName) {
      setTemplateError('El nombre del campo es obligatorio.')
      return
    }
    setTemplateEditor((prev) => ({
      ...prev,
      fields: prev.fields.map((field) =>
        field.id === templateFormatFieldId
          ? {
              ...field,
              name: nextName,
              transforms: templateFormatDraftSteps.slice(0, 3).map((step) => ({ ...step })),
            }
          : field,
      ),
    }))
    setTemplateError('')
    setTemplateSuccess('')
    closeTemplateFieldFormatModal()
  }, [closeTemplateFieldFormatModal, templateFormatDraftSteps, templateFormatFieldId, templateFormatNameDraft])

  const removeTemplateFieldFromEditor = useCallback((fieldId: string) => {
    setTemplateEditor((prev) => ({
      ...prev,
      fields: prev.fields.filter((field) => field.id !== fieldId),
    }))
    if (templateFormatFieldId === fieldId) {
      closeTemplateFieldFormatModal()
    }
    setTemplateError('')
    setTemplateSuccess('')
  }, [closeTemplateFieldFormatModal, templateFormatFieldId])

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
        type: 'string',
        detectedValue: detected,
        suggestedLabel: suggested,
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
        setIsConnected(false)
        setProcessError('Necesitás conectar una cuenta de Google Drive para procesar.')
        setShowConnectRequiredModal(true)
      } else {
        setProcessError('No se pudieron listar los archivos de INPUT.')
      }
      return
    }

    setPendingFiles(response.data?.files ?? [])
  }, [tenantId, isConnected])

  const refreshConfigurationData = useCallback(() => {
    loadAutomationRules()
    void loadPendingFiles()
    void loadTemplateGroupsForTenant()
    void loadTemplatesForTenant(true)
  }, [loadAutomationRules, loadPendingFiles, loadTemplateGroupsForTenant, loadTemplatesForTenant])

  const loadNominaFolderContents = useCallback(
    async (folderId: string) => {
      if (!folderId) {
        setNominaFolders([])
        setNominaFiles([])
        setNominaError('')
        return
      }

      const cachedContents = nominaFolderContentsCacheRef.current[folderId]
      if (cachedContents) {
        setNominaError('')
        setNominaFolders(cachedContents.folders)
        setNominaFiles(cachedContents.files)
        return
      }

      setNominaLoading(true)
      setNominaFilesLoading(true)
      setNominaError('')
      const contentsRes = await listFolderContents(tenantId, folderId)

      if (contentsRes.ok && contentsRes.data) {
        const folders = [...(contentsRes.data.folders ?? [])].sort(compareEmployeeFolders)
        const files = contentsRes.data.files ?? []
        nominaFolderContentsCacheRef.current[folderId] = { folders, files }
        setNominaLoading(false)
        setNominaFilesLoading(false)
        setNominaFolders(folders)
        setNominaFiles(files)
        return
      }

      if (contentsRes.status === 404) {
        const [foldersRes, filesRes] = await Promise.all([listPickerFolders(tenantId, folderId), listFilesInFolder(tenantId, folderId)])
        setNominaLoading(false)
        setNominaFilesLoading(false)

        if (!foldersRes.ok || !filesRes.ok) {
          setNominaError('No se pudieron listar las carpetas y archivos de esta ubicacion.')
          setNominaFolders([])
          setNominaFiles([])
          return
        }

        const folders = [...(foldersRes.data?.folders ?? [])].sort(compareEmployeeFolders)
        const files = (filesRes.data?.files ?? []).filter(
          (item) => item.mimeType !== 'application/vnd.google-apps.folder',
        )
        nominaFolderContentsCacheRef.current[folderId] = { folders, files }
        setNominaFolders(folders)
        setNominaFiles(files)
        return
      }

      setNominaLoading(false)
      setNominaFilesLoading(false)
      if (!contentsRes.ok || !contentsRes.data) {
        setNominaError('No se pudieron listar las carpetas y archivos de esta ubicacion.')
        setNominaFolders([])
        setNominaFiles([])
        return
      }
    },
    [tenantId],
  )

  const loadNominaGroupRoot = useCallback(
    async (groupId: string, groupsOverride?: TemplateGroup[]) => {
      setNominaSelectedGroupId(groupId)
      setNominaFolderStack([])
      setFolderSearch('')
      if (!groupId) {
        setNominaFolders([])
        setNominaFiles([])
        setNominaError('')
        return
      }
      const groups = groupsOverride ?? templateGroups
      const selectedGroup = groups.find((group) => group.group_id === groupId) || null
      if (!selectedGroup?.drive_folder_id) {
        setNominaFolders([])
        setNominaFiles([])
        setNominaError('El grupo seleccionado no tiene carpeta vinculada en Drive.')
        return
      }
      await loadNominaFolderContents(selectedGroup.drive_folder_id)
    },
    [loadNominaFolderContents, templateGroups],
  )

  const loadNominaDocuments = useCallback(async () => {
    if (!isConnected) {
      setShowConnectRequiredModal(true)
      return
    }
    const groups = await loadTemplateGroupsForTenant({ sync: true })
    if (groups.length === 0) {
      setNominaSelectedGroupId('')
      setNominaFolderStack([])
      setNominaFolders([])
      setNominaFiles([])
      setNominaError('')
      return
    }
    const nextGroupId = groups.some((group) => group.group_id === nominaSelectedGroupId)
      ? nominaSelectedGroupId
      : groups[0]?.group_id || ''
    await loadNominaGroupRoot(nextGroupId, groups)
  }, [isConnected, loadNominaGroupRoot, loadTemplateGroupsForTenant, nominaSelectedGroupId])

  const openNominaFolder = useCallback(
    async (folder: DriveFolder) => {
      setNominaFolderStack((prev) => [...prev, folder])
      await loadNominaFolderContents(folder.id)
    },
    [loadNominaFolderContents],
  )

  const goBackNominaFolder = useCallback(async () => {
    if (!nominaSelectedGroupId || nominaFolderStack.length === 0) {
      return
    }
    const nextStack = nominaFolderStack.slice(0, -1)
    setNominaFolderStack(nextStack)
    const currentGroup = templateGroups.find((group) => group.group_id === nominaSelectedGroupId) || null
    const nextFolderId = nextStack[nextStack.length - 1]?.id || currentGroup?.drive_folder_id || ''
    await loadNominaFolderContents(nextFolderId)
  }, [loadNominaFolderContents, nominaFolderStack, nominaSelectedGroupId, templateGroups])

  const refreshPendingFiles = useCallback(() => {
    void loadPendingFiles()
  }, [loadPendingFiles])

  const applySectionChange = useCallback(
    (section: Section, mode: 'push' | 'replace' | 'none' = 'push') => {
      if ((section === 'procesar' || section === 'nomina' || section === 'reportes' || section === 'configuracion') && !isConnected) {
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
    },
    [isConnected, loadTemplatesForTenant, refreshPendingFiles],
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
    if (activeSection !== 'configuracion' || !isConnected) {
      return
    }

    const timer = window.setTimeout(() => {
      refreshConfigurationData()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [activeSection, isConnected, refreshConfigurationData])

  useEffect(() => {
    if (activeSection !== 'nomina' || !isConnected) {
      return
    }

    const timer = window.setTimeout(() => {
      void loadNominaDocuments()
    }, 0)

    return () => window.clearTimeout(timer)
    // Re-run only when entering Documentos, changing tenant, or restoring connection.
    // Avoid reloading while navigating folders or when templateGroups state refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, isConnected, tenantId])

  useEffect(() => {
    if (activeSection !== 'configuracion' || !isConnected) {
      return
    }

    function refreshOnFocus() {
      void loadPendingFiles()
      void loadTemplateGroupsForTenant()
      void loadTemplatesForTenant(true)
    }

    function refreshOnVisibility() {
      if (document.visibilityState === 'visible') {
        refreshOnFocus()
      }
    }

    window.addEventListener('focus', refreshOnFocus)
    document.addEventListener('visibilitychange', refreshOnVisibility)
    return () => {
      window.removeEventListener('focus', refreshOnFocus)
      document.removeEventListener('visibilitychange', refreshOnVisibility)
    }
  }, [activeSection, isConnected, loadPendingFiles, loadTemplateGroupsForTenant, loadTemplatesForTenant])

  useEffect(() => {
    const documentActiveTemplates = templates.filter(
      (template) => template.is_active && resolveTemplateMode(template) === 'document',
    )
    const readyTemplates = documentActiveTemplates.filter((template) => template.rule_status === 'ready')
    const shouldUseTemplateMode = !legacyProcessingFlowEnabled || processingMode === 'template'
    if (documentActiveTemplates.length === 0) {
      if (shouldUseTemplateMode) {
        setSelectedTemplateId('')
      }
      return
    }
    if (selectedTemplateId && readyTemplates.some((template) => template.template_id === selectedTemplateId)) {
      return
    }
    if (shouldUseTemplateMode) {
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
    const availableIds = pendingFiles.map((file) => file.id)
    const availableIdSet = new Set(availableIds)
    setSelectedPendingFileIds((prev) => {
      const filtered = prev.filter((fileId) => availableIdSet.has(fileId))
      if (filtered.length > 0) {
        return filtered
      }
      return availableIds
    })
  }, [pendingFiles])

  useEffect(() => {
    if (!pendingSelectAllRef.current) {
      return
    }
    pendingSelectAllRef.current.indeterminate =
      selectedPendingFileIds.length > 0 && selectedPendingFileIds.length < pendingFiles.length
  }, [pendingFiles.length, selectedPendingFileIds.length])

  useEffect(() => {
    processItemsRef.current = processItems
  }, [processItems])

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
    const resolvedMode = legacyProcessingFlowEnabled ? nextMode : 'template'
    setProcessingMode(resolvedMode)
    setProcessError('')
    if (resolvedMode === 'default') {
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
    if (selectedPendingFileIds.length === 0) {
      setProcessError('Seleccioná al menos un archivo para procesar.')
      return
    }
    setProcessingMode('template')
    const nextProcessingMode: ProcessingMode = 'template'
    if (
      nextProcessingMode === 'template' &&
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

    if (selectedPendingFileIds.length === 0) {
      setProcessError('Seleccioná al menos un archivo para procesar.')
      return
    }

    const effectiveProcessingMode = legacyProcessingFlowEnabled ? processingMode : 'template'

    if (effectiveProcessingMode === 'template' && !selectedTemplateId) {
      setProcessError('Selecciona una plantilla con regla lista para procesar.')
      return
    }
    if (
      effectiveProcessingMode === 'template' &&
      !readyProcessTemplates.some((template) => template.template_id === selectedTemplateId)
    ) {
      setProcessError('La plantilla seleccionada no tiene una regla de clasificacion valida.')
      return
    }

    setProcessError('')
    const response = await ingestDrive(tenantId, {
      processing_mode: effectiveProcessingMode,
      template_id: effectiveProcessingMode === 'template' ? selectedTemplateId : null,
      file_ids: selectedPendingFileIds,
    })

    if (!response.ok || !response.data?.job_id) {
      const lowered = (response.error || '').toLowerCase()
      if (lowered.includes('unlinked') || lowered.includes('oauth')) {
        setIsConnected(false)
        setProcessError('Necesitás conectar una cuenta de Google Drive para procesar.')
        setShowConnectRequiredModal(true)
      } else {
        setProcessError(response.error || 'No se pudo iniciar el proceso.')
      }
      return
    }
    setShowProcessModeModal(false)
    setProcessError('')
    await loadProcessRuns()
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

  const loadProcessRuns = useCallback(async () => {
    const response = await listProcessRuns(tenantId, 10)
    if (!response.ok || !response.data) {
      setProcessError((current) => current || 'No se pudo cargar el historial de procesos.')
      return
    }

    const hadRunning = processItemsRef.current.some((item) => item.state === 'running')
    const nextItems = response.data.items.map(mapProcessRunItem)
    const hasRunning = nextItems.some((item) => item.state === 'running')
    setProcessItems(nextItems)
    setProcessError((current) => (current === 'No se pudo cargar el historial de procesos.' ? '' : current))
    setSelectedProcess((current) => {
      if (!current) {
        return current
      }
      return nextItems.find((item) => item.id === current.id) || current
    })
    if (hadRunning && !hasRunning) {
      void loadPendingFiles()
    }
  }, [loadPendingFiles, tenantId])

  useEffect(() => {
    if (activeSection !== 'procesar' || !isConnected) {
      return
    }
    const timer = window.setTimeout(() => {
      void loadProcessRuns()
    }, 0)
    const interval = window.setInterval(() => {
      void loadProcessRuns()
    }, 5000)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(interval)
    }
  }, [activeSection, isConnected, loadProcessRuns])

  async function requestStopProcess(item: ProcessItem) {
    setStoppingProcessId(item.id)
    const response = await stopJob(item.jobId)
    setStoppingProcessId(null)

    if (!response.ok) {
      setProcessError(response.error || 'No se pudo pausar el proceso.')
      return
    }

    setProcessPauseCandidate(null)
    setProcessError('')
    await loadProcessRuns()
    await loadPendingFiles()
  }

  const latestTerminalProcess = useMemo(() => {
    return processItems
      .filter((item) => item.state === 'success' || item.state === 'error')
      .sort((a, b) => getProcessSortTimestamp(b) - getProcessSortTimestamp(a))[0] ?? null
  }, [processItems])

  const latestMetrics = useMemo(() => extractRunMetrics(latestTerminalProcess?.detail ?? null), [latestTerminalProcess])

  const processedCount = latestMetrics.success ?? 0
  const errorCount = latestMetrics.error ?? 0
  const hasPendingFiles = pendingFiles.length > 0
  const selectedPendingFileSet = useMemo(() => new Set(selectedPendingFileIds), [selectedPendingFileIds])
  const allPendingFilesSelected = hasPendingFiles && selectedPendingFileIds.length === pendingFiles.length
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
  const classificationRuleGroupPathLabel = useMemo(
    () => classificationRuleGroupName.trim() || '(grupo)',
    [classificationRuleGroupName],
  )
  const classificationRulePathPreview = useMemo(
    () =>
      buildRulePathPreview(
        classificationRuleNodes,
        classificationRuleFieldOptions,
        classificationRuleGroupPathLabel,
      ),
    [classificationRuleNodes, classificationRuleFieldOptions, classificationRuleGroupPathLabel],
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
  const templateFormatField = useMemo(
    () => templateEditor.fields.find((field) => field.id === templateFormatFieldId) || null,
    [templateEditor.fields, templateFormatFieldId],
  )
  const templateFormatSourceValue = useMemo(
    () => templateFormatField?.detectedValue || templateFormatField?.sampleValue || '',
    [templateFormatField],
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
  const selectedNominaGroup = useMemo(
    () => templateGroups.find((group) => group.group_id === nominaSelectedGroupId) || null,
    [nominaSelectedGroupId, templateGroups],
  )
  const nominaCurrentPath = useMemo(() => {
    const parts = ['RECIBOX']
    if (selectedNominaGroup?.name) {
      parts.push(selectedNominaGroup.name)
    }
    for (const folder of nominaFolderStack) {
      parts.push(folder.name)
    }
    return parts.join(' > ')
  }, [nominaFolderStack, selectedNominaGroup])
  const visibleNominaFolders = useMemo(() => {
    const query = normalizeSearchText(folderSearch)
    const filtered = nominaFolders.filter((folder) => normalizeSearchText(folder.name).includes(query))
    return [...filtered].sort((a, b) => {
      const cmp = compareEmployeeFolders(a, b)
      return folderSort === 'asc' ? cmp : -cmp
    })
  }, [folderSearch, folderSort, nominaFolders])
  const canGoBackNomina = nominaFolderStack.length > 0
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
                  <span translate="no" className="material-symbols-outlined notranslate">folder</span>
                </span>
                <span>Documentos</span>
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
            <button
              type="button"
              className={`menu-item ${activeSection === 'reportes' ? 'active' : ''}`}
              onClick={() => {
                handleSectionChange('reportes')
                setMobileMenuOpen(false)
              }}
            >
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
                  <span translate="no" className="material-symbols-outlined notranslate">folder</span>
                </span>
                <span>Documentos</span>
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
              className={`menu-item ${activeSection === 'reportes' ? 'active' : ''}`}
              onClick={() => handleSectionChange('reportes')}
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
          <main className="content process-content process-screen">
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
                  <div className="pending-header-actions">
                    <span className="pending-selection-count">
                      {selectedPendingFileIds.length}/{pendingFiles.length} seleccionados
                    </span>
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
                    <button
                      type="button"
                      className="refresh-files-btn pending-folder-btn"
                      onClick={openInputFolder}
                      disabled={processLoading}
                      aria-label="Abrir carpeta INPUT"
                      title="Abrir carpeta INPUT"
                    >
                      <span translate="no" className="material-symbols-outlined notranslate" aria-hidden="true">
                        folder_open
                      </span>
                    </button>
                  </div>
                </div>
                <div className="pending-table-wrapper">
                  <table className="pending-table">
                    <thead>
                      <tr>
                        <th className="pending-check-col">
                          <input
                            ref={pendingSelectAllRef}
                            type="checkbox"
                            checked={allPendingFilesSelected}
                            onChange={(event) => {
                              setProcessError('')
                              setSelectedPendingFileIds(event.target.checked ? pendingFiles.map((file) => file.id) : [])
                            }}
                            disabled={pendingFiles.length === 0 || processLoading}
                            aria-label="Seleccionar todos los archivos pendientes"
                          />
                        </th>
                        <th>Archivo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {processLoading && (
                        <tr>
                          <td colSpan={2}>Cargando archivos...</td>
                        </tr>
                      )}
                      {!processLoading && pendingFiles.length === 0 && !processError && (
                        <tr>
                          <td colSpan={2}>Sin archivos PDF pendientes.</td>
                        </tr>
                      )}
                      {!processLoading &&
                        pendingFiles.map((file) => (
                          <tr key={file.id} className={selectedPendingFileSet.has(file.id) ? 'selected-row' : undefined}>
                            <td className="pending-check-col">
                              <input
                                type="checkbox"
                                checked={selectedPendingFileSet.has(file.id)}
                                onChange={(event) => {
                                  setProcessError('')
                                  setSelectedPendingFileIds((prev) => {
                                    if (event.target.checked) {
                                      return prev.includes(file.id) ? prev : [...prev, file.id]
                                    }
                                    return prev.filter((currentId) => currentId !== file.id)
                                  })
                                }}
                                aria-label={`Seleccionar ${file.name}`}
                              />
                            </td>
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
                    onClick={hasPendingFiles ? openProcessModeSelector : openInputFolder}
                    disabled={processLoading || (hasPendingFiles && selectedPendingFileIds.length === 0)}
                  >
                    {hasPendingFiles ? 'Procesar' : 'Agregar archivos'}
                  </button>
                </div>
                </section>

              <section className="jobs-card" aria-label="Tabla de procesos">
                <div className="jobs-table-wrapper">
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
                          <td colSpan={3} className="jobs-empty-state">
                            Aun no hay historial de procesos ejecutados
                          </td>
                        </tr>
                      )}
                      {processItems.map((item) => (
                        <tr key={item.id}>
                          <td title={item.jobId}>{formatProcessName(item)}</td>
                          <td>
                            <span className={`status ${item.state === 'paused' ? 'paused' : item.state}`}>
                              {item.state === 'running' && <span className="spinner" />}
                              {item.state === 'success' && '✓ '}
                              {item.state === 'error' && '✕ '}
                              {getProcessStateLabel(item.state)}
                            </span>
                          </td>
                          <td>
                            {item.state === 'running' ? (
                              <button
                                type="button"
                                className="link-btn link-btn-danger"
                                onClick={() => setProcessPauseCandidate(item)}
                                disabled={stoppingProcessId === item.id}
                              >
                                {stoppingProcessId === item.id ? 'Pausando...' : 'Pausar'}
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
                </div>
                {processError && <p className="oauth-feedback error">{processError}</p>}
              </section>
            </div>
          </main>
        )}

        {activeSection === 'configuracion' && isConnected && (
          <main className="content process-content settings-screen">
            <section className="section-page-header" aria-label="Encabezado de configuracion">
              <h2>Configuracion</h2>
              <p>Administra plantillas, reglas y automatizacion.</p>
            </section>
            <div className="process-layout settings-layout">
              <div className="settings-cards-grid">
                <section className="pending-card settings-card settings-card-half" aria-label="ABM de plantillas y reglas de procesamiento">
                  <div className="settings-body">
                    <div className="settings-card-header">
                      <h4>Plantillas y reglas de procesamiento</h4>
                      <span className="settings-chip">ABM</span>
                    </div>
                    <p className="settings-preview">
                      Definí plantillas para detectar zonas de un PDF y guardar campos reutilizables. Cada plantilla
                      permite dibujar áreas, validar el valor detectado y asignar un campo editable.
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
                        className="modal-primary template-draft-btn"
                        onClick={() => void createTemplateDraft()}
                        disabled={(!selectedDraftFileId && (!templateLocalUploadEnabled || !uploadedTemplateFile)) || templateDraftLoading}
                      >
                        {templateDraftLoading && <span className="spinner template-draft-btn-spinner" aria-hidden="true" />}
                        {templateDraftLoading ? 'Cargando PDF...' : 'Crear plantilla'}
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
                            <div className="template-saved-main">
                              <strong>{template.name}</strong>
                              <span>
                                Grupo {template.group_name || 'Sin grupo'} ·{' '}
                                {template.is_active ? 'Activa' : 'Inactiva'} · {resolveRuleStatusLabel(template.rule_status)} · Actualizada{' '}
                                {formatDateTime(template.updated_at)}
                              </span>
                            </div>
                            <div
                              ref={templateListActionMenuId === template.template_id ? templateListMenuWrapRef : null}
                              className="template-item-actions template-list-menu-wrap"
                            >
                              <button
                                type="button"
                                className="template-list-menu-trigger"
                                onClick={(event) => toggleTemplateListActionMenu(template.template_id, event.currentTarget)}
                                disabled={templateActionLoadingId === template.template_id}
                                aria-label={`Acciones para ${template.name}`}
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </button>
                              {templateListActionMenuId === template.template_id && templateListActionMenuPosition && (
                                <div
                                  className="template-list-menu"
                                  style={{
                                    top: templateListActionMenuPosition.top,
                                    left: templateListActionMenuPosition.left,
                                    transform: templateListActionMenuPosition.openUp ? 'translateY(-100%)' : undefined,
                                  }}
                                >
                                  <button
                                    type="button"
                                    className="template-list-menu-item"
                                    onClick={() => {
                                      closeTemplateListActionMenu()
                                      void openClassificationRuleEditor(template.template_id, false)
                                    }}
                                    disabled={templateActionLoadingId === template.template_id}
                                  >
                                    Regla de procesamiento
                                  </button>
                                  <button
                                    type="button"
                                    className="template-list-menu-item"
                                    onClick={() => {
                                      closeTemplateListActionMenu()
                                      void loadTemplateIntoEditor(template.template_id)
                                    }}
                                    disabled={templateActionLoadingId === template.template_id}
                                  >
                                    {templateActionLoadingId === template.template_id ? 'Cargando...' : 'Editar plantilla'}
                                  </button>
                                  <button
                                    type="button"
                                    className="template-list-menu-item template-list-menu-item-danger"
                                    onClick={() => void removeTemplate(template.template_id)}
                                    disabled={templateActionLoadingId === template.template_id}
                                  >
                                    Eliminar plantilla
                                  </button>
                                </div>
                              )}
                            </div>
                          </article>
                        ))}
                    </div>
                    {templateError && <p className="oauth-feedback error">{templateError}</p>}
                    {templateSuccess && <p className="oauth-feedback success">{templateSuccess}</p>}
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
              </div>
            </div>
          </main>
        )}

        {activeSection === 'nomina' && isConnected && (
          <main className="content process-content nomina-screen">
            <section className="section-page-header" aria-label="Encabezado de documentos">
              <h2>Documentos</h2>
              <p>Explora grupos, carpetas y archivos almacenados dentro de RECIBOX.</p>
            </section>
            <div className="nomina-grid">
              <div className="nomina-left-col">
                <section className="summary-card nomina-group-card" aria-label="Selector de grupo">
                  <p>Grupo</p>
                  <select
                    className="nomina-group-select"
                    value={nominaSelectedGroupId}
                    onChange={(event) => {
                      void loadNominaGroupRoot(event.target.value)
                    }}
                    disabled={templateGroupsLoading}
                  >
                    <option value="">
                      {templateGroupsLoading
                        ? 'Cargando grupos...'
                        : templateGroups.length === 0
                          ? 'Sin grupos disponibles'
                          : 'Seleccionar grupo'}
                    </option>
                    {templateGroups.map((group) => (
                      <option key={group.group_id} value={group.group_id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                  {templateGroupsError && <span className="summary-card-error">{templateGroupsError}</span>}
                </section>

                <section className="pending-card" aria-label="Tabla de carpetas">
                  <div className="pending-header">
                    <div className="nomina-panel-heading">
                      <h3>Carpetas</h3>
                    </div>
                  </div>
                  <div className="collaborator-toolbar">
                    <div className="collaborator-search-wrap">
                      <span translate="no" className="material-symbols-outlined notranslate collaborator-search-icon" aria-hidden="true">
                        search
                      </span>
                      <input
                        className="collaborator-search"
                        type="text"
                        value={folderSearch}
                        onChange={(event) => setFolderSearch(event.target.value)}
                        placeholder="Buscar carpeta..."
                      />
                    </div>
                    <button
                      type="button"
                      className="sort-btn"
                      onClick={() => setFolderSort((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                      title={folderSort === 'asc' ? 'Orden ascendente' : 'Orden descendente'}
                    >
                      {folderSort === 'asc' ? 'A-Z' : 'Z-A'}
                    </button>
                  </div>
                  <div className="pending-table-wrapper">
                    <table className="pending-table">
                      <tbody>
                        {nominaLoading && (
                          <tr>
                            <td>Cargando carpetas...</td>
                          </tr>
                        )}
                        {!nominaLoading && !nominaSelectedGroupId && !nominaError && (
                          <tr>
                            <td>Selecciona un grupo para ver sus carpetas.</td>
                          </tr>
                        )}
                        {!nominaLoading && nominaSelectedGroupId && nominaFolders.length === 0 && !nominaError && (
                          <tr>
                            <td>No hay archivos en esta ubicacion.</td>
                          </tr>
                        )}
                        {!nominaLoading && nominaFolders.length > 0 && visibleNominaFolders.length === 0 && !nominaError && (
                          <tr>
                            <td>Sin resultados para la busqueda</td>
                          </tr>
                        )}
                        {!nominaLoading &&
                          visibleNominaFolders.map((folder) => (
                            <tr
                              key={folder.id}
                              onClick={() => {
                                void openNominaFolder(folder)
                              }}
                            >
                              <td title={folder.name}>{folder.name}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="process-cta-row">
                    <button type="button" className="add-files-btn" onClick={() => void goBackNominaFolder()} disabled={!canGoBackNomina}>
                      {canGoBackNomina ? 'Volver' : 'Agregar'}
                    </button>
                  </div>
                </section>
              </div>

              <section className="jobs-card" aria-label="Archivos">
                <div className="pending-header">
                  <div className="nomina-panel-heading">
                    <h3>Archivos</h3>
                    <span>{selectedNominaGroup ? nominaCurrentPath : 'Sin grupo seleccionado'}</span>
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
                          <td colSpan={2}>Cargando archivos...</td>
                        </tr>
                      )}
                      {!nominaFilesLoading && !nominaSelectedGroupId && (
                        <tr>
                          <td colSpan={2}>Selecciona un grupo para ver archivos.</td>
                        </tr>
                      )}
                      {!nominaFilesLoading && nominaSelectedGroupId && nominaFiles.length === 0 && (
                        <tr>
                          <td colSpan={2}>Sin archivos en esta ubicacion.</td>
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

        {activeSection === 'reportes' && isConnected && (
          <ReportsScreen
            tenantId={tenantId}
            isConnected={isConnected}
            onRequireConnect={() => setShowConnectRequiredModal(true)}
          />
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

      {showProcessModeModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Elegí una plantilla para procesar tus archivos">
          <div className="modal-card process-mode-modal">
            <h3>Elegí una plantilla para procesar tus archivos</h3>
            <p>Seleccioná la plantilla que se va a usar sobre los archivos marcados.</p>
            {legacyProcessingFlowEnabled && (
              <div className="settings-field">
                <label htmlFor="processing-mode-select-modal">Modo de procesamiento</label>
                <select
                  id="processing-mode-select-modal"
                  className="year-select"
                  value={processingMode}
                  onChange={(event) => changeProcessingMode(event.target.value as ProcessingMode)}
                >
                  <option value="default">Flujo legado</option>
                  <option value="template">Usar plantilla</option>
                </select>
                <p className="settings-hint">
                  El flujo legado no usa grupos ni la estructura nueva `RECIBOX &gt; Grupo &gt; ...`.
                </p>
              </div>
            )}
            {(!legacyProcessingFlowEnabled || processingMode === 'template') && (
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
                        {template.group_name ? ` · ${template.group_name}` : ''}
                        {template.rule_status === 'ready' ? '' : ' (regla incompleta)'}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="process-template-warning">
                  <span className="process-template-warning-chip">
                    <AlertTriangle className="h-4 w-4" />
                    Advertencia
                  </span>
                  <p>
                    Al procesar se realizan cambios en el nombre de los archivos y se clasificaran según la regla de
                    establecida para la plantilla seleccionada.
                  </p>
                </div>
                {readyProcessTemplates.length === 0 ? (
                  <p className="settings-preview">No hay plantillas listas. Completá una regla de clasificacion en Configuracion.</p>
                ) : (
                  <p className="settings-preview">{selectedPendingFileIds.length} archivos seleccionados para procesar.</p>
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
                  selectedPendingFileIds.length === 0 ||
                  ((!legacyProcessingFlowEnabled || processingMode === 'template') &&
                    (!selectedTemplateId || !readyProcessTemplates.some((template) => template.template_id === selectedTemplateId)))
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
              <div className="template-group-select-wrap">
                <select
                  className="year-select template-group-select"
                  value={templateEditor.groupId || ''}
                  onChange={(event) => handleTemplateGroupChange(event.target.value)}
                  disabled={templateSaving || templateGroupsLoading}
                >
                  <option value="">{templateGroupsLoading ? 'Cargando grupos...' : 'Seleccionar grupo'}</option>
                  {templateGroups.map((group) => (
                    <option key={group.group_id} value={group.group_id}>
                      {group.name}
                    </option>
                  ))}
                  <option value="__create_group__">+ Crear grupo...</option>
                </select>
              </div>
              <div className="template-editor-header-actions">
                <button type="button" className="modal-secondary" onClick={resetTemplateEditor} disabled={templateSaving}>
                  Cancelar
                </button>
                <button
                  type="button"
                  className="modal-primary"
                  onClick={() => void saveTemplateEditor()}
                  disabled={templateSaving || !templateEditor.name.trim() || !templateEditor.groupId.trim()}
                >
                  {templateSaving ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </div>
            {(templateGroupsError || (!templateGroupsLoading && templateGroups.length === 0)) && (
              <p className="settings-preview template-group-helper">
                {templateGroupsError || 'No hay grupos creados. Crea uno para poder guardar la plantilla.'}
              </p>
            )}
            <p className="settings-preview">
              Archivo base: {templateEditor.sampleFileName || 'N/D'}
            </p>

            <div className="template-editor-layout">
              <div className="template-canvas-panel">
                <div className="template-canvas-wrapper">
                  {templateEditor.previewImageDataUrl && (
                    <div
                      ref={templateCanvasRef}
                      className="template-canvas-stage"
                      onMouseDown={startTemplateDrawing}
                      onMouseMove={moveTemplateDrawing}
                      onMouseUp={endTemplateDrawing}
                      onMouseLeave={endTemplateDrawing}
                    >
                      <img
                        src={templateEditor.previewImageDataUrl}
                        className="template-canvas-image"
                        alt="PDF de plantilla"
                      />
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
                    </div>
                  )}
                  {!templateEditor.previewImageDataUrl && (
                    <p className="template-canvas-empty">No se pudo cargar la vista previa del PDF.</p>
                  )}
                </div>
                <p className="settings-preview">
                  Para crear un nuevo campo de deteccion de texto, dibuje sobre el PDF haciendo click y arrastrando el
                  mouse.
                </p>
              </div>

              <div className="template-form-panel template-form-panel-inline">
                <div className="settings-field">
                  <label htmlFor="template-field-name">Nombre del campo:</label>
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
                    placeholder="Ej. Total neto"
                  />
                </div>
                <div className="settings-field">
                  <label>Dato detectado:</label>
                  <div className="template-detected-display">
                    {templateFieldDraft.detectedValue.trim()
                      ? templateFieldDraft.detectedValue.replace(/\s+/g, ' ').trim()
                      : 'Dato detectado en la zona'}
                  </div>
                </div>
                <div className="settings-field">
                  <label htmlFor="template-field-type">Tipo de dato:</label>
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
                <div className="settings-actions template-form-actions-row">
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
                          <div className="template-saved-card-header">
                            <div className="template-saved-card-title-wrap">
                              <strong>{field.name}</strong>
                              <p>{field.type}</p>
                            </div>
                            <div className="template-item-actions">
                              <button
                                type="button"
                                className="template-field-edit-btn"
                                onClick={() => openTemplateFieldFormatModal(field.id)}
                                aria-label={`${field.transforms.length > 0 ? 'Editar' : 'Configurar'} formato para ${field.name}`}
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                className="template-field-delete-btn"
                                onClick={() => removeTemplateFieldFromEditor(field.id)}
                                aria-label={`Eliminar ${field.name}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                          <div className="template-saved-summary-grid">
                            {field.transforms.length > 0 ? (
                              <p className="template-saved-summary-item template-saved-summary-item-result">
                                <strong>{preview.result || '(vacio)'}</strong>
                              </p>
                            ) : (
                              <p className="template-saved-empty-state">{sourceValue || 'Sin valor detectado'}</p>
                            )}
                          </div>
                          {preview.error && <p className="settings-hint">{preview.error}</p>}
                        </div>
                      </article>
                    )
                  })}
                </div>
              </div>
            </div>

            {templateError && <p className="oauth-feedback error">{templateError}</p>}
          </div>
          {showTemplateGroupCreateModal && (
            <div
              className="template-group-create-overlay"
              role="dialog"
              aria-modal="true"
              aria-label="Crear grupo"
              onClick={() => {
                if (templateGroupSaving) {
                  return
                }
                setShowTemplateGroupCreateModal(false)
                setTemplateGroupDraftName('')
                setTemplateGroupCreateError('')
              }}
            >
              <div className="template-group-create-card" onClick={(event) => event.stopPropagation()}>
                <h3>Crear grupo</h3>
                <p>Los archivos procesados se clasifican segun las plantillas agrupadas.</p>
                <input
                  className="settings-input"
                  value={templateGroupDraftName}
                  onChange={(event) => setTemplateGroupDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void createTemplateGroupFromModal()
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setShowTemplateGroupCreateModal(false)
                      setTemplateGroupDraftName('')
                      setTemplateGroupCreateError('')
                    }
                  }}
                  placeholder="Nombre del grupo"
                  autoFocus
                  disabled={templateGroupSaving}
                />
                {templateGroupCreateError && <p className="oauth-feedback error">{templateGroupCreateError}</p>}
                <div className="template-group-create-actions">
                  <button
                    type="button"
                    className="modal-secondary"
                    onClick={() => {
                      setShowTemplateGroupCreateModal(false)
                      setTemplateGroupDraftName('')
                      setTemplateGroupCreateError('')
                    }}
                    disabled={templateGroupSaving}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="modal-primary"
                    onClick={() => void createTemplateGroupFromModal()}
                    disabled={templateGroupSaving}
                  >
                    {templateGroupSaving ? 'Guardando...' : 'Guardar'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {showTemplateEditorModal && templateFormatField && (
        <div className="modal-overlay template-format-modal-overlay" role="dialog" aria-modal="true" aria-label="Configurar formato">
          <div className="modal-card template-format-modal-card">
            <div className="template-format-modal-header">
              <div>
                <h3>Formato de campo</h3>
                <p>
                  Al crear un campo, te mostraremos el posible valor detectado, podes aplicar reglas para darle el
                  formato adecuado a tu campo.
                </p>
              </div>
              <button
                type="button"
                className="template-format-modal-close"
                onClick={closeTemplateFieldFormatModal}
                aria-label="Cerrar configuracion de formato"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="template-format-modal-body">
              <div className="template-format-divider" />
              <div className="template-format-modal-summary">
                <div className="template-format-detail-row">
                  <span className="template-format-detail-label">Campo:</span>
                  <div className="template-format-detail-value-wrap">
                    {templateFormatNameEditing ? (
                      <input
                        className="settings-input template-format-name-input"
                        value={templateFormatNameDraft}
                        onChange={(event) => setTemplateFormatNameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            setTemplateFormatNameEditing(false)
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            setTemplateFormatNameDraft(templateFormatField.name)
                            setTemplateFormatNameEditing(false)
                          }
                        }}
                        autoFocus
                      />
                    ) : (
                      <strong>{templateFormatNameDraft || templateFormatField.name}</strong>
                    )}
                    <button
                      type="button"
                      className="template-format-inline-action"
                      onClick={() => {
                        if (templateFormatNameEditing) {
                          setTemplateFormatNameEditing(false)
                          return
                        }
                        setTemplateFormatNameEditing(true)
                      }}
                      aria-label="Editar nombre del campo"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <p className="template-format-detail-row">
                  <span className="template-format-detail-label">Valor detectado:</span>
                  <strong>{templateFormatSourceValue || 'Sin valor detectado'}</strong>
                </p>
              </div>

              <TemplateFieldFormatEditor
                fieldKey={templateFormatField.key}
                steps={templateFormatDraftSteps}
                sourceValue={templateFormatSourceValue}
                onAddStep={addTemplateFieldFormatDraftStep}
                onUpdateStep={updateTemplateFieldFormatDraftStep}
                onRemoveStep={removeTemplateFieldFormatDraftStep}
              />
            </div>

            <div className="modal-actions">
              <button type="button" className="modal-secondary" onClick={closeTemplateFieldFormatModal}>
                Cancelar
              </button>
              <button type="button" className="modal-primary" onClick={saveTemplateFieldFormat}>
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {showClassificationRuleModal && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center overflow-y-auto bg-slate-900/35 p-2.5 backdrop-blur-[1px]" role="dialog" aria-modal="true" aria-label="Editor de regla de clasificacion">
          <div className="flex h-[min(92vh,900px)] w-full max-w-[1280px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
            <header className="flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 md:px-5">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#3a5f0b] text-white">
                  <SlidersHorizontal className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-extrabold tracking-tight text-slate-800 md:text-[22px]">Configurar Regla de Procesamiento</h3>
                    {classificationRuleMandatory && <span className="inline-flex h-6 items-center rounded-full border border-blue-200 bg-blue-50 px-2 text-[11px] font-bold text-blue-700">Obligatorio</span>}
                  </div>
                  <p className="w-full text-xs leading-relaxed text-slate-500">
                    Elegi como queres procesar tus archivos en base a los campos seleccionados de una plantilla. Podes definir cuando se crea una o mas carpeta, y cual sera el nombre de los directorios y el archivo procesado
                  </p>
                  <p className="text-xs text-slate-500">
                    Plantilla seleccionada: <strong className="text-slate-700">{classificationRuleTemplateLabel}</strong>
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
                        <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                        <span className="text-[13px] font-semibold text-slate-600">{classificationRuleGroupPathLabel}</span>
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

            <footer className="grid grid-cols-1 gap-3 border-t border-slate-200 bg-slate-100/90 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end md:gap-5 md:px-5">
              <div className="min-w-0">
                <p className="text-[11px] font-extrabold uppercase tracking-[0.2em] text-slate-600">Vista previa</p>
                <div className="mt-1.5 flex w-full flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-[13px] font-semibold text-slate-700">
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

              <div className="flex shrink-0 items-center justify-end gap-2.5">
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
                  {classificationRuleSaving ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}

      {showClassificationRuleExitConfirmModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Salir sin guardar cambios">
          <div className="modal-card">
            <h3>Salir sin guardar cambios</h3>
            <p>Hay niveles sin configurar. Si salis ahora, se perderan los cambios no guardados.</p>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-secondary"
                onClick={() => setShowClassificationRuleExitConfirmModal(false)}
                disabled={classificationRuleSaving}
              >
                Continuar editando
              </button>
              <button
                type="button"
                className="modal-primary"
                onClick={closeClassificationRuleEditor}
                disabled={classificationRuleSaving}
              >
                Salir sin guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {processPauseCandidate && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirmar pausa del proceso">
          <div className="modal-card">
            <h3>Confirmar pausa</h3>
            <p>Se va a pausar el proceso seleccionado. Esta accion detiene la ejecucion actual.</p>
            <p>
              <strong>{formatProcessName(processPauseCandidate)}</strong>
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-secondary"
                onClick={() => setProcessPauseCandidate(null)}
                disabled={stoppingProcessId === processPauseCandidate.id}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="modal-primary"
                onClick={() => void requestStopProcess(processPauseCandidate)}
                disabled={stoppingProcessId === processPauseCandidate.id}
              >
                {stoppingProcessId === processPauseCandidate.id ? 'Pausando...' : 'Confirmar pausa'}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedProcess && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Detalle del proceso">
          <div className="modal-card process-detail-modal">
            <h3>Detalle del proceso</h3>
            <p><strong>Proceso:</strong> {formatProcessName(selectedProcess)}</p>
            <p>
              <strong>Estado:</strong>{' '}
              <span className={`status process-detail-status ${selectedProcess.state}`}>
                {selectedProcess.state === 'running' && <span className="spinner" />}
                {selectedProcess.state === 'success' && '✓ '}
                {selectedProcess.state === 'error' && '✕ '}
                {getProcessStateLabel(selectedProcess.state)}
              </span>
            </p>
            <p><strong>Duración:</strong> {formatDuration(selectedProcess.detail?.duration_seconds)}</p>
            <p><strong>Total procesados:</strong> {extractRunMetrics(selectedProcess.detail).totalProcessed ?? 'N/D'}</p>
            <p><strong>Exitosos:</strong> {extractRunMetrics(selectedProcess.detail).success ?? 'N/D'}</p>
            <p><strong>Errores:</strong> {extractRunMetrics(selectedProcess.detail).error ?? 'N/D'}</p>
            <p>
              <strong>Mensaje:</strong>{' '}
              {selectedProcess.state === 'paused'
                ? 'Proceso pausado por el usuario'
                : extractRunMetrics(selectedProcess.detail).message ?? 'N/D'}
            </p>
            <p><strong>Creado:</strong> {formatDateTime(selectedProcess.createdAtIso || selectedProcess.detail?.created_at)}</p>
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
