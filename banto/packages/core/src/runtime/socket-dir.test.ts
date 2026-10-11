import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreSocketDir, SOCKET_NAME_ALLOWANCE, SOCKET_PATH_LIMIT } from "./socket-dir.js";

const uid = process.getuid!();

test("置き場の s に収まれば、そこを使う（0700）", () => {
  const base = mkdtempSync(join(tmpdir(), "sd-"));
  try {
    const dir = coreSocketDir(base, { uid, runtimeDir: undefined, tmpDir: base });
    assert.equal(dir, join(base, "s"));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("置き場が深くて収まらなければ、短い場所（XDG_RUNTIME_DIR、無ければ tmp）へ逃がす。置き場ごとに別の名前", () => {
  const base = mkdtempSync(join(tmpdir(), "sd-"));
  try {
    const deep = join(base, "x".repeat(SOCKET_PATH_LIMIT));
    const run = join(base, "run");
    mkdirSync(run);
    const a = coreSocketDir(deep, { uid, runtimeDir: run, tmpDir: base });
    assert.match(a, new RegExp(`^${run}/banto-[0-9a-f]{8}$`));
    assert.ok(Buffer.byteLength(a) + SOCKET_NAME_ALLOWANCE <= SOCKET_PATH_LIMIT);
    const b = coreSocketDir(`${deep}2`, { uid, runtimeDir: run, tmpDir: base });
    assert.notEqual(a, b);
    // XDG_RUNTIME_DIR が無ければ tmp に、uid を名前に入れて
    const c = coreSocketDir(deep, { uid, runtimeDir: join(base, "nope"), tmpDir: base });
    assert.match(c, new RegExp(`^${base}/banto-${uid}-[0-9a-f]{8}$`));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("逃がし先がこのユーザーだけのものでなければ（他人も読み書きできる）使わない", () => {
  const base = mkdtempSync(join(tmpdir(), "sd-"));
  try {
    const deep = join(base, "x".repeat(SOCKET_PATH_LIMIT));
    const first = coreSocketDir(deep, { uid, runtimeDir: undefined, tmpDir: base });
    chmodSync(first, 0o777);
    assert.throws(() => coreSocketDir(deep, { uid, runtimeDir: undefined, tmpDir: base }), /このユーザーだけのものではない/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
