# Antes era node:20-alpine, pero Alpine trae un build de OpenSSL 3 que falla
# al leer ciertas llaves privadas RSA (PKCS8) -- lo vimos con la llave de la
# cuenta de servicio de Google Calendar (crypto.createPrivateKey falla con
# "error:1E08010C:DECODER routines::unsupported" aunque la llave esté bien
# formada). node:20-bookworm-slim es Debian, sigue siendo una imagen chica,
# y con el mismo OpenSSL 3 pero sin ese bug de Alpine.
FROM node:20-bookworm-slim

WORKDIR /app

# smbclient: lo usa la validación de nodos para leer, por carpeta compartida
# (SMB), el archivo de configuración de los servidores Windows.
RUN apt-get update \
    && apt-get install -y --no-install-recommends smbclient \
    && rm -rf /var/lib/apt/lists/*

# Copiamos solo package*.json primero para aprovechar la caché de capas de Docker
COPY package*.json ./
RUN npm install --omit=dev

# Copiamos el resto del código (routes/, db.js, server.js)
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
