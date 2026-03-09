# RECIBOX Backend

Backend que replica el flujo funcional de RECIBOX:

- Input: obtiene PDFs desde Google Drive (más adelante S3).
- Process: extrae texto y metadata localmente desde el PDF y clasifica.
- Output: renombra y mueve el archivo al destino correcto en el storage.
- APIs: expone endpoints para integración con frontend y control del procesamiento.

## Monolito modular

El backend se mantiene como monolito modular para reducir complejidad operativa,
pero con límites claros por dominio para permitir extraer microservicios en el futuro.

Módulos previstos:
- `services/` (storage, procesamiento de PDF, clasificación)
- `mcp/` (integraciones con IA/MCP; pensado para separarse luego)

## Arquitectura por bloques

- Ingesta
  - Drive Poller o Webhook (push notifications).
  - Lista archivos nuevos en la carpeta INPUT.
- Procesamiento
  - Descarga PDF.
  - Extracción local (pdfplumber/PyMuPDF) y parseo de campos.
  - Clasificación a carpeta por Empleado/Año/Mes.
- Salida
  - Move + rename en Drive.
  - Registro de estado y trazabilidad.
- API
  - Disparar ingestión, ver estado de trabajos, reintentos.

## Primeros pasos

1) Crear `.env` desde `.env.example`.
2) Instalar dependencias.
3) Ejecutar API.

## Configuración Google Drive

Modo recomendado: OAuth por tenant (sin service account).

Configurar `.env` con:
- (Opcional fallback legado) `GOOGLE_APPLICATION_CREDENTIALS`
- (Opcional fallback) `DRIVE_INPUT_FOLDER_ID`
- (Opcional fallback) `DRIVE_ROOT_FOLDER_ID`
- (Opcional) `GOOGLE_SUBJECT` si usas delegación de dominio.

## OAuth 2.0 (usuario final por tenant)

Modo recomendado para usuarios finales. Cada tenant autoriza su propio acceso.

1) Crear credenciales OAuth 2.0 tipo "Web application".
2) Configurar `.env` con:
   - `GOOGLE_OAUTH_CLIENT_SECRETS`
   - `GOOGLE_OAUTH_REDIRECT_URI`
   - `GOOGLE_OAUTH_TOKEN_DIR`
3) Iniciar el flujo:
```
GET /auth/google/login?tenant_id=acme
```
4) Google redirige al callback y guarda el token del tenant:
```
GET /auth/google/callback?code=...&state=acme
```

Si `OAUTH_REQUIRED_FOR_TENANT=true`, el backend bloqueara el uso de service account
para tenants sin token OAuth.

## Configuracion de carpetas por tenant (Redis, MVP)

Despues del login OAuth, cada tenant puede elegir o crear sus carpetas de Drive y
guardar los IDs sin tocar `.env`.

1) Listar carpetas para seleccionar:
```
GET /drive/picker/folders?tenant_id=acme&parent_id=root
```
2) Crear carpeta nueva (opcional):
```
POST /drive/picker/folders?tenant_id=acme
{
  "parent_id": "<ID_PADRE>",
  "name": "RECIBOX ACME"
}
```
3) Guardar configuracion del tenant:
```
PUT /tenants/acme/drive-config
{
  "drive_input_folder_id": "<ID_INPUT>",
  "drive_root_folder_id": "<ID_ROOT_PARENT>",
  "drive_recibox_folder_id": "<ID_RECIBOX>"
}
```
4) Leer configuracion actual:
```
GET /tenants/acme/drive-config
```

Si no hay configuracion custom del tenant, el sistema puede usar fallback de:
- `DRIVE_INPUT_FOLDER_ID`
- `DRIVE_ROOT_FOLDER_ID`

Si esos fallback no estan definidos, el tenant debe configurar carpetas antes de usar endpoints de Drive.

Recomendado en multi-tenant:
- `drive_root_folder_id`: carpeta padre elegida por el usuario (ej: `root`)
- `drive_recibox_folder_id`: carpeta `RECIBOX` donde viven empleados/anios
- `drive_input_folder_id`: carpeta `#0 INPUT`

## Dev vs Prod

- Dev: usar `backend/.env`.
- Prod: usar variables/mounts en `docker-compose.backend.prod.yml` (o UI de EasyPanel).

En ambos casos, la app dentro del contenedor debe leer rutas internas como:
- `/run/secrets/firebase-admin.json`
- `/run/oauth-secrets/oauth-client.json`

Para prod con OAuth por tenant:
- `OAUTH_REQUIRED_FOR_TENANT=true`
- `GOOGLE_OAUTH_REDIRECT_URI=https://api.recibox.com.ar/auth/google/callback`

## Prueba rápida de conexión

Desde `backend/`:

```bash
python -m scripts.drive_smoke_test --limit 5
python -m scripts.drive_smoke_test --download
```

## Cola de procesamiento (RQ + Redis)

Para ejecutar en background:

1) Levantar Redis (local o en server).
2) Iniciar worker:
```bash
rq worker recibox
```
3) Disparar el job vía API:
```
POST /ingest/drive?tenant_id=default
```

4) Consultar estado:
```
GET /jobs/{job_id}
```

5) Detener un job:
```
POST /jobs/{job_id}/stop
```

## Listar archivos de Drive

```
GET /drive/files
```

## TODO

- Elegir mecanismo de sync (poller vs webhook).
- Ajustar extractor con layouts reales de PDFs.
- Definir estrategia de persistencia de estado (SQLite o Postgres).
