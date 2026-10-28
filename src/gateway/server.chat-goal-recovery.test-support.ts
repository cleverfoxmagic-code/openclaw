import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi, type MockInstance } from "vitest";
import type { runEmbeddedAgent as executeEmbeddedAgent } from "../agents/embedded-agent.js";
import { markRestartAbortedMainSessions } from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { mainSessionRecoveryLog } from "../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import { recoverStore } from "../agents/main-session-recovery/main-session-restart-recovery-store.js";
import { createRestartRecoveryOperatorSource } from "../agents/operator-run-recovery-source.js";
import { getRuntimeConfig } from "../config/config.js";
import { createSessionGoal } from "../config/sessions/goals.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { goalAgentResult } from "./server.chat-goal.test-support.js";
import { agentCommandMock } from "./test-helpers.js";

export function registerGoalRecoveryContinuationCase(
  scope: () => { agentId: string; sessionKey: string; sessionId: string; storePath: string },
  runEmbeddedAgent: MockInstance<typeof executeEmbeddedAgent>,
  profileClient: (id: string) => GatewayClient,
  getContext: () => GatewayRequestContext,
  userMessages: () => readonly unknown[],
): void {
  it("hands an interrupted Goal to the reply owner through consecutive finals without a human turn", async () => {
    const context = getContext();
    const { sessionId, storePath } = scope();
    const profile = ensureProfileForEmail("goal-recovery@example.test");
    const sourceClient = profileClient(profile.id);
    sourceClient.internal = { authenticatedOperator: true, controlUiAdmin: true };
    sourceClient.authPolicy = captureGatewayAuthPolicy(getRuntimeConfig(), {
      role: "operator",
      authMethod: "token",
    });
    const captured = await captureGatewayOperatorRunAuthority({
      client: sourceClient,
      context,
      sourceAuthority: null,
    });
    expect(captured).toBeDefined();
    const goal = await createSessionGoal({
      ...scope(),
      objective: "Finish the recovered three-turn checklist",
      actor: { type: "human", id: profile.id },
    });
    const sourceRunId = "interrupted-goal-original";
    const original = loadSessionEntry(scope())!;
    const interrupted: InternalSessionEntry = {
      ...original,
      lifecycleRevision: "goal-recovery-lifecycle",
      lifecycleRunId: sourceRunId,
      status: undefined,
      createdActor: { type: "human" as const, source: "profile" as const, id: profile.id },
    };
    const operatorSource = createRestartRecoveryOperatorSource({
      authority: captured!.authority,
      entry: interrupted,
      ...scope(),
      sourceRunId,
    });
    expect(operatorSource).toBeDefined();
    await replaceSessionEntry(scope(), {
      ...interrupted,
      restartRecoveryOperatorSource: operatorSource,
      restartRecoverySourceIngress: "control-ui",
    });
    captured!.release();
    await markRestartAbortedMainSessions({
      resolveGatewayContext: () => context,
      activeRuns: [
        { ...scope(), runId: sourceRunId, lifecycleGeneration: getAgentEventLifecycleGeneration() },
      ],
      isActiveRun: () => true,
    });
    // The baseline command route also finishes successfully; only reply ownership
    // can continue this exact Goal after that successful final.
    agentCommandMock.mockImplementation(async (options) => {
      options.onExecutionStarted?.();
      return {
        ...goalAgentResult(sessionId, "A recovered command final."),
        payloads: [{ text: "A recovered command final.", mediaUrl: null }],
        meta: { ...goalAgentResult(sessionId, "").meta, stopReason: "end_turn" },
      };
    });
    let recoveredCron: Parameters<typeof executeEmbeddedAgent>[0]["cronCreatorAuthorityCapability"];
    runEmbeddedAgent.mockImplementation(async (params) => {
      if (runEmbeddedAgent.mock.calls.length === 1) {
        recoveredCron = params.cronCreatorAuthorityCapability;
        expect(recoveredCron?.active).toBe(true);
        expect(recoveredCron?.managementEntitlement).toEqual({ source: "control-ui-admin" });
        expect(recoveredCron?.isCurrent?.()).toBe(true);
      }
      if (runEmbeddedAgent.mock.calls.length === 3) {
        await patchSessionEntryCore(scope(), (entry) => ({
          goal: entry.goal ? { ...entry.goal, status: "complete" } : undefined,
        }));
      }
      const result = goalAgentResult(params.sessionId, "A recovered normal final.");
      return { ...result, meta: { ...result.meta, stopReason: "end_turn" } };
    });
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => createGatewayMethodRegistry([]),
      isDispatchAvailable: () => true,
    });
    context.recoveryRuntime = runtime.recovery;
    bindGatewayContextResolver(runtime.recovery, context.resolveGatewayContext);
    const warnings = vi.spyOn(mainSessionRecoveryLog, "warn");
    try {
      const recovered = await withPluginRuntimeGatewayContextResolver(
        () => context,
        () =>
          recoverStore({
            cfg: getRuntimeConfig(),
            storePath,
            handledSessionKeys: new Set(),
            expectedTarget: scope(),
            gatewayRuntime: runtime.recovery,
          }),
      );
      const drained = await waitForGatewayActiveWork(30_000);
      expect(drained.drained, JSON.stringify(drained.snapshot.blockers)).toBe(true);
      const current = loadSessionEntry(scope());
      expect(recovered.failed).toBe(0);
      expect(
        runEmbeddedAgent.mock.calls,
        JSON.stringify({
          recovered,
          warnings: warnings.mock.calls,
          chatInfo: vi.mocked(context.logGateway.info).mock.calls,
          chatWarnings: vi.mocked(context.logGateway.warn).mock.calls,
          chatErrors: vi.mocked(context.logGateway.error).mock.calls,
          dedupe: [...context.dedupe].map(([key, value]) => ({
            key,
            ok: value.ok,
            payload: value.payload,
            error: value.error,
          })),
          status: current?.status,
          recovery: current?.mainRestartRecovery,
          goalStatus: current?.goal?.status,
        }),
      ).toHaveLength(3);
      expect(recoveredCron?.active).toBe(false);
      expect(runEmbeddedAgent.mock.calls[1]?.[0].prompt).toContain("Advance the active goal");
      expect(runEmbeddedAgent.mock.calls[2]?.[0].prompt).toContain("Advance the active goal");
      expect(loadSessionEntry(scope())).toMatchObject({
        sessionId,
        goal: { id: goal.id, status: "complete", continuationTurns: 2 },
      });
      expect(
        userMessages().every((message) => isRecord(message) && message.display === false),
      ).toBe(true);
    } finally {
      warnings.mockRestore();
      runtime.close();
    }
  });
}
