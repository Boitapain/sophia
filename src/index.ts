#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import http from "node:http";
import { z } from "zod";

/**
 * États possibles de la machine à états Sophia.
 */
export type SophiaState = "IDLE" | "PLANNED" | "STAGED" | "REVIEWED";

/**
 * Données associées à l'étape de planification.
 */
export interface PlanStepPayload {
  readonly step_name: string;
  readonly reasoning: string;
}

/**
 * Données associées à l'étape d'isolation des modifications.
 */
export interface StageChangesPayload {
  readonly target_file: string;
  readonly diff_or_code: string;
}

/**
 * Données d'auto-review et d'approbation.
 */
export interface ReviewAndLockPayload {
  readonly review_notes: string;
  readonly is_approved: boolean;
}

/**
 * Snapshot immuable d'une étape validée et archivée.
 */
export interface SessionSnapshot {
  readonly id: number;
  readonly step_name: string;
  readonly reasoning: string;
  readonly target_file: string;
  readonly diff_or_code: string;
  readonly review_notes: string;
  readonly is_approved: boolean;
  readonly locked_at: string;
}

/**
 * Structure de retour pour la lecture d'état (sophia_status).
 */
export interface SophiaStatusResult {
  readonly current_state: SophiaState;
  readonly active_step: Readonly<{
    plan?: PlanStepPayload;
    staged?: StageChangesPayload;
  }> | null;
  readonly history_count: number;
  readonly history: readonly Readonly<SessionSnapshot>[];
}

/**
 * Résultat de l'opération sophia_review_and_lock.
 */
export interface ReviewResult {
  readonly state: SophiaState;
  readonly approved: boolean;
  readonly snapshot?: Readonly<SessionSnapshot>;
  readonly message: string;
}

/**
 * Erreur personnalisée levée lors d'une violation d'invariant de transition FSM.
 */
export class SophiaFsmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SophiaFsmError";
  }
}

/**
 * Contrôleur de la Machine à États Finis (FSM) Sophia.
 * Impose le flux strict : IDLE -> PLANNED -> STAGED -> REVIEWED -> IDLE.
 */
export class SophiaFSM {
  private state: SophiaState = "IDLE";
  private currentPlan: PlanStepPayload | null = null;
  private currentStaged: StageChangesPayload | null = null;
  private readonly history: SessionSnapshot[] = [];

  /**
   * Retourne l'état courant de la FSM.
   */
  public getState(): SophiaState {
    return this.state;
  }

  /**
   * Étape 1 : Planification du pas d'intervention.
   * Valide que l'état courant est IDLE puis transitionne vers PLANNED.
   */
  public planStep(payload: PlanStepPayload): { state: SophiaState; plan: PlanStepPayload } {
    if (this.state !== "IDLE") {
      throw new SophiaFsmError(
        `Transition FSM invalide : Impossible d'appeler 'sophia_plan_step' depuis l'état '${this.state}'. État attendu : 'IDLE'. Veuillez finaliser ou réinitialiser le cycle en cours.`
      );
    }

    this.currentPlan = Object.freeze({
      step_name: payload.step_name,
      reasoning: payload.reasoning,
    });
    this.currentStaged = null;
    this.state = "PLANNED";

    return {
      state: this.state,
      plan: this.currentPlan,
    };
  }

  /**
   * Étape 2 : Isolation et staging des modifications de code ou diff.
   * Valide que l'état courant est PLANNED puis transitionne vers STAGED.
   */
  public stageChanges(payload: StageChangesPayload): { state: SophiaState; staged: StageChangesPayload } {
    if (this.state !== "PLANNED") {
      throw new SophiaFsmError(
        `Transition FSM invalide : Impossible d'appeler 'sophia_stage_changes' depuis l'état '${this.state}'. État attendu : 'PLANNED'. Vous devez d'abord planifier votre étape via 'sophia_plan_step'.`
      );
    }

    this.currentStaged = Object.freeze({
      target_file: payload.target_file,
      diff_or_code: payload.diff_or_code,
    });
    this.state = "STAGED";

    return {
      state: this.state,
      staged: this.currentStaged,
    };
  }

  /**
   * Étape 3 : Auto-review et validation/verrouillage.
   * Valide que l'état courant est STAGED.
   * Si approuvé (is_approved === true), transitionne vers REVIEWED, archive un snapshot immuable,
   * puis réinitialise immédiatement l'état à IDLE.
   * Si non approuvé, annule le staging et repasse à PLANNED pour corrections.
   */
  public reviewAndLock(payload: ReviewAndLockPayload): ReviewResult {
    if (this.state !== "STAGED") {
      throw new SophiaFsmError(
        `Transition FSM invalide : Impossible d'appeler 'sophia_review_and_lock' depuis l'état '${this.state}'. État attendu : 'STAGED'. Vous devez d'abord isoler les changements via 'sophia_stage_changes'.`
      );
    }

    if (!payload.is_approved) {
      // Si la review est rejetée, on revient à l'état PLANNED pour permettre une nouvelle proposition
      this.currentStaged = null;
      this.state = "PLANNED";
      return {
        state: this.state,
        approved: false,
        message: `Auto-review rejetée : "${payload.review_notes}". L'étape a été rétrogradée à l'état 'PLANNED'. Veuillez ajuster et restager vos modifications avec 'sophia_stage_changes'.`,
      };
    }

    if (!this.currentPlan || !this.currentStaged) {
      throw new SophiaFsmError(
        "Incohérence interne : Impossible de verrouiller sans plan actif et changements stagés."
      );
    }

    // Passage transitoire à REVIEWED
    this.state = "REVIEWED";

    // Création d'un snapshot immuable archivé
    const snapshot: Readonly<SessionSnapshot> = Object.freeze({
      id: this.history.length + 1,
      step_name: this.currentPlan.step_name,
      reasoning: this.currentPlan.reasoning,
      target_file: this.currentStaged.target_file,
      diff_or_code: this.currentStaged.diff_or_code,
      review_notes: payload.review_notes,
      is_approved: true,
      locked_at: new Date().toISOString(),
    });

    this.history.push(snapshot);

    // Réinitialisation immédiate à IDLE pour le prochain cycle
    this.state = "IDLE";
    this.currentPlan = null;
    this.currentStaged = null;

    return {
      state: "IDLE",
      approved: true,
      snapshot,
      message: "Étape validée et verrouillée avec succès dans l'historique immuable. FSM réinitialisée à 'IDLE' pour la prochaine tâche.",
    };
  }

  /**
   * Lecture idempotente de l'état courant et de l'historique complet de la session.
   */
  public getStatus(): SophiaStatusResult {
    return {
      current_state: this.state,
      active_step:
        this.currentPlan || this.currentStaged
          ? Object.freeze({
              ...(this.currentPlan ? { plan: this.currentPlan } : {}),
              ...(this.currentStaged ? { staged: this.currentStaged } : {}),
            })
          : null,
      history_count: this.history.length,
      history: Object.freeze([...this.history]),
    };
  }
}

/**
 * Initialisation du serveur MCP Sophia
 */
export function createSophiaServer(fsm: SophiaFSM = new SophiaFSM()): McpServer {
  const server = new McpServer({
    name: "mcp-server-sophia",
    version: "1.0.0",
  });

  // Outil 1 : sophia_plan_step
  server.registerTool(
    "sophia_plan_step",
    {
      description:
        "Étape 1 du garde-fou Sophia : Planification de l'intervention. Reçoit un nom d'étape et un raisonnement. Fait passer la FSM de 'IDLE' à 'PLANNED'.",
      inputSchema: {
        step_name: z
          .string()
          .min(1)
          .describe("Nom concis ou identifiant de l'étape de développement"),
        reasoning: z
          .string()
          .min(1)
          .describe("Justification détaillée, contexte et raisonnement de l'étape"),
      },
    },
    async ({ step_name, reasoning }) => {
      try {
        const result = fsm.planStep({ step_name, reasoning });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  transition: "IDLE -> PLANNED",
                  data: result,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[Sophia FSM Error] ${message}`,
            },
          ],
        };
      }
    }
  );

  // Outil 2 : sophia_stage_changes
  server.registerTool(
    "sophia_stage_changes",
    {
      description:
        "Étape 2 du garde-fou Sophia : Isolation des modifications proposées. Valide que l'état est 'PLANNED' puis passe à 'STAGED'.",
      inputSchema: {
        target_file: z
          .string()
          .min(1)
          .describe("Chemin relatif ou absolu du fichier cible affecté"),
        diff_or_code: z
          .string()
          .min(1)
          .describe("Diff unifié ou extrait de code proposé pour l'étape"),
      },
    },
    async ({ target_file, diff_or_code }) => {
      try {
        const result = fsm.stageChanges({ target_file, diff_or_code });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  transition: "PLANNED -> STAGED",
                  data: result,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[Sophia FSM Error] ${message}`,
            },
          ],
        };
      }
    }
  );

  // Outil 3 : sophia_review_and_lock
  server.registerTool(
    "sophia_review_and_lock",
    {
      description:
        "Étape 3 du garde-fou Sophia : Auto-review et verrouillage. Valide que l'état est 'STAGED'. Si approuvé, archive un snapshot immuable et réinitialise à 'IDLE'. Si rejeté, renvoie une erreur et repasse à 'PLANNED'.",
      inputSchema: {
        review_notes: z
          .string()
          .min(1)
          .describe("Notes d'auto-review critique, vérification des tests et des invariants"),
        is_approved: z
          .boolean()
          .describe("Booléen d'approbation explicite (true pour valider et archiver, false pour refuser)"),
      },
    },
    async ({ review_notes, is_approved }) => {
      try {
        const result = fsm.reviewAndLock({ review_notes, is_approved });
        if (!result.approved) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "rejected",
                    transition: "STAGED -> PLANNED",
                    result,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  transition: "STAGED -> REVIEWED -> IDLE",
                  result,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[Sophia FSM Error] ${message}`,
            },
          ],
        };
      }
    }
  );

  // Outil 4 : sophia_status
  server.registerTool(
    "sophia_status",
    {
      description:
        "Lecture idempotente : Retourne l'état courant de la FSM Sophia, le pas en cours et l'historique complet des snapshots immuables.",
    },
    async () => {
      try {
        const status = fsm.getStatus();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[Sophia FSM Error] ${message}`,
            },
          ],
        };
      }
    }
  );

  return server;
}

/**
 * Exécution locale en mode Stdio (usage desktop / IDE).
 * STDOUT est exclusivement réservé au flux JSON-RPC.
 */
async function runStdio(): Promise<void> {
  const server = createSophiaServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error("[Sophia MCP Server] Démarré avec succès sur le transport Stdio.");
}

/**
 * Exécution distante en mode HTTP / Server-Sent Events (SSE) (usage cloud / Render / Docker).
 */
async function runHttp(port: number): Promise<void> {
  // Stockage des transports actifs par identifiant de session
  const activeSessions = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    // Headers CORS pour les clients Web
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const host = req.headers.host ?? `localhost:${port}`;
    const url = new URL(req.url ?? "/", `http://${host}`);

    // Endpoint de santé pour Render et orchestrateurs
    if (url.pathname === "/health" || url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "healthy",
          server: "mcp-server-sophia",
          version: "1.0.0",
          transport: "SSE",
          endpoints: {
            sse: "/sse",
            messages: "/messages",
          },
        })
      );
      return;
    }

    // Établissement du flux SSE (GET /sse)
    if (url.pathname === "/sse" && req.method === "GET") {
      // Instance de FSM dédiée par session client
      const sessionFsm = new SophiaFSM();
      const sessionServer = createSophiaServer(sessionFsm);
      const sseTransport = new SSEServerTransport("/messages", res);

      activeSessions.set(sseTransport.sessionId, sseTransport);

      sseTransport.onclose = () => {
        activeSessions.delete(sseTransport.sessionId);
        console.error(`[Sophia SSE] Session fermée : ${sseTransport.sessionId}`);
      };

      await sessionServer.connect(sseTransport);
      console.error(`[Sophia SSE] Nouvelle session connectée : ${sseTransport.sessionId}`);
      return;
    }

    // Réception des messages JSON-RPC (POST /messages?sessionId=...)
    if (url.pathname === "/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Paramètre sessionId manquant dans la requête" }));
        return;
      }

      const activeTransport = activeSessions.get(sessionId);
      if (!activeTransport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session SSE inconnue ou expirée" }));
        return;
      }

      await activeTransport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Route introuvable" }));
  });

  httpServer.listen(port, "0.0.0.0", () => {
    console.error(`[Sophia MCP Server] Serveur HTTP/SSE actif sur http://0.0.0.0:${port}`);
    console.error(`[Sophia MCP Server] Endpoint SSE    : http://0.0.0.0:${port}/sse`);
    console.error(`[Sophia MCP Server] Endpoint Health : http://0.0.0.0:${port}/health`);
  });
}

/**
 * Point d'entrée principal : sélectionne automatiquement le mode selon l'environnement.
 * - Stdio par défaut (CLI, Claude Desktop, Cursor en local)
 * - HTTP/SSE si PORT est défini (Render, Cloud, Docker) ou si l'option --http est fournie
 */
async function main(): Promise<void> {
  const isHttpRequest =
    process.argv.includes("--http") ||
    process.env.MCP_TRANSPORT === "http" ||
    process.env.PORT !== undefined;

  if (isHttpRequest) {
    const port = Number.parseInt(process.env.PORT || "3000", 10);
    await runHttp(port);
  } else {
    await runStdio();
  }
}

import { fileURLToPath } from "node:url";

// Démarrage uniquement si le script est exécuté directement en CLI
const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error("[Sophia MCP Server] Erreur fatale au démarrage :", error);
    process.exit(1);
  });
}
