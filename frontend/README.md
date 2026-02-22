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
VITE_TENANT_ID=acme
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
