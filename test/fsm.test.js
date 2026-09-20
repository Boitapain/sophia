import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SophiaFSM, SophiaFsmError, createSophiaServer } from "../dist/index.js";

describe("Sophia FSM Gatekeeper Tests", () => {
  test("État initial doit être IDLE", () => {
    const fsm = new SophiaFSM();
    assert.equal(fsm.getState(), "IDLE");
  });

  test("Interdiction de stager ou review depuis l'état IDLE", () => {
    const fsm = new SophiaFSM();

    assert.throws(
      () => fsm.stageChanges({ target_file: "test.ts", diff_or_code: "// some diff" }),
      (err) => {
        return err instanceof SophiaFsmError && err.message.includes("PLANNED");
      }
    );

    assert.throws(
      () => fsm.reviewAndLock({ review_notes: "valid", is_approved: true }),
      (err) => {
        return err instanceof SophiaFsmError && err.message.includes("STAGED");
      }
    );
  });

  test("Cycle complet : IDLE -> PLANNED -> STAGED -> REVIEWED (reset IDLE)", () => {
    const fsm = new SophiaFSM();

    // 1. Plan
    const planResult = fsm.planStep({
      step_name: "feat-auth",
      reasoning: "Mise en place de l'authentification JWT",
    });
    assert.equal(fsm.getState(), "PLANNED");
    assert.equal(planResult.plan.step_name, "feat-auth");

    // 2. Stage
    const stageResult = fsm.stageChanges({
      target_file: "src/auth.ts",
      diff_or_code: "+ export function verifyToken() {}",
    });
    assert.equal(fsm.getState(), "STAGED");
    assert.equal(stageResult.staged.target_file, "src/auth.ts");

    // 3. Review et Lock
    const reviewResult = fsm.reviewAndLock({
      review_notes: "Code propre, tests unitaires couverts",
      is_approved: true,
    });
    assert.equal(reviewResult.approved, true);
    assert.equal(fsm.getState(), "IDLE");
    assert.ok(reviewResult.snapshot);
    assert.equal(reviewResult.snapshot.id, 1);
    assert.equal(reviewResult.snapshot.step_name, "feat-auth");

    // 4. Status vérification
    const status = fsm.getStatus();
    assert.equal(status.current_state, "IDLE");
    assert.equal(status.active_step, null);
    assert.equal(status.history_count, 1);
    assert.equal(status.history[0].step_name, "feat-auth");
  });

  test("Auto-review rejetée : rétrogradation à PLANNED sans archivage", () => {
    const fsm = new SophiaFSM();

    fsm.planStep({
      step_name: "bugfix-cache",
      reasoning: "Correction d'une fuite mémoire",
    });
    fsm.stageChanges({
      target_file: "src/cache.ts",
      diff_or_code: "- delete cache[k]",
    });
    assert.equal(fsm.getState(), "STAGED");

    const rejection = fsm.reviewAndLock({
      review_notes: "Attention: la clé n'est pas vérifiée avant suppression",
      is_approved: false,
    });

    assert.equal(rejection.approved, false);
    assert.equal(fsm.getState(), "PLANNED");
    assert.equal(fsm.getStatus().history_count, 0);

    // Permet de restager et valider
    fsm.stageChanges({
      target_file: "src/cache.ts",
      diff_or_code: "+ if (cache[k]) delete cache[k];",
    });
    assert.equal(fsm.getState(), "STAGED");

    const approval = fsm.reviewAndLock({
      review_notes: "Correction validée",
      is_approved: true,
    });
    assert.equal(approval.approved, true);
    assert.equal(fsm.getState(), "IDLE");
    assert.equal(fsm.getStatus().history_count, 1);
  });

  test("Initialisation serveur MCP sans erreur", () => {
    const server = createSophiaServer();
    assert.ok(server);
  });
});
