// Shell 専用のホーム（決定・2026-09-23、ユーザー）。本物の git で整える。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellHomeEntryProblem, syncShellHome } from "./shell-home.js";

async function withHomes(fn: (ctx: { source: string; shellHome: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "banto-shell-home-"));
  try {
    const source = join(root, "user");
    const shellHome = join(root, "shell-home");
    await mkdir(join(source, ".config", "git"), { recursive: true });
    await fn({ source, shellHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const gitGet = (file: string, key: string) => {
  try {
    return execFileSync("git", ["config", "--file", file, "--get-all", key], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

test("git の設定を写し、資格情報の取り出し役と include を外し、ホームを指す値を向け直す", async () => {
  await withHomes(async ({ source, shellHome }) => {
    await writeFile(
      join(source, ".gitconfig"),
      [
        "[user]",
        "\tname = Taro",
        "\temail = taro@example.com",
        '[credential "https://github.com"]',
        "\thelper = !/usr/bin/gh auth git-credential",
        "[include]",
        "\tpath = ~/.gitconfig-work",
        "[core]",
        `\texcludesFile = ${source}/.gitignore_global`,
        "",
      ].join("\n"),
    );
    await writeFile(join(source, ".config", "git", "ignore"), "*.log\n");

    const r = await syncShellHome(shellHome, [".gitconfig", ".config/git"], { sourceHome: source });
    assert.deepEqual(r.copied, [".gitconfig", ".config/git"]);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.removedGitKeys.sort(), ["credential.https://github.com.helper", "include.path"]);
    assert.deepEqual(r.rewrittenGitKeys, ["core.excludesfile"]);

    const copy = join(shellHome, ".gitconfig");
    assert.equal(gitGet(copy, "user.name"), "Taro");
    assert.equal(gitGet(copy, "credential.https://github.com.helper"), "", "資格情報の取り出し役が残っている");
    assert.equal(gitGet(copy, "include.path"), "");
    assert.equal(gitGet(copy, "core.excludesFile"), `${shellHome}/.gitignore_global`);
    assert.equal(await readFile(join(shellHome, ".config", "git", "ignore"), "utf8"), "*.log\n");
    // 人のホームの元は書き換えない
    assert.match(await readFile(join(source, ".gitconfig"), "utf8"), /gh auth git-credential/);
  });
});

test("一覧から外したものは消え、Shell の中で作られたものには触らない。無いものは無いと言う", async () => {
  await withHomes(async ({ source, shellHome }) => {
    await writeFile(join(source, ".gitconfig"), "[user]\n\tname = Taro\n");
    await writeFile(join(source, ".config", "git", "ignore"), "*.log\n");
    await syncShellHome(shellHome, [".gitconfig", ".config/git"], { sourceHome: source });
    await mkdir(join(shellHome, ".npm"), { recursive: true });
    await writeFile(join(shellHome, ".npm", "cache"), "x");

    const r = await syncShellHome(shellHome, [".gitconfig", ".tool-versions"], { sourceHome: source });
    assert.deepEqual(r.missing, [".tool-versions"]);
    await assert.rejects(() => stat(join(shellHome, ".config", "git")), "外したのに残っている");
    assert.equal(await readFile(join(shellHome, ".npm", "cache"), "utf8"), "x", "Shell の中で作られたものが消えた");
  });
});

test("資格情報の置き場と、ホームの外を指すものは写せない", () => {
  for (const bad of [".ssh", ".ssh/id_ed25519", ".config/gh", "~/.config/banto", ".config", ".npmrc", "../etc", "/etc/passwd", ""]) {
    assert.ok(shellHomeEntryProblem(bad), `${bad} を写せてしまう`);
  }
  for (const ok of [".gitconfig", "~/.gitconfig", ".config/git", ".tool-versions"]) {
    assert.equal(shellHomeEntryProblem(ok), undefined, ok);
  }
});
