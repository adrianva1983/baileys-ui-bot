# syntax=docker/dockerfile:1.6

############################
# Base
############################
FROM node:20-alpine AS base
WORKDIR /usr/src/app

# Zona horaria + utilidades (git y curl para instalar deps y healthchecks)
RUN apk add --no-cache tzdata git curl \
 && ln -sf /usr/share/zoneinfo/Europe/Madrid /etc/localtime

# Copiamos manifiestos de dependencias
COPY package*.json ./

############################
# Deps
############################
FROM base AS deps
# Usamos "npm install" (no "ci") para evitar el error si no hay package-lock.json
RUN npm install --no-audit --no-fund

############################
# Dev (con bind mounts)
############################
FROM base AS dev
ENV NODE_ENV=development
COPY --from=deps /usr/src/app/node_modules ./node_modules
# El código y la carpeta de sesión los montamos por volumen en docker-compose
EXPOSE 3000
CMD ["node", "app.js"]

############################
# Prod (imagen autocontenida)
############################
FROM base AS prod
ENV NODE_ENV=production
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .
# (Opcional) Ejecutar como usuario no root:
# RUN addgroup -S app && adduser -S app -G app && chown -R app:app /usr/src/app
# USER app
EXPOSE 3000
CMD ["node", "app.js"]
