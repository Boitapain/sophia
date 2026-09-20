# MCP Server Sophia (`mcp-server-sophia`)

**Sophia** est un serveur MCP (Model Context Protocol) servant de garde-fou (*gatekeeper*) strict pour les assistants IA de développement.

Il impose une Machine à États Finis (FSM) pour interdire toute modification non réfléchie ou non revue :
```mermaid
stateDiagram-v2
    [*] --> IDLE
    IDLE --> PLANNED : sophia_plan_step
    PLANNED --> STAGED : sophia_stage_changes
    STAGED --> PLANNED : sophia_review_and_lock (is_approved: false)
    STAGED --> REVIEWED : sophia_review_and_lock (is_approved: true)
    REVIEWED --> IDLE : reset immédiat & archivage
```

---

## Invariants et Outils

| Étape | Outil MCP | Arguments | Effet sur l'état |
|---|---|---|---|
| **1. Planification** | `sophia_plan_step` | `step_name: string`, `reasoning: string` | `IDLE` ➔ `PLANNED` |
| **2. Isolation** | `sophia_stage_changes` | `target_file: string`, `diff_or_code: string` | `PLANNED` ➔ `STAGED` |
| **3. Auto-review** | `sophia_review_and_lock` | `review_notes: string`, `is_approved: boolean` | `STAGED` ➔ `REVIEWED` ➔ `IDLE` (si approuvé)<br>`STAGED` ➔ `PLANNED` (si rejeté) |
| **Idempotent** | `sophia_status` | *(aucun)* | Lecture de l'état actuel et de l'historique de session |

Toute tentative d'appel d'un outil hors de sa séquence légitime lève une erreur explicite avec le flag `{ isError: true }` conforme au protocole MCP.

---

## Installation et Compilation

```bash
# Installation des dépendances
npm install

# Compilation TypeScript
npm run build

# Exécution des tests unitaires
npm test
```

---

## Configuration Client

### Claude Desktop (`claude_desktop_config.json`)

Emplacement :
- **macOS :** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows :** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sophia": {
      "command": "node",
      "args": [
        "/Users/vincentbullion/Documents/GitHub/sophia/dist/index.js"
      ]
    }
  }
}
```
