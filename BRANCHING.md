# Branching y Entornos

## Objetivo
- `prod`: codigo desplegado en produccion.
- `test`: codigo para validar cambios en entorno real de pruebas.
- `dev`: desarrollo local en localhost.

## Ramas
- `prod`
- `test`
- `dev`
- `main` (puede quedar como rama de integracion/historica)

## Estado actual
- Las ramas locales ya fueron creadas desde `main`.
- Falta publicarlas en GitHub si no aparecen remoto:

```bash
git push -u origin prod
git push -u origin test
git push -u origin dev
```

## Flujo recomendado
1. Trabajar en `dev`.
2. Subir `dev` y desplegar stack de prueba apuntando a rama `test` (promocion via merge/cherry-pick).
3. Validar en `backoffice.test.recibox.com.ar` y `api.test.recibox.com.ar`.
4. Promover a `prod` cuando QA este ok.

## Promocion entre ramas
```bash
# pasar de dev -> test
git checkout test
git merge --no-ff dev
git push origin test

# pasar de test -> prod
git checkout prod
git merge --no-ff test
git push origin prod
```

## Convencion de nombres de compose

Para evitar confusion entre ambientes y capas:

- `docker-compose.prod.backend.yml`
- `docker-compose.prod.frontend.yml`
- `docker-compose.test.backend.yml`
- `docker-compose.test.frontend.yml`

Archivos legacy (compatibilidad):

- `docker-compose.frontend.yml`
- `docker-compose.frontend.test.yml`
- `docker-compose.test.yml` (stack completo test)

## EasyPanel (frontend)

### Produccion
- Rama: `prod`
- Compose file: `docker-compose.prod.frontend.yml`
- Dominio: `backoffice.recibox.com.ar`
- API upstream: `https://api.recibox.com.ar` (ya configurado en compose)

### Test
- Rama: `test`
- Compose file: `docker-compose.test.frontend.yml`
- Dominio: `backoffice.test.recibox.com.ar`
- API upstream: `https://api.test.recibox.com.ar` (ya configurado en compose)

## EasyPanel (backend)
- Crear stack backend prod con rama `prod` y dominio `api.recibox.com.ar`.
- Crear stack backend test con rama `test` y dominio `api.test.recibox.com.ar`.
- Compose recomendado prod: `docker-compose.prod.backend.yml`
- Compose recomendado test: `docker-compose.test.backend.yml`
- En cada stack backend configurar:
  - `GOOGLE_OAUTH_REDIRECT_URI=https://<dominio-api>/auth/google/callback`
  - secretos/volumenes separados para no mezclar tokens entre prod y test.

## Compose integral de test

Si quieres desplegar todo test como un stack unico (backend + worker + redis + postgres + frontend):

- Rama: `test`
- Compose file: `docker-compose.test.yml`

Servicios que levanta:

- `recibox-test-postgres`
- `recibox-test-redis`
- `recibox-test-api`
- `recibox-test-worker`
- `recibox-test-frontend`

Dominios recomendados en EasyPanel:

- `api.test.recibox.com.ar` -> `recibox-test-api` (puerto 8000 interno, protocolo HTTP)
- `backoffice.test.recibox.com.ar` -> `recibox-test-frontend` (puerto 80 interno, protocolo HTTP)

Variables/paths de test importantes:

- `TEST_SECRETS_DIR` (default `/opt/recibox-secrets-test`)
- `FIREBASE_PROJECT_ID` (usar proyecto Firebase de test)

En `${TEST_SECRETS_DIR}` dejar:

- `service-account.json` (Google Drive / GCP)
- `firebase-admin.json` (Firebase Admin del proyecto test)
- `oauth-client.json` (OAuth web client para test)

## Dev local
- Mantener `dev` para localhost.
- Frontend local usa `/api` y proxy de Vite.
- Backend local con `.env` (por ejemplo `GOOGLE_OAUTH_REDIRECT_URI=http://127.0.0.1:8000/auth/google/callback`).

## Nota importante
- Para que frontend pueda cambiar de API por entorno, Nginx ahora usa variables:
  - `API_UPSTREAM`
  - `API_UPSTREAM_HOST`
- Estan definidas en:
  - `docker-compose.frontend.yml` (prod)
  - `docker-compose.frontend.test.yml` (test)
