import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { acceptCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import { buildMainSessionRecoverySettlementPatch } from "../agents/main-session-recovery/main-session-recovery-clear.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { recoveryFixture } from "./operator-run-recovery.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

type RecoveryFixture = Awaited<ReturnType<typeof recoveryFixture>>;
export function registerReplyRecoveryPolicyHandoffCase(
  withRecovery: (run: (fixture: RecoveryFixture) => Promise<void>) => Promise<void>,
): void {
  it("retains ordinary reply policy through compaction after retiring the recovery claim, but not reset", () =>
    withRecovery(async (fixture) => {
      const source = expectDefined(await fixture.restore(), "restored recovery source");
      using restored = { ...source, [Symbol.dispose]: source.release };
      const retained = expectDefined(
        await captureGatewayOperatorRunAuthority({
          client: createSyntheticPluginRuntimeClient({
            operatorRunAuthority: restored.authority,
            scopes: [...restored.authority.scopes],
          }),
          context: fixture.context,
          independentContinuation: true,
        }),
        "independent reply authority",
      );
      try {
        const onCommitted = expectDefined(
          restored.onReplyInputCommitted,
          "reply ownership receipt",
        );
        await patchSessionEntryCore(fixture.target, (entry) =>
          buildMainSessionRecoverySettlementPatch({ entry, recordTerminalSource: true }),
        );
        onCommitted();
        fixture.retire();
        expect(retained.authority.assertCurrent).not.toThrow();
        const entry = expectDefined(loadSessionEntry(fixture.target), "admitted reply session");
        const compacted = await acceptCompactionSuccessor({
          currentTarget: fixture.target,
          expectedEntry: {
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            activeWriterRunId: entry.activeWriterRunId,
          },
          assertActive: retained.authority.assertCurrent,
          result: {
            ok: true,
            compacted: true,
            result: { sessionId: "ordinary-reply-compaction", tokensBefore: 120, tokensAfter: 42 },
          },
        });
        expect(retained.authority.assertCurrent).not.toThrow();
        await replaceSessionEntry(fixture.target, {
          ...compacted.entry,
          sessionId: "operator-reset-after-compaction",
          lifecycleRevision: "reset-revision",
        });
        expect(retained.authority.assertCurrent).toThrow();
        expect(retained.authority.signal?.aborted).toBe(true);
      } finally {
        retained.release();
      }
    }));
}
