import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeRootScope } from "./root-scope.js";

function place() {
  const dir = mkdtempSync(join(tmpdir(), "root-scope-"));
  const opts = {
    dataDir: join(dir, "share", "banto"),
    configDir: join(dir, "config", "banto"),
    releaseDir: join(dir, "share", "banto-release"),
  };
  for (const p of Object.values(opts)) mkdirSync(p, { recursive: true });
  mkdirSync(join(dir, "work"));
  return { dir, opts };
}

test("更新の置き場（releaseDir）を含む根は広い——中の AI が repo.git・versions・current を書けてしまう", () => {
  const { dir, opts } = place();
  try {
    // dataDir・configDir を含まず、releaseDir だけを含む根
    const onlyRelease = describeRootScope(opts.releaseDir, { ...opts, dataDir: join(dir, "elsewhere"), configDir: join(dir, "elsewhere2") });
    assert.equal(onlyRelease.wide, true);
    assert.equal(onlyRelease.includes.length, 1);
    assert.match(onlyRelease.includes[0]!, /更新の置き場/);

    const share = describeRootScope(join(dir, "share"), opts);
    assert.equal(share.wide, true);
    assert.equal(share.includes.length, 2, "データと更新の置き場の両方");

    assert.deepEqual(describeRootScope(join(dir, "work"), opts), { wide: false, includes: [] });
    // 置き場の中の1つの版だけを根にしても、置き場全体は含まない
    assert.equal(describeRootScope(join(opts.releaseDir, "versions"), opts).wide, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseDir を渡さなければ、置き場は見ない（前と同じ）", () => {
  const { dir, opts } = place();
  try {
    const { releaseDir, ...rest } = opts;
    assert.equal(describeRootScope(releaseDir, rest).wide, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
