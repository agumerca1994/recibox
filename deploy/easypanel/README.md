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

---

# RECIBOX Test en EasyPanel (nombres explicitos)

Composes recomendados:

- `docker-compose.test.backend.yml`
- `docker-compose.test.frontend.yml`

## Fuente en EasyPanel (backend test)

- URL repo: mismo repositorio
- Rama: `test`
- Ruta de compilacion: `/`
- Archivo Docker Compose: `docker-compose.test.backend.yml`

## Servicios esperados (backend test)

- `recibox-test-postgres`
- `recibox-test-redis`
- `recibox-test-api`
- `recibox-test-worker`

## Fuente en EasyPanel (frontend test)

- URL repo: mismo repositorio
- Rama: `test`
- Ruta de compilacion: `/`
- Archivo Docker Compose: `docker-compose.test.frontend.yml`

Servicio esperado:

- `recibox-test-frontend`

## Publicar dominios

1. `api-test.recibox.com.ar` -> servicio `recibox-test-api` (HTTP, puerto interno `8000`)
2. `backoffice-test.recibox.com.ar` -> servicio `recibox-test-frontend` (HTTP, puerto interno `80`)

## Secrets de test

El compose test usa por default:

- `${TEST_SECRETS_DIR:-/opt/recibox-credentials/test}:/run/secrets:ro`
- `${OAUTH_SECRETS_DIR:-/opt/recibox-credentials}:/run/oauth-secrets:ro`

En el directorio `TEST_SECRETS_DIR` debes tener (credenciales test):

- `/opt/recibox-credentials/test/service-account.json`
- `/opt/recibox-credentials/test/firebase-admin.json`
- `/opt/recibox-credentials/test/recibox-76a50-firebase-adminsdk-....json`

En el directorio `OAUTH_SECRETS_DIR` debes tener (compartido test/prod):

- `/opt/recibox-credentials/oauth-client.json` o el archivo real de Google (por ejemplo `client_secret_...json`)

Opcionalmente define en EasyPanel:

- `TEST_SECRETS_DIR`
- `OAUTH_SECRETS_DIR`
- `FIREBASE_PROJECT_ID` (proyecto Firebase de test)
- `GOOGLE_OAUTH_CLIENT_SECRETS_FILE` (default: `oauth-client.json`)
- `GOOGLE_APPLICATION_CREDENTIALS_FILE` (default: `service-account.json`)
- `FIREBASE_CREDENTIALS_FILE` (default: `firebase-admin.json`)
