# syntax=docker/dockerfile:1

# -------------------------------------------------------------------
# Étape 1 : Build & Tests
# -------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Copie des fichiers de configuration
COPY package*.json tsconfig.json ./

# Installation complète des dépendances (y compris dev)
RUN npm ci

# Copie des sources et des tests
COPY src/ ./src/
COPY test/ ./test/

# Compilation TypeScript et validation par les tests
RUN npm run build && npm test

# -------------------------------------------------------------------
# Étape 2 : Image d'exécution minimale pour la production (Render)
# -------------------------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=10000

# Installation exclusive des dépendances de production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Récupération du bundle compilé depuis l'étape builder
COPY --from=builder /app/dist ./dist

# Sécurité : exécution avec l'utilisateur standard 'node' non-root
USER node

# Port par défaut pour Render
EXPOSE 10000

# Démarrage du serveur (le mode HTTP/SSE s'active automatiquement via la présence de la variable PORT)
CMD ["node", "dist/index.js"]
