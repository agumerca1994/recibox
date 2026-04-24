# RECIBOX Frontend (React + Vite)

Frontend base para integrarse con el backend de RECIBOX.

## Requisitos

- Node.js 22+
- npm 10+

## Variables de entorno (dev)

Crear `frontend/.env` desde `frontend/.env.example`:

```env
VITE_DEV_PORT=5173
VITE_API_BASE_PATH=/api
VITE_API_TARGET=http://127.0.0.1:8000
VITE_APP_ENV=localhost
VITE_TENANT_ID=acme
VITE_FIREBASE_AUTH_ENABLED=false
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_APP_ID=
```

## Ejecutar en local (WSL)

```bash
cd frontend
npm install
npm run dev
```

- Frontend: `http://127.0.0.1:5173`
- API consumida por proxy Vite: `http://127.0.0.1:8000`
- Llamadas del frontend: `http://127.0.0.1:5173/api/*`

## Endpoints integrados en la UI base

- `GET /health`
- `GET /tenants/{tenant_id}/drive-config`
- `PUT /tenants/{tenant_id}/drive-config`
- `GET /drive/files?tenant_id=...`
- `POST /ingest/drive?tenant_id=...`
- `GET /jobs/{job_id}`

## Build Docker

```bash
docker build -f frontend/Dockerfile -t recibox-frontend .
```

Este contenedor sirve el frontend con Nginx y hace proxy de `/api/*` al servicio `recibox-api:8000` dentro de la red Docker.

## Firebase Auth (frontend)

La autenticacion Firebase corre en frontend y queda protegida por `AuthGate` cuando:

- `VITE_FIREBASE_AUTH_ENABLED=true`

Variables requeridas:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_APP_ID`

### Localhost

1. Crear `frontend/.env.local`.
2. Copiar variables de `frontend/.env.example`.
3. Completar credenciales de tu proyecto Firebase.
4. En Firebase Console, agregar `localhost` en dominios autorizados.

### Produccion / Test

Configurar las mismas variables en EasyPanel para cada stack frontend:

- `backoffice.recibox.com.ar`
- `backoffice-test.recibox.com.ar`

Agregar esos dominios en Firebase Authentication -> Authorized domains.

Definir tambien `VITE_APP_ENV` por entorno para mostrar el chip visual:

- `localhost` para local
- `test` para testing
- `prod` para produccion

Importante:

- Las variables `VITE_FIREBASE_*` se inyectan en `npm run build` (tiempo de build).
- Si cambias una credencial en EasyPanel o `.env`, debes reconstruir la imagen frontend.

Nota:

- Esta integracion autentica usuarios en el frontend.
- El cliente API adjunta el Firebase ID token en `Authorization` para todos los endpoints protegidos del backend.
- En test y prod conviene compilar con `VITE_FIREBASE_AUTH_ENABLED=true`.
