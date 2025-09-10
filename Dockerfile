FROM node:20-alpine AS base
WORKDIR /usr/src/app
RUN apk add --no-cache tzdata git openssh \
 && ln -sf /usr/share/zoneinfo/Europe/Madrid /etc/localtime
ENV TZ=Europe/Madrid
COPY package*.json ./

FROM base AS deps
# usa `npm ci` si tienes package-lock.json
RUN npm install --no-audit --no-fund

FROM base AS dev
ENV NODE_ENV=development
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM base AS prod
ENV NODE_ENV=production
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
