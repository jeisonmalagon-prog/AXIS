#!/bin/sh
# Habilita el servidor HTTPS (443) solo si hay certificados montados.
# La imagen oficial de nginx ejecuta los scripts de /docker-entrypoint.d/ en
# orden alfabético, despues de 20-envsubst-on-templates.sh.
set -e

CERT=/etc/nginx/certs/fullchain.pem
KEY=/etc/nginx/certs/privkey.pem

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  echo "25-habilitar-https.sh: certificados encontrados, habilitando HTTPS en el puerto 443."
  envsubst '${BACKEND_HOST} ${BACKEND_PORT}' < /etc/nginx/ssl.conf.template > /etc/nginx/conf.d/https.conf
else
  echo "25-habilitar-https.sh: no hay certificados en /etc/nginx/certs; se sirve solo HTTP (puerto 80)."
fi
