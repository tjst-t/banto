/**
 * AC-Scc9152-1-3: daemonがタスクファイルのfrontmatterへ実行時状態を書き戻さない
 *
 * After ingest: file content and mtime are unchanged.
 * After additional transitions via API: file is still untouched.
 *
 * Uses a real Daemon instance (port 0) with real tmpRepoDir.
 * Polling interval 500ms.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";

async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (val: T) => boolean,
  timeoutMs: number = 5000,
  intervalMs: number = 200
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const val = await fn();
    if (pred(val)) return val;
    if (Date.now() >= deadline) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("[AC-Scc9152-1-3] Daemon never writes runtime state back to task file", () => {
  let tmpDataDir: string;
  let tmpRepoDir: string;
  let daemon: Daemon;
  let base: string;
  let taskFile: string;
  let originalContent: string;
  let originalMtimeMs: number;

  before(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-nw-data-"));
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-nw-repo-"));

    fs.mkdirSync(path.join(tmpRepoDir, "work", "tasks"), { recursive: true });

    daemon = Daemon.create({ port: 0, dataDir: tmpDataDir, watchIntervalMs: 500 });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const res = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-nw", repoPath: tmpRepoDir }),
    });
    assert.equal(res.status, 201);

    // Write the task file and record original state
    taskFile = path.join(tmpRepoDir, "work", "tasks", "task-0001-nw.md");
    originalContent = `---
id: task-0001
type: task
kind: feature
title: ノーライトバックテスト
status: draft
scope:
  paths: [src/**]
acceptance:
  - { id: a1, text: 動作確認 }
---

## 背景

ファイルへの書き戻し禁止確認用タスク。
`;
    fs.writeFileSync(taskFile, originalContent, "utf-8");
    originalMtimeMs = fs.statSync(taskFile).mtimeMs;

    // Wait for watcher to ingest and task to reach queued
    await pollUntil(
      async () => {
        const r = await fetch(`${base}/api/v1/projects/proj-nw/tasks/task-0001`);
        if (r.status !== 200) return null;
        const b = await r.json() as { task: { status: string } };
        return b.task;
      },
      (t) => t !== null && t.status === "queued",
      5000
    );
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("[AC-Scc9152-1-3] frontmatter status is still 'draft' after ingest (not written back)", () => {
    const contentAfter = fs.readFileSync(taskFile, "utf-8");
    assert.equal(contentAfter, originalContent, "file content must be byte-for-byte identical");
    assert.ok(
      contentAfter.includes("status: draft"),
      "frontmatter status must remain 'draft'"
    );
  });

  it("[AC-Scc9152-1-3] mtime is unchanged after ingest", () => {
    const mtimeAfter = fs.statSync(taskFile).mtimeMs;
    assert.equal(
      mtimeAfter,
      originalMtimeMs,
      "file mtime must not change — daemon must not write to the file"
    );
  });

  it("[AC-Scc9152-1-3] file unchanged after additional API transition to ready", async () => {
    // Trigger a further transition via API (queued → ready)
    const res = await fetch(`${base}/api/v1/projects/proj-nw/tasks/task-0001/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "ready" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { task: { status: string } };
    assert.equal(body.task.status, "ready");

    // File must still be byte-for-byte identical
    const contentAfterTransition = fs.readFileSync(taskFile, "utf-8");
    assert.equal(
      contentAfterTransition,
      originalContent,
      "file content must be byte-for-byte identical after API transition"
    );
    const mtimeAfterTransition = fs.statSync(taskFile).mtimeMs;
    assert.equal(
      mtimeAfterTransition,
      originalMtimeMs,
      "mtime must be unchanged after API-triggered transition"
    );
  });
});
