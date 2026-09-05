#!/usr/bin/env node
// docs/specs/v4-modules.md §2.1 Vault のインターフェース。A(agent)/B(module)/C(admin)
// の3段可視性を _meta["dev.banto/visibility"] に載せる。

import { randomUUID, createHmac } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VISIBILITY_META_KEY, MODULE_META_KEY } from "@banto/module-contract";
import { SopsBackend } from "./sops-backend.js";
import { AliasRegistry, type AliasMeta } from "./alias-registry.js";

export function createVaultServer(dataDir: string) {
  const backend = new SopsBackend(dataDir);
  const registry = new AliasRegistry(dataDir);

  const server = new Server(
    { name: "banto-module-vault", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  const initPromise = (async () => {
    await backend.init();
    await registry.load();
  })();

  function tool(name: string, description: string, inputSchema: unknown, visibility: "agent" | "module" | "admin") {
    return { name, description, inputSchema, _meta: { [VISIBILITY_META_KEY]: visibility } };
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await initPromise;
    return {
      tools: [
        tool(
          "requestAlias",
          "このaliasが要るが無い、という判断待ちを起こす",
          { type: "object", properties: { name: { type: "string" }, hint: { type: "string" }, kind: { type: "string" } }, required: ["name"] },
          "agent",
        ),
        tool(
          "resolveAlias",
          "aliasを値に解決する",
          { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          "module",
        ),
        tool(
          "startSshAgent",
          "ssh-agent経由でsocketPathを返す。秘密鍵は返さない",
          { type: "object", properties: { identity: { type: "string" } }, required: ["identity"] },
          "module",
        ),
        tool(
          "generateKeypair",
          "新しいSSH鍵ペアを生成し、公開鍵だけを返す",
          { type: "object", properties: { identity: { type: "string" }, kind: { type: "string" } }, required: ["identity", "kind"] },
          "module",
        ),
        tool(
          "verify",
          "aliasの値をHMAC鍵として署名を検証する。値は返さない",
          { type: "object", properties: { alias: { type: "string" }, payload: { type: "string" }, signature: { type: "string" } }, required: ["alias", "payload", "signature"] },
          "module",
        ),
        tool(
          "createAlias",
          "aliasを新規登録する（人専用）",
          { type: "object", properties: { name: { type: "string" }, kind: { type: "string" }, scope: { type: "string" }, value: { type: "string" }, note: { type: "string" } }, required: ["name", "kind", "scope", "value"] },
          "admin",
        ),
        tool(
          "deleteAlias",
          "aliasを削除する（人専用）",
          { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          "admin",
        ),
        tool(
          "listGroups",
          "backendのグループ一覧（人専用）",
          { type: "object", properties: {} },
          "admin",
        ),
        tool(
          "createGroup",
          "backendに新しいグループを作る（人専用）",
          { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          "admin",
        ),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    await initPromise;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    switch (request.params.name) {
      case "requestAlias": {
        const name = String(args.name);
        if (registry.get(name)) {
          return { content: [{ type: "text", text: `alias "${name}" は既に登録されています` }] };
        }
        // 人に聞くのはElicitationに乗せる（自前で作らない、アーキ仕様§2.4）。
        await server.elicitInput({
          message: `Vaultに alias "${name}" が無いため、登録が要ります（用途: ${args.hint ?? "不明"}）`,
          requestedSchema: { type: "object", properties: {}, required: [] },
        }).catch(() => undefined); // タイムアウトはSDK/Module側の既定に委ねる
        return { content: [{ type: "text", text: `REQUEST-ACCEPTED alias=${name}` }] };
      }
      case "resolveAlias": {
        const name = String(args.name);
        const meta = registry.get(name);
        if (!meta) throw new Error(`alias "${name}" not found`);
        const value = await backend.getSecret(meta.backendPath);
        await registry.markUsed(name);
        return { content: [{ type: "text", text: String(value) }] };
      }
      case "startSshAgent": {
        const meta = registry.get(String(args.identity));
        if (!meta) throw new Error(`identity "${args.identity}" not found`);
        const { socketPath } = await backend.loadIntoAgent(meta.backendPath);
        return { content: [{ type: "text", text: JSON.stringify({ socketPath }) }] };
      }
      case "generateKeypair": {
        const { publicKey, privateKeyRef } = await backend.generateKeypair("ssh");
        const name = String(args.identity);
        await registry.create({ name, kind: "ssh-identity", scope: "instance", backendPath: privateKeyRef });
        return { content: [{ type: "text", text: JSON.stringify({ publicKey }) }] };
      }
      case "verify": {
        const meta = registry.get(String(args.alias));
        if (!meta) throw new Error(`alias "${args.alias}" not found`);
        const key = await backend.getSecret(meta.backendPath);
        const expected = createHmac("sha256", String(key)).update(String(args.payload)).digest("hex");
        return { content: [{ type: "text", text: String(expected === args.signature) }] };
      }
      case "createAlias": {
        const name = String(args.name);
        const group = "user-secrets";
        await backend.createGroup(group);
        const backendPath = `${group}/${name}`;
        await backend.putSecret(backendPath, String(args.value));
        await registry.create({
          name,
          kind: args.kind as AliasMeta["kind"],
          scope: args.scope as AliasMeta["scope"],
          note: args.note as string | undefined,
          backendPath,
        });
        return { content: [{ type: "text", text: `created ${name}` }] };
      }
      case "deleteAlias": {
        const name = String(args.name);
        const meta = registry.get(name);
        if (meta) await backend.deleteSecret(meta.backendPath);
        await registry.delete(name);
        return { content: [{ type: "text", text: `deleted ${name}` }] };
      }
      case "listGroups":
        return { content: [{ type: "text", text: JSON.stringify(await backend.listGroups()) }] };
      case "createGroup":
        await backend.createGroup(String(args.name));
        return { content: [{ type: "text", text: "ok" }] };
      default:
        throw new Error(`unknown tool: ${request.params.name}`);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    await initPromise;
    return {
      resources: registry.list().map((a) => ({
        uri: `vault://aliases/${a.name}`,
        name: a.name,
        mimeType: "application/json",
        _meta: { [VISIBILITY_META_KEY]: "agent" },
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    await initPromise;
    if (request.params.uri === "vault://aliases") {
      const list = registry.list().map(({ backendPath: _drop, ...rest }) => rest);
      return { contents: [{ uri: request.params.uri, mimeType: "application/json", text: JSON.stringify(list) }] };
    }
    const match = request.params.uri.match(/^vault:\/\/aliases\/(.+)$/);
    if (match) {
      const meta = registry.get(match[1]!);
      if (!meta) throw new Error("not found");
      const { backendPath: _drop, ...rest } = meta;
      return { contents: [{ uri: request.params.uri, mimeType: "application/json", text: JSON.stringify(rest) }] };
    }
    throw new Error(`unknown resource: ${request.params.uri}`);
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const dataDir = process.env.BANTO_VAULT_DATA_DIR ?? `${process.env.HOME}/.local/share/banto/vault`;
  const server = createVaultServer(dataDir);
  await server.connect(new StdioServerTransport());
}
