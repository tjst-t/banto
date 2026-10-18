// 目録から何本かをまとめて入れる（追加・2026-10-18、ユーザー決定「Module をまとめて入れる」）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { RuntimeConfigStore } from "../config/runtime.js";
import {
  BUNDLED_CATALOG,
  ModuleDeclarationError,
  catalogInstalled,
  catalogRequires,
  installCatalogBulk,
  installFromCatalog,
  listInstanceModules,
} from "./declaration.js";

async function withConfig(fn: (config: RuntimeConfigStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-catalog-bulk-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const config = new RuntimeConfigStore(dir, log);
    await config.load();
    await fn(config);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const entry = (id: string) => BUNDLED_CATALOG.find((e) => e.id === id)!;

test("要るものは目録から引き当てる——既定が名乗る役割（subagent・vault）は数えない", () => {
  assert.deepEqual(catalogRequires(entry("factory")), ["backlog"]);
  assert.deepEqual(catalogRequires(entry("publish-directory")), ["publish-caddy"]);
  // service は vault-directory・vault を required で持つが、どちらも既定にある
  assert.deepEqual(catalogRequires(entry("service")), []);
  assert.deepEqual(catalogRequires(entry("backlog")), []);
});

test("選んだものに要る目録の Module を先に足し、人が選んでいないものには requiredBy を付ける", async () => {
  await withConfig(async (config) => {
    const results = await installCatalogBulk(config, ["factory", "publish-directory"]);
    assert.deepEqual(
      results.map((r) => [r.id, r.status, r.requiredBy ?? null]),
      [
        ["backlog", "installed", ["factory"]],
        ["factory", "installed", null],
        ["publish-caddy", "installed", ["publish-directory"]],
        ["publish-directory", "installed", null],
      ],
    );
    const names = listInstanceModules(config).map((m) => m.name);
    for (const n of ["backlog", "factory", "publish-caddy", "publish-directory"]) assert.ok(names.includes(n), n);
    assert.deepEqual(catalogInstalled(config).get("factory"), ["factory"]);
  });
});

test("入れてあるものは入れ直さない。名前がぶつかれば -2 を付ける", async () => {
  await withConfig(async (config) => {
    await installFromCatalog(config, "backlog", "my-backlog");
    // 目録と同じコードを別の名前で入れてあれば「入れてある」
    const results = await installCatalogBulk(config, ["backlog", "factory"]);
    assert.deepEqual(
      results.map((r) => [r.id, r.status, r.name]),
      [
        ["backlog", "already", "my-backlog"],
        ["factory", "installed", "factory"],
      ],
    );
    assert.ok(!listInstanceModules(config).some((m) => m.name === "backlog"), "入れ直している");
  });
});

test("接続先ごとのもの・画面に出さないもの・知らないものは断る（何も入れない）", async () => {
  await withConfig(async (config) => {
    const before = listInstanceModules(config).length;
    await assert.rejects(installCatalogBulk(config, ["vault-infisical"]), ModuleDeclarationError);
    await assert.rejects(installCatalogBulk(config, ["tools-probe"]), ModuleDeclarationError);
    await assert.rejects(installCatalogBulk(config, ["browser", "nope"]), ModuleDeclarationError);
    assert.equal(listInstanceModules(config).length, before);
  });
});
