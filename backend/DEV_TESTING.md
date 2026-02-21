# RECIBOX - Guia de pruebas en DEV (sin Docker)

## 0) Primer setup (una sola vez)

Copiar y pegar este bloque completo:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip redis-server curl

cd /mnt/c/Users/u634958/Documents/proyectos/recibox/backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
deactivate
```

## 1) Arranque rapido para cada prueba

### Terminal 1 (API)

```bash
cd /mnt/c/Users/u634958/Documents/proyectos/recibox/backend
source .venv/bin/activate

sudo service redis-server start
redis-cli ping

uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### Terminal 2 (Worker)

```bash
cd /mnt/c/Users/u634958/Documents/proyectos/recibox/backend
source .venv/bin/activate
rq worker recibox --url redis://localhost:6379/0
```

## 2) Verificar variables en `.env`

Minimo para dev (archivo `backend/.env`):

```env
REDIS_URL=redis://localhost:6379/0
GOOGLE_OAUTH_REDIRECT_URI=http://127.0.0.1:8000/auth/google/callback
OAUTH_REQUIRED_FOR_TENANT=FALSE
```

Notas:
- API corre en `8000`.
- Redis corre en `6379`.
- Si queres simular prod OAuth-only, usar `OAUTH_REQUIRED_FOR_TENANT=TRUE`.
- `DRIVE_INPUT_FOLDER_ID` y `DRIVE_ROOT_FOLDER_ID` ahora son opcionales (fallback).
- Si no definis fallback, debes configurar carpetas por tenant con:
  - `PUT /tenants/{tenant_id}/drive-config`
  - o `POST /drive/picker/recibox-structure`

## 3) Flujo de prueba en Postman

Usar `tenant_id=acme` (o el que prefieras).

1. `GET http://127.0.0.1:8000/health`
2. Abrir en navegador:
   - `http://127.0.0.1:8000/auth/google/login?tenant_id=acme`
3. En Postman:
   - `GET http://127.0.0.1:8000/drive/picker/folders?tenant_id=acme&parent_id=root`
4. (Recomendado) Crear estructura RECIBOX + #0 INPUT:
   - `POST http://127.0.0.1:8000/drive/picker/recibox-structure?tenant_id=acme`
   - Body JSON:
```json
{
  "parent_id": "root"
}
```
   - Por defecto tambien guarda config del tenant (`save_as_tenant_config=true`).
4.b) Verificar estructura:
   - `GET http://127.0.0.1:8000/drive/picker/recibox-structure/check?tenant_id=acme&parent_id=root`
   - Respuestas esperadas: `complete`, `missing_input`, `missing_recibox`.
4.c) Si existe `RECIBOX` pero falta `#0 INPUT`, crear solo input:
   - `POST http://127.0.0.1:8000/drive/picker/recibox-input?tenant_id=acme`
   - Body JSON:
```json
{
  "recibox_folder_id": "<RECIBOX_FOLDER_ID>",
  "root_parent_id": "root"
}
```
5. (Alternativa manual) Guardar IDs por tenant:
   - `PUT http://127.0.0.1:8000/tenants/acme/drive-config`
   - Body JSON:
```json
{
  "drive_input_folder_id": "<ID_INPUT>",
  "drive_root_folder_id": "<ID_ROOT_PARENT>",
  "drive_recibox_folder_id": "<ID_RECIBOX>"
}
```
6. Verificar config guardada:
   - `GET http://127.0.0.1:8000/tenants/acme/drive-config`
7. Probar listado de input:
   - `GET http://127.0.0.1:8000/drive/files?tenant_id=acme`
8. Disparar proceso:
   - `POST http://127.0.0.1:8000/ingest/drive?tenant_id=acme`
9. Consultar job:
   - `GET http://127.0.0.1:8000/jobs/<JOB_ID>`

### Endpoints extra por tenant (empleados/carpetas/archivos)

- Crear carpeta de empleado:
  - `POST http://127.0.0.1:8000/drive/employees?tenant_id=acme`
  - Body JSON:
```json
{
  "employee_name": "Juan Perez"
}
```
- Listar carpetas de empleado:
  - `GET http://127.0.0.1:8000/drive/employees?tenant_id=acme`
- Crear carpeta de año de un empleado:
  - `POST http://127.0.0.1:8000/drive/employees/<EMPLOYEE_FOLDER_ID>/years?tenant_id=acme`
  - Body JSON:
```json
{
  "year": "2026"
}
```
- Listar años de empleado:
  - `GET http://127.0.0.1:8000/drive/employees/<EMPLOYEE_FOLDER_ID>/years?tenant_id=acme`
- Listar archivos de carpeta de empleado:
  - `GET http://127.0.0.1:8000/drive/employees/<EMPLOYEE_FOLDER_ID>/files?tenant_id=acme`
- Descargar archivo:
  - `GET http://127.0.0.1:8000/drive/files/<FILE_ID>/download?tenant_id=acme`

### OAuth: verificar y desvincular

- Ver estado de token OAuth:
  - `GET http://127.0.0.1:8000/auth/google/status?tenant_id=acme`
- Refrescar token OAuth (si hay refresh token):
  - `POST http://127.0.0.1:8000/auth/google/refresh?tenant_id=acme`
- Desvincular tenant (por defecto: revoca token, borra token local, borra drive-config, lock y bloquea tenant):
  - `POST http://127.0.0.1:8000/auth/google/unlink?tenant_id=acme`
- Mismo endpoint, variante para conservar config y no bloquear tenant:
  - `POST http://127.0.0.1:8000/auth/google/unlink?tenant_id=acme&clear_drive_config=false&disable_tenant=false`

## 4) Errores comunes

- `Connection refused` en Redis:
  - Redis no esta levantado o `REDIS_URL` incorrecta.
- Error OAuth redirect:
  - Verificar que en Google Cloud exista exactamente:
    `http://127.0.0.1:8000/auth/google/callback`
- Error:
  - `{"detail":[{"loc":["query","code"],"msg":"Field required"}]}`
  - Causa: se llamo `/auth/google/callback` manualmente sin `code`.
  - Correcto: abrir `/auth/google/login?tenant_id=...` y dejar que Google redirija solo al callback.
- `No OAuth token configured for tenant`:
  - Falto hacer login OAuth para ese `tenant_id`.
- `Tenant '<id>' is unlinked`:
  - El tenant esta bloqueado por `/auth/google/unlink`.
  - Para reactivar: volver a hacer OAuth login o guardar de nuevo `/tenants/{tenant_id}/drive-config`.
- Endpoints Drive vacios/fallando:
  - IDs de carpetas incorrectos o permisos de Drive insuficientes.

## 5) Comandos utiles de control

```bash
# Verificar Redis
redis-cli ping
sudo service redis-server status

# Ver procesos locales
ps aux | grep -E "uvicorn|rq worker" | grep -v grep

# Liberar puerto 8000 si quedo tomado
sudo lsof -i :8000
```
