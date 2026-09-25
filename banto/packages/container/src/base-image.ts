// **banto の土台イメージ**（決定・2026-09-25）。Project のコンテナはここから作る。
//
// 元の Ubuntu のイメージは最小限で git すら無い（E2E で `git: not found`）。Project ごとに好きな道具を入れる
// のが banto の形だが、**banto 自身の機能が頼る道具**（Shell の git、`sshIdentity` の ssh、取得の curl と証明書）は
// 最初から要る。**node（npm・npx つき）も入れる**——banto の Module が動く道具で、ホストの Shell でも使えていた
// （E2E で `npm: not found`）。**ホストで動いている node の配布一式をそのまま写す**——外から取らないので版が
// 必ずホストと一致し、取得の都合で落ちない。**一度だけ作って置いておく**（ゴールデンイメージ——規則12、既知の形）。btrfs の置き場なので、
// そこから作るのは写しの共有で一瞬。
//
// 道具の一覧が変われば名前（alias）が変わり、次に要るときに作り直す（古いものは残る——消すのは後で決める）。

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { RunIncus } from "./incus.js";
import { BANTO_POOL } from "./prereqs.js";

/** 元にするイメージ */
export const UPSTREAM_IMAGE = "images:ubuntu/24.04";

/** banto の機能が頼る道具だけ。それ以外は Project ごとに入れる */
export const BASE_PACKAGES = ["git", "curl", "ca-certificates", "openssh-client", "unzip", "xz-utils"] as const;

/** 道具の一覧・元のイメージ・node の版から決まる名前（どれかが変われば別の名前になる） */
export function baseImageAlias(nodeVersion = process.version): string {
  const h = createHash("sha256").update(`${UPSTREAM_IMAGE}\n${BASE_PACKAGES.join("\n")}\nnode ${nodeVersion}`).digest("hex").slice(0, 12);
  return `banto-base-${h}`;
}

/**
 * ホストの node の配布一式（node・npm・npx・corepack）を1つの tar にする。置き場は `<prefix>/bin/node` の
 * `<prefix>`（例：`/usr/local`）。npm が一緒に無い入れ方（ディストリビューションの node 等）なら断る——
 * 黙って node だけにしない（規則2）
 */
function packHostNode(): string {
  const prefix = dirname(dirname(process.execPath));
  const parts = ["bin/node", "bin/npm", "bin/npx", "lib/node_modules/npm"];
  for (const p of parts) {
    if (!existsSync(join(prefix, p))) throw new Error(`ホストの node の置き場に ${p} がありません（${prefix}）——npm つきで入れた node が要ります`);
  }
  const optional = ["bin/corepack", "lib/node_modules/corepack"].filter((p) => existsSync(join(prefix, p)));
  const out = join(mkdtempSync(join(tmpdir(), "banto-node-")), "node.tar");
  execFileSync("tar", ["-C", prefix, "-cf", out, ...parts, ...optional]);
  return out;
}

let building: Promise<string> | undefined;

/**
 * 土台イメージが無ければ作って、その名前を返す。同時に呼ばれても1回だけ作る。
 * 作るのは一時のコンテナ → 道具を入れる → 止める → イメージにする → 一時のコンテナを消す
 */
export function ensureBaseImage(run: RunIncus, timeoutMs = 600_000): Promise<string> {
  building ??= build(run, timeoutMs).finally(() => {
    building = undefined;
  });
  return building;
}

async function build(run: RunIncus, timeoutMs: number): Promise<string> {
  const alias = baseImageAlias();
  const project = (await must(run, ["project", "get-current"], "いまの区画を引く")).trim();
  const existing = await run(["query", `/1.0/images/aliases/${alias}?project=${encodeURIComponent(project)}`], { timeoutMs: 30_000 });
  if (existing.code === 0) return alias;

  const tmp = `${alias}-build-${process.pid}`;
  try {
    await must(run, ["launch", UPSTREAM_IMAGE, tmp, "--storage", BANTO_POOL], "土台イメージ用の一時のコンテナを作る", timeoutMs);
    // 起こした直後は名前解決がまだのことがある——apt が通るまで待つのではなく、失敗は失敗として返す（規則2）。
    // 待つのは init が上がるまでだけ
    const deadline = Date.now() + 60_000;
    while ((await run(["exec", tmp, "--", "systemctl", "is-system-running", "--wait"], { timeoutMs: 60_000 })).stdout.trim() === "starting") {
      if (Date.now() > deadline) break;
    }
    await must(
      run,
      ["exec", tmp, "--env", "DEBIAN_FRONTEND=noninteractive", "--", "sh", "-c", `apt-get update -q && apt-get install -y -q --no-install-recommends ${BASE_PACKAGES.join(" ")} && apt-get clean`],
      "土台イメージに道具を入れる（コンテナから外へ出られるか確かめてください——Docker の転送の許可など）",
      timeoutMs,
    );
    const tar = packHostNode();
    try {
      await must(run, ["file", "push", tar, `${tmp}/tmp/node.tar`], "node を中に送る", timeoutMs);
      await must(run, ["exec", tmp, "--", "sh", "-c", "tar -C /usr/local -xf /tmp/node.tar && rm /tmp/node.tar && node --version && npm --version"], "node を中に置く", timeoutMs);
    } finally {
      rmSync(dirname(tar), { recursive: true, force: true });
    }
    await must(run, ["stop", tmp], "一時のコンテナを止める", 120_000);
    await must(run, ["publish", tmp, "--alias", alias], "土台イメージにする", timeoutMs);
    return alias;
  } finally {
    await run(["delete", "--force", tmp], { timeoutMs: 120_000 });
  }
}

async function must(run: RunIncus, args: string[], what: string, timeoutMs = 120_000): Promise<string> {
  const r = await run(args, { timeoutMs });
  if (r.code !== 0) throw new Error(`${what}のに失敗しました：${(r.stderr || r.stdout).trim().slice(-800) || `終了コード ${r.code}`}`);
  return r.stdout;
}
