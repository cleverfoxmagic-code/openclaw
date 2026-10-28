import path from "node:path";
import { expect, it, vi } from "vitest";
import { recoverStore } from "../agents/main-session-recovery/main-session-restart-recovery-store.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

it("records a confirmed restart notice in its agent history once without another display row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, secondary: {} } },
      channels: { signal: { enabled: true } },
    };
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    const target = {
      agentId: "secondary",
      sessionKey: "agent:secondary:main",
      sessionId: "interrupted-session",
      storePath: path.join(state.sessionsDir("secondary"), "sessions.json"),
    };
    const delivery = { channel: "signal", to: "synthetic-recipient", accountId: "work" };
    await replaceSessionEntry(target, {
      sessionId: target.sessionId,
      lifecycleRevision: "interrupted-generation",
      updatedAt: 100,
      status: "interrupted",
      abortedLastRun: true,
      delivery: normalizeSessionDeliveryState({ context: delivery }),
      mainRestartRecovery: { cycleId: "exhausted-cycle", revision: 1, chargedAttempts: 3 },
    } satisfies InternalSessionEntry);
    expect(deliveryContextFromSession(loadSessionEntry(target))).toEqual(delivery);
    const sendText = vi.fn(async (_context: { text: string }) => ({
      channel: "signal",
      messageId: "notice-message",
    }));
    const plugin = {
      ...createChannelTestPluginBase({
        id: "signal",
        config: { listAccountIds: () => ["work"], isConfigured: () => true },
      }),
      outbound: {
        deliveryMode: "direct" as const,
        resolveTarget: ({ to }: { to?: string }) => ({ ok: true as const, to: to ?? "" }),
        sendText,
      },
    };
    const registry = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(
      createTestRegistry([{ pluginId: "signal", source: "test", plugin }]),
      null,
      "default",
    );
    const context = {
      trackExecution: trackAsyncWork,
      deps: {},
      getRuntimeConfig: () => cfg,
      logGateway: { warn: vi.fn(), error: vi.fn() },
      dedupe: new Map(),
    } as unknown as GatewayRequestContext;
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => createGatewayMethodRegistry([]),
      isDispatchAvailable: () => true,
    });
    const sendNotice = vi.spyOn(runtime.recovery, "sendRecoveryNotice");
    try {
      const recover = () =>
        recoverStore({
          cfg,
          storeAgentId: target.agentId,
          storePath: target.storePath,
          stateDir: state.stateDir,
          handledSessionKeys: new Set(),
          gatewayRuntime: runtime.recovery,
        });
      await recover();
      expect(loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeDefined();
      expect(sendNotice).toHaveBeenCalledOnce();
      await expect(sendNotice.mock.results[0]?.value).resolves.toEqual({ suppressed: false });
      expect(sendText).toHaveBeenCalledOnce();
      const messages = (await loadTranscriptEvents(target))
        .map(readTranscriptEventMessage)
        .filter(Boolean);
      const sentText = sendText.mock.calls[0]?.[0].text;
      expect(sentText).toContain("gateway restart");
      expect(messages[0]).toMatchObject({ content: [{ type: "text", text: sentText }] });
      const confirmed = messages.filter((message) => message?.model === "automation-result");
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]).toMatchObject({ display: false });
      expect(messages.filter((message) => message?.display !== false)).toHaveLength(1);
      await recover();
      expect(sendText).toHaveBeenCalledOnce();
      expect(
        (await loadTranscriptEvents(target)).map(readTranscriptEventMessage).filter(Boolean),
      ).toEqual(messages);
      expect(
        loadSessionEntry({
          ...target,
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath: path.join(state.sessionsDir("main"), "sessions.json"),
        }),
      ).toBeUndefined();
    } finally {
      sendNotice.mockRestore();
      runtime.close();
      restoreActivePluginRegistrySnapshot(registry);
    }
  });
});
