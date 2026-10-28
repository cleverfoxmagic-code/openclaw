import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { resolveImplicitProviders } from "../../models-config.providers.implicit.js";
import {
  bindPreparedModelRuntimeAuth,
  getPreparedModelRuntimeAuthStore,
} from "../../prepared-model-runtime-auth.js";
import { prepareCapturedRuntimeFacts } from "../../prepared-model-runtime.configured-catalog.js";
import { acquireAgentRunPreparedModelRuntime } from "../../prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../prepared-model-runtime.test-support.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "../../sessions/index.js";
import { resolveSubagentModelAndThinkingPlan } from "./subagent-spawn-plan.js";

const published = vi.hoisted((): { owner?: PreparedModelRuntimeSnapshot } => ({}));
vi.mock("../../prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../prepared-model-catalog.js")>()),
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
  withPreparedModelCatalogOwner: async <T>(
    _params: unknown,
    read: (owner: PreparedModelRuntimeSnapshot) => T | Promise<T>,
  ) => {
    if (!published.owner) {
      throw new Error("No published test model owner");
    }
    return await read(published.owner);
  },
}));

const rootUrl = "https://clawrouter.openclaw.ai";
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

afterEach(async () => {
  published.owner = undefined;
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  vi.restoreAllMocks();
});

// External I/O only is synthetic. The bundled plugin, credential-scoped discovery,
// configured-row merge, registry, prepared catalog and spawn model admission are real.
it("admits configured ClawRouter rows that resolve onto their granted routes", async () => {
  await withOpenClawTestState(
    {
      label: "clawrouter-subagent-spawn",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
        CLAWROUTER_API_KEY: undefined,
      },
    },
    async (state) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : input.toString();
        expect(url).toBe(`${rootUrl}/v1/catalog`);
        return Response.json({
          providers: [
            {
              id: "openai",
              displayName: "OpenAI",
              openaiCompatible: true,
              nativeBaseUrl: "/v1/native/openai",
              routes: [],
              models: [
                {
                  id: "openai/gpt-6.1-sol",
                  upstream: "gpt-6.1-sol",
                  capabilities: ["llm.responses", "llm.chat"],
                },
              ],
            },
            {
              id: "anthropic",
              displayName: "Anthropic",
              openaiCompatible: false,
              nativeBaseUrl: "/v1/native/anthropic",
              routes: [
                { path: "/v1/messages", requestFormat: "anthropic.messages", methods: ["POST"] },
              ],
              models: [
                {
                  id: "anthropic/claude-opus-5-5",
                  upstream: "claude-opus-5-5",
                  capabilities: ["llm.messages"],
                },
              ],
            },
          ],
        });
      });
      // Users commonly configure the service root while discovery serves each model
      // on its own /v1 or native endpoint.
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir } },
        models: {
          providers: {
            clawrouter: {
              baseUrl: rootUrl,
              apiKey: "synthetic-granted",
              models: [
                {
                  id: "openai/gpt-6.1-sol",
                  name: "GPT-6.1 Sol via ClawRouter",
                  api: "openai-responses",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: zeroCost,
                  contextWindow: 1_050_000,
                  maxTokens: 128_000,
                },
                {
                  id: "anthropic/claude-opus-5-5",
                  name: "Claude Opus 5.5 via ClawRouter",
                  api: "anthropic-messages",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: zeroCost,
                  contextWindow: 1_000_000,
                  maxTokens: 128_000,
                },
              ],
            },
          },
        },
        plugins: {
          allow: ["clawrouter"],
          entries: { clawrouter: { enabled: true } },
          slots: { memory: "none" },
        },
      };
      await state.writeConfig(cfg);
      await using lease = await acquireAgentRunPreparedModelRuntime({
        config: cfg,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
      });
      const metadataSnapshot = lease.snapshot.metadataSnapshot;
      // Discovery merges configured rows with the credential's live inventory.
      const providers = await resolveImplicitProviders({
        agentDir: state.agentDir(),
        config: cfg,
        env: state.env,
        workspaceDir: state.workspaceDir,
        explicitProviders: cfg.models?.providers,
        pluginMetadataSnapshot: metadataSnapshot,
      });
      const authStorage = AuthStorage.inMemory({});
      const modelRegistry = ModelRegistry.create(authStorage, "captured:clawrouter", {
        config: cfg,
        pluginMetadataSnapshot: metadataSnapshot,
        modelsJsonContents: JSON.stringify({ providers }),
        pluginCatalogs: [],
      });
      const { modelCatalog } = prepareCapturedRuntimeFacts({
        agentFacts: {
          input: { config: cfg },
          configuredModelRefs: [
            { provider: "clawrouter", modelId: "openai/gpt-6.1-sol" },
            { provider: "clawrouter", modelId: "anthropic/claude-opus-5-5" },
          ],
        },
        workspaceFacts: { pluginMetadataSnapshot: metadataSnapshot, inlineProviderModels: [] },
        templateModelRegistry: modelRegistry,
        configuredRuntimeModels: [],
      });
      published.owner = {
        ...lease.snapshot,
        config: cfg,
        modelCatalog,
        createStores: () => ({ authStorage, modelRegistry }),
      };
      // Prepared auth facts are bound to the owner object, not copied with its fields.
      bindPreparedModelRuntimeAuth(published.owner, {
        store: getPreparedModelRuntimeAuthStore(lease.snapshot) ?? { version: 1, profiles: {} },
      });

      for (const modelOverride of [
        "clawrouter/openai/gpt-6.1-sol",
        "clawrouter/anthropic/claude-opus-5-5",
      ]) {
        const plan = await resolveSubagentModelAndThinkingPlan({
          cfg,
          targetAgentId: "main",
          modelOverride,
          workspaceDir: state.workspaceDir,
        });
        expect(plan.status === "error" ? plan.error : undefined).toBeUndefined();
        expect(plan).toMatchObject({ status: "ok", resolvedModel: modelOverride });
      }

      // Configured rows keep their authored route; ClawRouter resolves them onto the
      // granted endpoint, so the discovered grant must not become a chat veto.
      expect(
        modelCatalog.entries
          .filter((entry) => entry.provider === "clawrouter")
          .map(({ id, inference }) => ({ id, chat: inference?.chat })),
      ).toEqual([
        { id: "openai/gpt-6.1-sol", chat: undefined },
        { id: "anthropic/claude-opus-5-5", chat: undefined },
      ]);
    },
  );
});
