import { coerceErrorMessage } from "@openclaw/normalization-core";
import { setConfiguredMcpServer, unsetConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import { withMcpLifecycleLease } from "../agents/mcp-lifecycle-lease.js";
import { canonicalizeConfiguredMcpServer } from "../config/mcp-config-normalize.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { digestTemplateValue } from "./digest.js";
import {
  TEMPLATE_MCP_REF_SCHEMA_VERSION,
  type PersistedTemplateMcpServerRef,
} from "./mcp-records.js";
import type { TemplateMutationStateOptions } from "./state-mutation-options.js";
import type { TemplateAddPlan, TemplateMcpServer } from "./types.js";

export type { PersistedTemplateMcpServerRef } from "./mcp-records.js";

export class TemplateMcpInstallError extends Error {
  constructor(
    message: string,
    readonly mcpServers: PersistedTemplateMcpServerRef[],
  ) {
    super(message);
    this.name = "TemplateMcpInstallError";
  }
}

function mcpServerFromActionDetails(
  details: Record<string, unknown>,
): TemplateMcpServer | undefined {
  const { expectedState: _expectedState, prerequisites: _prerequisites, ...server } = details;
  return "command" in server || "url" in server ? (server as TemplateMcpServer) : undefined;
}

export function digestTemplateMcpServer(server: Record<string, unknown>): string {
  return digestTemplateValue(canonicalizeConfiguredMcpServer(server));
}

/** A rejected write may still have committed; claim it only when the stored config matches. */
async function isTemplateMcpServerCommitted(name: string, configDigest: string): Promise<boolean> {
  const listed = await listConfiguredMcpServers().catch(() => null);
  const current = listed?.ok ? listed.mcpServers[name] : undefined;
  return current !== undefined && digestTemplateMcpServer(current) === configDigest;
}

/** Add a shared MCP requirement without creating a Template ownership record. */
export async function installTemplateMcpServersStateless(
  plan: TemplateAddPlan,
  options: TemplateMutationStateOptions & {
    assertForwardCurrent?: () => void;
    nowMs?: number;
  } = {},
): Promise<PersistedTemplateMcpServerRef[]> {
  const refs: PersistedTemplateMcpServerRef[] = [];
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    await withMcpLifecycleLease(action.id, options, async (lease) => {
      const assertCurrent = () => {
        lease.assertCurrent();
        options.assertCurrent?.();
        options.assertForwardCurrent?.();
      };
      const server = action.details ? mcpServerFromActionDetails(action.details) : undefined;
      if (!server) {
        throw new TemplateMcpInstallError(
          `MCP server action ${JSON.stringify(action.id)} is invalid.`,
          refs,
        );
      }
      const listed = await listConfiguredMcpServers();
      assertCurrent();
      if (!listed.ok) {
        throw new TemplateMcpInstallError(listed.error, refs);
      }
      const configured = listed.mcpServers[action.id];
      const configDigest = digestTemplateMcpServer(server);
      if (configured && digestTemplateMcpServer(configured) !== configDigest) {
        throw new TemplateMcpInstallError(
          `MCP server ${JSON.stringify(action.id)} already exists with different configuration.`,
          refs,
        );
      }
      const nowMs = options.nowMs ?? Date.now();
      const ref: PersistedTemplateMcpServerRef = {
        schemaVersion: TEMPLATE_MCP_REF_SCHEMA_VERSION,
        agentId: plan.agent.finalId,
        name: action.id,
        configDigest,
        relationship: configured ? "referenced" : "managed",
        origin: configured ? "pre-existing" : "template-introduced",
        independentOwner: true,
        status: "complete",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      if (!configured) {
        try {
          const result = await setConfiguredMcpServer({
            name: action.id,
            server,
            createOnly: true,
            skipLifecycleLease: true,
            assertCurrent,
            assertCurrentAsync: async () => {
              await options.prepareEffect?.();
              await lease.assertOwned();
              assertCurrent();
            },
          });
          if (!result.ok) {
            throw new TemplateMcpInstallError(result.error, refs);
          }
          refs.push(ref);
          assertCurrent();
        } catch (error) {
          if (error instanceof TemplateMcpInstallError) {
            throw error;
          }
          // The config write can commit before a later step fails (post-commit assertion, OAuth
          // cleanup, or a lost acknowledgement); claim the entry so the caller can roll it back.
          if (
            !refs.includes(ref) &&
            (await isTemplateMcpServerCommitted(action.id, configDigest))
          ) {
            refs.push(ref);
          }
          throw new TemplateMcpInstallError(coerceErrorMessage(error), refs);
        }
      }
      if (configured) {
        refs.push(ref);
      }
    });
  }
  return refs;
}

/** Remove unchanged MCP entries introduced before a failed Add published its agent. */
export async function rollbackStatelessTemplateMcpServers(
  refs: PersistedTemplateMcpServerRef[],
  options: TemplateMutationStateOptions = {},
): Promise<string[]> {
  const errors: string[] = [];
  for (const ref of refs.toReversed()) {
    if (ref.origin !== "template-introduced" || ref.status !== "complete") {
      continue;
    }
    try {
      await withMcpLifecycleLease(ref.name, options, async (lease) => {
        const assertCurrent = () => {
          lease.assertCurrent();
          options.assertCurrent?.();
        };
        const listed = await listConfiguredMcpServers();
        assertCurrent();
        if (!listed.ok) {
          throw new Error(listed.error);
        }
        const configured = listed.mcpServers[ref.name];
        if (!configured) {
          refs.splice(refs.indexOf(ref), 1);
          return;
        }
        if (digestTemplateMcpServer(configured) !== ref.configDigest) {
          return;
        }
        const removed = await unsetConfiguredMcpServer({
          name: ref.name,
          expectedServer: configured,
          skipLifecycleLease: true,
          assertCurrent,
          assertCurrentAsync: async () => {
            await options.prepareEffect?.();
            await lease.assertOwned();
            assertCurrent();
          },
        });
        assertCurrent();
        if (!removed.ok) {
          // A concurrent change is not ours to remove.
          if (removed.error.includes("changed and was not removed")) {
            return;
          }
          throw new Error(removed.error);
        }
        refs.splice(refs.indexOf(ref), 1);
      });
    } catch (error) {
      errors.push(`MCP server ${ref.name} cleanup failed: ${coerceErrorMessage(error)}`);
    }
  }
  return errors;
}
