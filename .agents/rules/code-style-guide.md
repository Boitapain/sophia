---
trigger: always_on
---

# Directives Workspace - Projet : mcp-server-sophia

## 1. Contexte et Rôle
Ce workspace héberge le code source du serveur MCP **Sophia** (`mcp-server-sophia`), une machine à états finis (FSM) servant de garde-fou au workflow de développement (séquence stricte : `IDLE` -> `PLANNED` -> `STAGED` -> `REVIEWED` -> `IDLE`).
L'objectif des interventions sur ce dépôt est de développer, maintenir, tester et faire évoluer le moteur interne du serveur MCP.

---

## 2. Standards d'Architecture et Dépendances
- **SDK MCP :** Utiliser exclusivement `@modelcontextprotocol/sdk` (préférer l'API `McpServer` moderne).
- **Validation :** Schémas d'entrée des outils validés rigoureusement via `zod`.
- **Module System :** ESM pur (`"type": "module"`, `"moduleResolution": "NodeNext"`).
  - *Règle critique TypeScript/NodeNext :* Tous les imports relatifs de fichiers locaux doivent impérativement comporter l'extension `.js` (ex: `import { fsm } from "./fsm.js";`).
- **Typage Strict :**
  - Aucune utilisation de `any`. Utiliser `unknown` avec type-guards ou inférence Zod.
  - Typage explicite des retours de fonctions pour toutes les méthodes publiques du contrôleur FSM.

---

## 3. Règle Fondamentale d'I/O (Transport Stdio MCP)
- **STDOUT est réservé au protocole JSON-RPC :**
  - Ne **JAMAIS** émettre de logs applicatifs ou de débogage via `console.log()` ou `process.stdout.write()`.
  - Tout log, message d'erreur ou trace de débogage interne doit être redirigé vers `console.error()` (STDERR) ou via le système de log officiel du SDK (`server.server.sendLoggingMessage`).

---

## 4. Invariants de la Machine à États (FSM)
Toute modification apportée au code source doit respecter les invariants suivants :
1. **Graphe de transitions strict :**
   - `IDLE`       -> appel valide : `sophia_plan_step`      -> passage à `PLANNED`
   - `PLANNED`    -> appel valide : `sophia_stage_changes`   -> passage à `STAGED`
   - `STAGED`     -> appel valide : `sophia_review_and_lock` -> passage à `REVIEWED` puis réinitialisation immédiate à `IDLE`
2. **Gestion des transitions invalides :**
   - Toute méthode de transition invoquée en dehors de son état légitime doit lever une erreur déterministe avec message explicite.
   - Les outils MCP doivent intercepter ces erreurs et renvoyer une réponse conforme au protocole MCP (`isError: true`).
3. **Immutabilité de l'historique :**
   - Les modifications validées dans `sophia_review_and_lock` doivent être archivées sous forme de snapshots immuables dans l'historique de session.

---

## 5. Spécification des Outils MCP
En cas d'évolution des signatures d'outils, maintenir les contrats suivants :
- `sophia_plan_step` : arguments `{ step_name: string, reasoning: string }`
- `sophia_stage_changes` : arguments `{ target_file: string, diff_or_code: string }`
- `sophia_review_and_lock` : arguments `{ review_notes: string, is_approved: boolean }`
- `sophia_status` : aucun argument requis, lecture idempotente de l'état et de l'historique.

---

## 6. Commandes de Build et Validation
Avant toute validation de modification sur la base de code :
- **Vérification des types et compilation :**
  ```bash
  npm run build