# RECIBOX en EasyPanel (Proyecto 1)

Este stack levanta RECIBOX como servicios separados dentro del mismo proyecto:

- `recibox-api` (FastAPI)
- `recibox-worker` (RQ worker)
- `recibox-redis` (Redis para la cola)

Archivo base: `deploy/easypanel/docker-compose.yml`.

## 1) Crear stack en el proyecto 1

1. En EasyPanel, entra al proyecto 1.
2. Crea un nuevo servicio tipo Compose/Stack.
3. Pega el contenido de `deploy/easypanel/docker-compose.yml`.

## 2) Secretos (no subir a Git)

Necesitas dos archivos JSON en el host del servidor:

- `service-account.json`
- `client_secret_*.apps.googleusercontent.com.json` (OAuth client)

El compose los monta como:

- `/run/secrets/service-account.json`
- `/run/secrets/oauth-client.json`

Si cambias sus rutas en EasyPanel, actualiza también:

- `GOOGLE_APPLICATION_CREDENTIALS`
- `GOOGLE_OAUTH_CLIENT_SECRETS`

## 3) Variables obligatorias a ajustar

- `GOOGLE_OAUTH_REDIRECT_URI`

Sugerido para prod OAuth por tenant:

- `OAUTH_REQUIRED_FOR_TENANT=true`
- `OCR_ENABLED=false`

Opcional (fallback global, no recomendado en multi-tenant):

- `DRIVE_INPUT_FOLDER_ID`
- `DRIVE_ROOT_FOLDER_ID`

## 4) Dominio y healthcheck

- Publica `recibox-api` con dominio/subdominio (ejemplo: `api.tudominio.com`).
- Prueba: `GET /health`

## 5) Flujo mínimo de prueba

1. `GET /health`
2. `GET /auth/google/login?tenant_id=default`
3. Completar consentimiento de Google (se guarda token en `tmp/google_tokens`).
4. Elegir/crear carpeta:
   - `GET /drive/picker/folders?tenant_id=default&parent_id=root`
   - `POST /drive/picker/folders?tenant_id=default`
5. Guardar IDs por tenant:
   - `PUT /tenants/default/drive-config`
6. Verificar acceso:
   - `GET /drive/files?tenant_id=default`
7. Encolar proceso:
   - `POST /ingest/drive?tenant_id=default`
8. Seguir estado:
   - `GET /jobs/{job_id}`

## Notas

- `recibox_tmp_data` persiste tokens OAuth y descargas temporales entre reinicios.
- No compartas Redis con otros sistemas en esta etapa; este stack ya trae su Redis.
