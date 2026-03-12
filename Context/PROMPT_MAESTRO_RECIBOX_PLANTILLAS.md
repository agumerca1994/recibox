# Prompt Maestro: Replicar Módulo de Plantillas en Recibox (Paridad Actual, Stack Agnóstico)

Usa este prompt tal cual en otro agente/LLM para implementar la funcionalidad.

```text
Actúa como un Staff Engineer especializado en backend+frontend para OCR/parseo documental.
Tu tarea es implementar en Recibox una funcionalidad de “Plantillas” con paridad funcional respecto de un generador existente. Debes entregar implementación completa, sin dejar decisiones abiertas.

OBJETIVO
Implementar un módulo de plantillas para facturas que permita:
1) autenticación simple para proteger endpoints,
2) CRUD de plantillas con zonas (rectángulos normalizados),
3) almacenamiento/recuperación de PDF base por plantilla,
4) generación de código parser a partir de la plantilla,
5) aplicación de plantilla sobre un PDF para extraer valores por coordenadas.

ALCANCE Y RESTRICCIONES
- Paridad funcional actual (sin agregar mejoras no pedidas).
- Diseño agnóstico de stack, pero conservando contratos y lógica.
- Mantener estos contratos públicos exactos (rutas, payloads, estados HTTP).
- Entregar código productivo + pruebas + criterios de aceptación cumplidos.

================================================================
1) ARQUITECTURA FUNCIONAL (4 BLOQUES)
================================================================

A. AUTH (sesión por cookie HttpOnly)
- Login por usuario/clave configurables por entorno.
- Cookie firmada (HMAC SHA-256) con expiración (TTL 12h).
- Endpoints protegidos de plantillas deben requerir sesión válida.
- Si no hay sesión: responder 401 con mensaje de no autorizado.

B. TEMPLATES CRUD
- Persistencia por archivo:
  - una plantilla por JSON: {id}.json
  - carpeta dedicada de plantillas
- Campos principales de plantilla:
  - id, provider, providerCuit, createdAt, updatedAt, sourceFileName, pageSize, fields[]
- Validaciones:
  - provider obligatorio
  - fields obligatorio y no vacío
- Normalizaciones obligatorias:
  - field.name trim
  - field.type solo: string|number|date|array; fallback string
  - rect:
    - page fijo en 1
    - x,y,w,h clamp en rango [0..1]
  - label/valuePattern/sampleValue trim o null

C. PDF BASE POR PLANTILLA
- Upload de PDF base asociado a plantilla: {id}.pdf
- Lectura de PDF base:
  1) buscar primero {id}.pdf en carpeta de plantillas
  2) fallback: usar sourceFileName guardado en JSON y buscar archivo por nombre
     - primero en directorios candidatos
     - luego búsqueda recursiva en contexto documental
  3) si no existe, responder 404

D. GENERATE-CODE-TEMPLATE
- Input: templateId
- Cargar plantilla y construir código parser (formato n8n-style JS) desde fields.
- Respuesta incluye:
  - provider
  - confidence
  - fields (con detectedValue de sampleValue)
  - code (string con parser generado)
  - quality opcional (si hay issues)

================================================================
2) CONTRATOS DE API (REQUEST/RESPONSE/ERRORES)
================================================================

2.1 POST /api/auth/login
Request JSON:
{
  "username": "string",
  "password": "string"
}
Reglas:
- Si credenciales inválidas: 401 { "error": "Usuario o clave inválidos." }
- Si ok: 200 { "ok": true } + Set-Cookie HttpOnly de sesión
- Error interno: 500 { "error": "No se pudo iniciar sesión." }

2.2 POST /api/auth/logout
Request: sin body obligatorio
Response:
- 200 { "ok": true } y cookie invalidada (maxAge 0)

2.3 GET /api/auth/session
Response:
- si no autenticado: 200 { "authenticated": false }
- si autenticado: 200 { "authenticated": true, "username": "<configured-user>" }

2.4 GET /api/templates (protegido)
Response 200:
{
  "templates": [
    {
      "id": "string",
      "provider": "string",
      "providerCuit": "string|null",
      "createdAt": "ISO date",
      "updatedAt": "ISO date|null"
    }
  ]
}
Errores:
- 401 no autorizado

2.5 POST /api/templates (protegido)
Request JSON:
{
  "provider": "string",
  "providerCuit": "string|null",
  "fields": [TemplateField],
  "sourceFileName": "string|null",
  "pageSize": { "width": number, "height": number } | null
}
Response 200:
{
  "template": Template
}
Errores:
- 400 provider faltante
- 400 fields vacío
- 401 no autorizado
- 500 error guardando

2.6 GET /api/templates/:id (protegido)
Response 200:
{
  "template": Template
}
Errores:
- 401 no autorizado
- 404 plantilla no encontrada

2.7 PUT /api/templates/:id (protegido)
Request JSON (mismo shape que POST /api/templates)
Reglas:
- conservar createdAt previo
- actualizar updatedAt
- conservar id original
- sourceFileName/pageSize: tomar payload si viene, sino conservar previo
Response 200:
{
  "template": Template
}
Errores:
- 400 provider faltante
- 400 fields vacío
- 401 no autorizado
- 404 plantilla no encontrada
- 500 error actualización

2.8 GET /api/templates/:id/source-pdf (protegido)
Response:
- 200 binary PDF (Content-Type: application/pdf)
Errores:
- 401 no autorizado
- 404 plantilla no encontrada
- 404 sin sourceFileName / PDF no localizado
- 500 error lectura

2.9 POST /api/templates/:id/source-pdf (protegido)
Request multipart/form-data:
- file: PDF
Reglas:
- validar que plantilla exista
- validar archivo recibido
- validar MIME application/pdf
- guardar como {id}.pdf
Response:
- 200 { "ok": true }
Errores:
- 400 archivo faltante
- 400 tipo inválido
- 401 no autorizado
- 404 plantilla no encontrada
- 500 error guardado

2.10 POST /api/generate-code-template (protegido)
Request JSON:
{
  "templateId": "string"
}
Response 200 (GeneratedCode):
{
  "provider": "string",
  "confidence": number,
  "fields": [InvoiceField],
  "code": "string",
  "quality": QualityBreakdown?
}
Errores:
- 400 templateId requerido
- 401 no autorizado
- 404 plantilla no encontrada
- 500 no se pudo generar código

================================================================
3) TIPOS/INTERFACES OBLIGATORIOS
================================================================

Define (o equivalente) estos tipos:

type InvoiceFieldType = "string" | "number" | "date" | "array";

interface TemplateRect {
  page: number; // siempre 1 en normalización
  x: number;    // 0..1
  y: number;    // 0..1
  w: number;    // 0..1
  h: number;    // 0..1
}

interface TemplateField {
  name: string;
  type: InvoiceFieldType;
  rect: TemplateRect;
  label?: string | null;
  valuePattern?: string | null;
  sampleValue?: string | null;
}

interface Template {
  id: string;
  provider: string;
  providerCuit?: string | null;
  createdAt: string;
  updatedAt?: string;
  sourceFileName?: string | null;
  pageSize?: { width: number; height: number } | null;
  fields: TemplateField[];
}

interface InvoiceField {
  field: string;
  label: string;
  detectedValue: string;
  type: InvoiceFieldType;
}

interface QualityBreakdown {
  profile: string;
  modelScore: number;
  familyScore: number;
  extractionQuality: number;
  structureScore: number;
  coverageScore: number;
  valueScore: number;
  issues: string[];
}

interface GeneratedCode {
  provider: string;
  confidence: number;
  fields: InvoiceField[];
  code: string;
  quality?: QualityBreakdown;
}

================================================================
4) FLUJOS END-TO-END
================================================================

Flujo A: Crear plantilla
1) Usuario sube PDF base.
2) Renderizar primera página y extraer items de texto con coordenadas.
3) Usuario dibuja rectángulo.
4) Detectar sampleValue dentro del rectángulo por intersección geométrica.
5) Detectar label sugerido:
   - primero texto a la izquierda en misma línea,
   - si no hay, texto por encima con solapamiento en X.
6) Usuario asigna nombre de campo y tipo.
7) Generar TemplateField con rect normalizado + valuePattern por tipo/campo.
8) Guardar plantilla (JSON) y luego subir PDF base asociado.

Flujo B: Editar plantilla
1) Seleccionar plantilla existente.
2) Cargar JSON de plantilla.
3) Intentar cargar PDF base:
   - primero {id}.pdf,
   - fallback por sourceFileName.
4) Permitir ajustar provider/cuit/campos y guardar vía PUT.
5) Si usuario sube nuevo PDF base, persistir reemplazo.

Flujo C: Aplicar plantilla
1) Seleccionar plantilla.
2) Subir PDF a procesar.
3) Renderizar PDF + texto con coordenadas.
4) Para cada field.rect de la plantilla, extraer texto por zona.
5) Normalizar valor por tipo y nombre de campo.
6) Mostrar tabla de valores extraídos.

Flujo D: Generar código desde plantilla
1) Enviar templateId a endpoint de generación.
2) Backend construye parser JS:
   - regex por campo usando label + valuePattern
   - normalizadores de CUIT, número y fecha
3) Devolver code + metadata de calidad/confianza.

================================================================
5) LÓGICAS DE NEGOCIO QUE NO SE PUEDEN CAMBIAR
================================================================

5.1 Extracción por rectángulo
- Seleccionar text items con superposición X/Y con el rectángulo.
- Ordenar por Y, luego X.
- Agrupar por líneas con threshold de proximidad vertical (~6 px).
- Unir tokens por línea con espacio y líneas con salto.
- Limpiar espacios redundantes.

5.2 Detección de etiqueta
- Buscar primero item a la izquierda del rectángulo en la misma línea (por Y media).
- Si existe, tomar el más cercano (máximo X).
- Si no, buscar item por encima con solapamiento horizontal y tomar el más cercano (máximo Y).
- Limpiar sufijos ":" o "-".

5.3 Heurísticas valuePattern
- Si el nombre del campo contiene “cuit” (case-insensitive):
  "\\b\\d{2}-?\\d{8}-?\\d\\b|\\b\\d{11}\\b"
- date:
  "\\b\\d{2}[\\/\\.-]\\d{2}[\\/\\.-]\\d{2,4}\\b"
- number:
  "\\b\\d{1,3}(?:[\\.\\s]\\d{3})*(?:,\\d{2})\\b|\\b\\d+(?:[\\.,]\\d+)?\\b"
- default string:
  "[^\\n]+"

5.4 Normalización de valores
- CUIT: solo dígitos; válido si 11 dígitos.
- Fecha: dd/mm/yy o dd/mm/yyyy (soportar / . -), convertir año de 2 dígitos:
  - <=79 => 2000+yy
  - >79 => 1900+yy
- Número: soportar miles/decimales mixtos con punto/coma y símbolos.

5.5 Confianza e issues en generate-code-template
- missingLabels = cantidad de fields sin label
- confidence = max(35, round(85 - missingLabels * 12))
- issues: por cada field sin label, agregar:
  "Campo <name> sin etiqueta: se usa patron global."
- quality se incluye solo si hay issues.

================================================================
6) CONTRATOS PÚBLICOS DE ALMACENAMIENTO Y SALIDA
================================================================

Storage contract
- Plantilla: un JSON por id => {id}.json
- PDF base opcional asociado => {id}.pdf

Template payload contract
- provider
- providerCuit
- fields[]
- sourceFileName
- pageSize

Generated output contract
- provider
- confidence
- fields[]
- code
- quality? (opcional)

================================================================
7) CRITERIOS DE ACEPTACIÓN
================================================================

Debe cumplirse todo:
1) Endpoints y estados HTTP se comportan exactamente según contrato.
2) Toda ruta de plantillas/generación desde plantilla exige sesión.
3) Rectángulos se guardan normalizados [0..1], page=1.
4) Crear/editar plantilla persiste correctamente JSON y, cuando corresponda, PDF base.
5) Aplicar plantilla extrae valores por coordenadas con la lógica definida.
6) Generar código devuelve parser ejecutable con regex+normalizadores.
7) Cálculo de confidence/issues coincide con reglas definidas.

================================================================
8) PLAN DE PRUEBAS MÍNIMO (OBLIGATORIO)
================================================================

Implementa tests automáticos (unit/integration/e2e según stack) para:
1) Crear plantilla válida con fields + PDF base y verificar persistencia/listado.
2) Editar plantilla y validar que createdAt se conserva y updatedAt cambia.
3) GET source-pdf:
   - caso directo por {id}.pdf
   - caso fallback por sourceFileName
4) Aplicar plantilla sobre PDF y validar extracción por zonas.
5) Generar código desde plantilla y validar normalización de fecha/número/CUIT.
6) Errores esperados:
   - 401 no auth
   - 404 template inexistente
   - 400 payload inválido
   - 400 PDF inválido
   - 500 error interno controlado

================================================================
9) CHECKLIST DE IMPLEMENTACIÓN (ENTREGAR COMO “DONE”)
================================================================

- [ ] Auth por cookie HttpOnly implementado y validado.
- [ ] Protección de endpoints de plantillas activa.
- [ ] Tipos/contratos públicos implementados.
- [ ] CRUD de plantillas con normalización obligatoria.
- [ ] Gestión de PDF base por plantilla + fallback por nombre.
- [ ] Flujo UI crear/editar/aplicar plantilla operativo.
- [ ] Generación de código desde template operativa.
- [ ] Tests mínimos pasando.
- [ ] Documentación breve de uso y límites operativos.

FORMATO DE ENTREGA DEL TRABAJO
- Entrega cambios de código completos.
- Incluye listado de archivos modificados/creados.
- Incluye evidencia de pruebas ejecutadas y resultados.
- Si algo no se pudo implementar, indícalo explícitamente con causa y workaround.
```
