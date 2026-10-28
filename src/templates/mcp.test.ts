import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { listConfiguredMcpServers, mcpConfigInternal } from "../config/mcp-config.js";
import { closeStateDatabaseForTest as closeState } from "../test-utils/database-cleanup.js";
import { TEMPLATE_SCHEMA_VERSION } from "./manifest-contract.js";
import {
  TemplateMcpInstallError,
  installTemplateMcpServersStateless,
  rollbackStatelessTemplateMcpServers,
} from "./mcp.js";
import {
  TEMPLATE_ADD_PLAN_SCHEMA_VERSION,
  TEMPLATE_OUTPUT_STABILITY,
  type TemplateAddPlan,
} from "./types.js";

const SERVER = { command: "uvx", args: ["fixture-mcp"] };

function fixturePlan(): TemplateAddPlan {
  return {
    schemaVersion: TEMPLATE_ADD_PLAN_SCHEMA_VERSION,
    manifestSchemaVersion: TEMPLATE_SCHEMA_VERSION,
    stability: TEMPLATE_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "fixture",
    template: {
      kind: "development",
      name: "fixture-template",
      version: "0.0.0",
      packageRoot: "/fixture",
      manifestPath: "/fixture/template.json",
      integrityKind: "development-snapshot",
      integrity: "fixture",
      byteLength: 0,
    },
    agent: {
      requestedId: "main",
      finalId: "main",
      workspace: "/fixture/workspace",
      config: { id: "main", workspace: "/fixture/workspace" },
    },
    summary: {
      totalActions: 1,
      agentActions: 0,
      workspaceActions: 0,
      packageActions: 0,
      mcpServerActions: 1,
      cronJobActions: 0,
      blockedActions: 0,
      capabilityEscalations: 0,
    },
    actions: [
      {
        kind: "mcpServer",
        id: "fixture",
        action: "configure",
        target: "mcp.servers.fixture",
        details: SERVER,
        blocked: false,
      },
    ],
    capabilityChanges: [],
    readiness: { ready: true, requirements: [] },
    blockers: [],
    diagnostics: [],
  };
}

async function installExpectingError(): Promise<TemplateMcpInstallError> {
  const error = await installTemplateMcpServersStateless(fixturePlan()).catch(
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(TemplateMcpInstallError);
  return error as TemplateMcpInstallError;
}

async function configured(name: string) {
  const listed = await listConfiguredMcpServers();
  expect(listed.ok).toBe(true);
  return listed.ok ? listed.mcpServers[name] : undefined;
}

function loseAcknowledgementAfterCommit() {
  const realSet = mcpConfigInternal.set;
  vi.spyOn(mcpConfigInternal, "set").mockImplementationOnce(async (params, onCommitted) => {
    await realSet(params, onCommitted);
    throw new Error("config write acknowledgement lost after commit");
  });
}

afterEach(() => vi.restoreAllMocks());

it.aroundEach((run) =>
  withTempHome(
    async () => {
      await closeState();
      try {
        await run();
      } finally {
        await closeState();
      }
    },
    {
      prefix: "openclaw-template-mcp-write-",
      skipSessionCleanup: true,
      env: {
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_STATE_DIR: (home) => path.join(home, ".openclaw"),
      },
    },
  ),
);

it.each([{ changed: false }, { changed: true }])(
  "reconciles a committed MCP write (changed by another writer: $changed)",
  async ({ changed }) => {
    loseAcknowledgementAfterCommit();
    const error = await installExpectingError();
    expect(error.mcpServers).toHaveLength(1);

    if (changed) {
      await mcpConfigInternal.set({
        name: "fixture",
        server: { command: "uvx", args: ["changed-after-failure"] },
      });
    }
    await expect(rollbackStatelessTemplateMcpServers(error.mcpServers)).resolves.toEqual([]);
    expect(await configured("fixture")).toEqual(
      changed ? expect.objectContaining({ args: ["changed-after-failure"] }) : undefined,
    );
  },
);

it("does not claim an MCP server whose write never committed", async () => {
  vi.spyOn(mcpConfigInternal, "set").mockRejectedValueOnce(new Error("write refused"));

  const error = await installExpectingError();
  expect(error.mcpServers).toEqual([]);
  expect(await configured("fixture")).toBeUndefined();
});
