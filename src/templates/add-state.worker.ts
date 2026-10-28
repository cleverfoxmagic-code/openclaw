import { mergeWorkspaceSetupStateInDatabase } from "../agents/workspace-state-store.worker.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import type { TemplateAddStateCommand } from "./add-state-worker-contract.js";

/** One finite Template Add state change runs entirely on the shared SQLite actor. */
export function executeTemplateAddStateCommand(
  command: TemplateAddStateCommand,
  { writeAdmitted }: WorkerWriteOperationContext,
) {
  return writeAdmitted(
    (database) =>
      mergeWorkspaceSetupStateInDatabase(
        database,
        command.input.workspaceDir,
        { bootstrapSeededAt: command.input.bootstrapSeededAt },
        command.input.nowMs,
      ),
    { transactionEnvironment: "process" },
  );
}
