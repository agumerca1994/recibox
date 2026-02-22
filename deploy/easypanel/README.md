# RECIBOX en EasyPanel (Frontend + API externa)

Este setup asume que el backend ya esta desplegado por separado en:

- `https://api.recibox.com.ar`

El `docker-compose.yml` de la raiz despliega solamente:

- `recibox-frontend` (React + Nginx)

## 1) Archivo en la raiz

EasyPanel debe leer el compose desde la raiz del repo:

- `docker-compose.yml`

## 2) Crear stack en EasyPanel

1. En EasyPanel, entra al proyecto.
2. Crea un servicio tipo Compose/Stack.
3. Usa el `docker-compose.yml` de la raiz.
4. Publica el servicio `recibox-frontend` con el dominio:
   - `recibox.com.ar`

## 3) Conexion frontend -> API

El frontend llama a `/api/*`.
Nginx (dentro del contenedor frontend) hace proxy de `/api/*` hacia:

- `https://api.recibox.com.ar/*`

Configurado en:

- `frontend/nginx.conf`

## 4) Verificaciones recomendadas

1. Abrir `https://recibox.com.ar`.
2. Verificar que el login OAuth redirige a:
   - `https://api.recibox.com.ar/auth/google/callback`
3. Probar desde navegador:
   - `https://api.recibox.com.ar/health`
4. Revisar en DevTools que requests del frontend salgan como:
   - `https://recibox.com.ar/api/...` (proxied por Nginx al subdominio API).
