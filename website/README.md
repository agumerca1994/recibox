# RECIBOX Website (sitio publico)

Proyecto separado del backoffice para publicar la web institucional en `recibox.com.ar`.

## Contenido

- Landing: `/`
- Politica de privacidad: `/politicasdeprivacidad`
- Terminos y condiciones: `/terms`

## Ejecutar en localhost

```bash
cd /mnt/c/Users/u634958/Documents/proyectos/recibox
docker-compose -f docker-compose.website.localhost.yml up -d --build
```

URL local:

- `http://localhost:8090`
- `http://localhost:8090/politicasdeprivacidad`

Si quieres otro puerto, exporta `WEBSITE_PORT`.

## Deploy en produccion (servicio separado)

Usar compose dedicado por entorno en servicios separados (por ejemplo, en EasyPanel):

- Test: `docker-compose.website.test.yml`
- Produccion: `docker-compose.website.prod.yml`

Asociar dominios:

- `test.recibox.com.ar` (o el subdominio que uses para test)
- `recibox.com.ar`

La ruta de politicas quedara disponible en:

- `https://recibox.com.ar/politicasdeprivacidad`
- `https://recibox.com.ar/terms`
