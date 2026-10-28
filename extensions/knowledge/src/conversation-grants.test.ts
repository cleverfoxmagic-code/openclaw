import { randomUUID } from "node:crypto";
import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { featurePrincipal } from "./access.js";
import { contract } from "./contract.js";
import { createKnowledgeService } from "./service.js";
import { parsePolicy } from "./stores-config.js";
import { Stores } from "./stores.js";
import {
  afterTest,
  defaultOrder,
  hostApi,
  operatorContext,
  toolContext,
  useTestTempDirs,
} from "./test-support.js";

const tempDirs = useTestTempDirs();
const GROUP = "agent:main:discord:channel:123";

async function fixture(options = {}) {
  const base = tempDirs.make("knowledge-grants-");
  const services: any = [];
  let capability: any;
  const host = hostApi(base, {
    agents: ["main", "research"],
    policy: { operatorRead: true, writesEnabled: true },
    ...options,
    extra: {
      registerService: (s: any) => services.push(s),
      registerMemoryCapability: (c: any) => (capability = c),
    },
  });
  const service = createKnowledgeService(host.api);
  afterTest(() => services.forEach((s: any) => s.stop()));
  const admin = operatorContext(host.api, ["operator.admin"]);
  const owner = toolContext(host.api, "main");
  // A host-minted conversation audience for a session key; each key is its own conversation.
  const sessionIds = new Map<string, string>();
  const chat = (sessionKey: string) => {
    sessionIds.set(sessionKey, sessionIds.get(sessionKey) ?? randomUUID());
    return toolContext(host.api, "main", {
      kind: "conversation",
      agentId: "main",
      sessionKey,
      sessionId: sessionIds.get(sessionKey),
    });
  };
  const save = (ctx: FeatureInvocationContext, title: string) =>
    service.save_page(
      { requestId: randomUUID(), title, type: "note", body: title + " body." },
      ctx,
    );
  const titles = async (ctx: FeatureInvocationContext) =>
    (await service.records({}, ctx)).records.map((r) => r.title).toSorted(defaultOrder);
  const grant = async (sessionKey: string, access: string, context = admin) => {
    const input = {
      expectedRevision: (await service.stores_snapshot({}, admin)).grants.revision,
      sessionKey,
      access,
    };
    expect(Check(contract.operations.stores_grant.input, input)).toBeTruthy();
    const result = await service.stores_grant(input as any, context);
    expect(Check(contract.operations.stores_grant.output, result), JSON.stringify(result)).toBe(
      true,
    );
    return result;
  };
  return {
    ...host,
    service,
    admin,
    owner,
    chat,
    save,
    titles,
    grant,
    capability: () => capability,
  };
}

it("an owner grant lets a group read, save, or both in the agent's private knowledge", async () => {
  const f = await fixture();
  const group = f.chat(GROUP),
    thread = f.chat(GROUP + ":thread:42"),
    other = f.chat("agent:main:discord:channel:1234");
  await f.save(f.owner, "Owner plan");
  // Ungranted: the group keeps its own conversation partition.
  await f.save(group, "Group note");
  expect(await f.titles(group)).toStrictEqual(["Group note"]);
  expect(await f.titles(f.owner)).toStrictEqual(["Owner plan"]);

  expect((await f.grant(GROUP, "read")).outcome).toBe("applied");
  expect(await f.titles(group)).toStrictEqual(["Owner plan"]);
  // Threads inherit their conversation's grant; a key that merely shares a prefix does not.
  expect(await f.titles(thread)).toStrictEqual(["Owner plan"]);
  expect(await f.titles(other)).toStrictEqual([]);
  await expect(f.save(group, "Not allowed")).rejects.toThrow(/read-only in this conversation/);
  await expect(f.save(thread, "Not allowed")).rejects.toThrow(/read-only/);
  expect((await f.service.status({}, group)).writesEnabled).toBe(false);
  // Save guidance leaves the read-only conversation's prompt; the owner keeps it.
  const tools = new Set(["knowledge_grep", "knowledge_remember"]);
  const prompt = (agentSessionKey: string) =>
    f.capability().promptBuilder({ availableTools: tools, agentSessionKey }).join("\n");
  expect(prompt(GROUP + ":thread:42")).not.toContain("knowledge_remember");
  expect(prompt("agent:main:main")).toContain("knowledge_remember");

  expect((await f.grant(GROUP, "read-write")).outcome).toBe("applied");
  await f.save(group, "Group decision");
  expect(await f.titles(f.owner)).toStrictEqual(["Group decision", "Owner plan"]);

  // Write-only: saves land in private knowledge; reads stay in the group's own partition.
  expect((await f.grant(GROUP, "write")).outcome).toBe("applied");
  await f.save(thread, "Thread fact");
  expect(await f.titles(group)).toStrictEqual(["Group note"]);
  expect(await f.titles(f.owner)).toStrictEqual(["Group decision", "Owner plan", "Thread fact"]);

  // Revoking restores the group's own partition; nothing else changed along the way.
  expect((await f.grant(GROUP, "none")).outcome).toBe("applied");
  expect(await f.titles(group)).toStrictEqual(["Group note"]);
  expect(await f.titles(other)).toStrictEqual([]);
  expect(f.host.config.plugins.entries.knowledge.config).not.toHaveProperty("conversationGrants");
});

it("revoking or narrowing a grant fences work already resolved against it", async () => {
  const f = await fixture();
  await f.save(f.owner, "Owner plan");
  await f.grant(GROUP, "read-write");
  const stores = new Stores(
    f.api,
    parsePolicy({ operatorRead: true, writesEnabled: true }),
    () => {},
  );
  afterTest(() => stores.stop());
  const open = async (write: boolean) => {
    const opened = await stores.open(
      featurePrincipal(f.chat(GROUP), true, write, "main", stores.grantFor),
      { provision: false },
    );
    if (opened.kind !== "ready") {
      throw new Error("expected a ready store");
    }
    expect(opened.access.scope).toStrictEqual({ visibility: "private" });
    return opened.access;
  };
  const [reading, writing] = [await open(false), await open(true)];
  await f.grant(GROUP, "read");
  reading.assertCurrent();
  expect(() => writing.assertCurrent()).toThrow(/read-only/);
  await f.grant(GROUP, "none");
  expect(() => reading.assertCurrent()).toThrow(/authority is required/);
});

it("grant changes need operator admin and the current revision; a lagged write still revokes", async () => {
  const f = await fixture({ lag: true });
  await f.save(f.owner, "Owner plan");
  const reader = operatorContext(f.api, ["operator.write"]);
  expect((await f.grant(GROUP, "read", reader)).outcome).toBe("forbidden");
  const stale = (await f.service.stores_snapshot({}, f.admin)).grants.revision;
  expect((await f.grant(GROUP, "read")).outcome).toBe("applied");
  const group = f.chat(GROUP);
  // config.current() has not published the write yet; Knowledge serves what it wrote.
  expect(await f.titles(group)).toStrictEqual(["Owner plan"]);
  const conflict = await f.service.stores_grant(
    { expectedRevision: stale, sessionKey: GROUP, access: "none" },
    f.admin,
  );
  expect(conflict.outcome).toBe("conflict");
  expect(conflict.snapshot!.grants.entries).toStrictEqual([
    { sessionKey: GROUP, agent: "main", access: "read" },
  ]);
  // Consecutive edits before the host publishes keep the latest write in force.
  const other = "agent:main:discord:channel:999";
  expect((await f.grant(other, "read")).outcome).toBe("applied");
  expect((await f.grant(GROUP, "none")).outcome).toBe("applied");
  expect((await f.grant(other, "none")).outcome).toBe("applied");
  expect(await f.titles(group)).toStrictEqual([]);
  expect(await f.titles(f.chat(other))).toStrictEqual([]);
  f.publish();
  expect(await f.titles(group)).toStrictEqual([]);
  expect((await f.grant("agent:ghost:discord:channel:1", "read")).outcome).toBe("invalid");
});

it("an invalid grants section grants nothing and is reported", async () => {
  const f = await fixture();
  await f.save(f.owner, "Owner plan");
  f.host.config = structuredClone(f.host.config);
  f.host.config.plugins.entries.knowledge.config.conversationGrants = { [GROUP]: "admin" };
  expect(await f.titles(f.chat(GROUP))).toStrictEqual([]);
  const snapshot = await f.service.stores_snapshot({}, f.admin);
  expect(snapshot.issues.join(" ")).toMatch(/conversation grants configuration is invalid/);
  expect(snapshot.grants.entries).toStrictEqual([]);
});
