# ============================================================
# Imagen del FRONTEND (Angular) — build multi-stage:
#   1) Compila la app con Node/Angular CLI.
#   2) Sirve los archivos estáticos resultantes con Nginx, que además
#      hace de reverse proxy de /api hacia el contenedor del backend
#      (necesario porque environment.prod.ts usa apiUrl: '/api', una
#      ruta relativa al MISMO origen que sirve el frontend).
# ============================================================

# ---------- Etapa 1: build ----------
FROM node:20-alpine AS build
WORKDIR /app

# Copiamos solo package*.json primero para aprovechar la caché de capas
# de Docker (si no cambian las dependencias, no se vuelve a correr npm ci).
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build -- --configuration production

# ---------- Etapa 2: servir con Nginx ----------
FROM nginx:alpine

# El builder nuevo de Angular (18+, "application") deja el HTML/JS final
# en dist/<proyecto>/browser, no directo en dist/<proyecto> — por eso el
# COPY apunta a esa subcarpeta. Ajusta "certificados-frontend" si cambia
# el nombre del proyecto en angular.json.
COPY --from=build /app/dist/certificados-frontend/browser /usr/share/nginx/html

# Plantilla de Nginx (ver nginx.conf.template): usa variables de entorno
# para saber a qué backend reenviar /api, así la MISMA imagen/tar sirve
# para cualquier servidor sin tener que reconstruirla. La imagen oficial
# de Nginx corre "envsubst" sobre los archivos en /etc/nginx/templates/
# automáticamente al arrancar el contenedor.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# HTTPS (443) opcional: la plantilla y el script que la activa solo si hay
# certificados montados en /etc/nginx/certs. El sed quita los saltos de línea
# de Windows (CRLF), que harían fallar el script dentro de Alpine.
COPY nginx-ssl.conf.template /etc/nginx/ssl.conf.template
COPY 25-habilitar-https.sh /docker-entrypoint.d/25-habilitar-https.sh
RUN sed -i 's/\r$//' /docker-entrypoint.d/25-habilitar-https.sh /etc/nginx/ssl.conf.template \
 && chmod +x /docker-entrypoint.d/25-habilitar-https.sh

# Valores por defecto — pisa con "docker run -e BACKEND_HOST=... -e
# BACKEND_PORT=..." si el contenedor del backend tiene otro nombre/puerto.
ENV BACKEND_HOST=certificados_backend \
    BACKEND_PORT=3000

EXPOSE 80 443
