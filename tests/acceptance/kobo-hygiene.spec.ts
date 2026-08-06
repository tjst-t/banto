/**
 * task-0061: Kobo の衛生（ADR-0013 決定63・ADR-0010 決定40・38b）。
 *
 * 単独では小さいが、放置すると配線後に効いてくる3つ：
 *
 *   1. **待ち受け**（a2）：Kobo の口は認証を持たないまま全インターフェースに出ていた。
 *      番頭側を 127.0.0.1 に閉じた隣で、帳簿を書き換えられる口が開いている状態を作らない
 *   2. **帳簿の保護**（a3・a5）：番頭が Kobo のイベントログへ書けないことを、
 *      「場所として登録していないから」という配置任せではなく機構で担保する
 *   3. **bin の衝突**（a4）：`banto` が番頭ホストと Kobo のクライアントの両方にあった
 *
 * **砦は空振りしていないか確かめる**（task-0059 で効いた作法）。拒まれることだけでなく、
 * 守りを外すと**本当に書けてしまう**ことも見る——さもないと、別の理由で失敗しているのを
 * 「守れている」と読み違える。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import {
  PlaceRegistry,
  createFileWriteTools,
  createStaticPlaceProvider,
} from "../../packages/banto-host/src/index.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      s.close(() => resolve(port));
    });
  });
}

/** 外から見えるアドレス（ループバック以外）。無ければ undefined。 */
function externalAddress(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

/** そのアドレスへ実際に繋げるか（TCP で確かめる。HTTP まで行かなくてよい）。 */
async function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2000 });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

// ── a2: 待ち受けは既定で 127.0.0.1 ────────────────────────────────────────────

describe("[task-0061/a2] Kobo は既定で 127.0.0.1 だけを待ち受ける（決定40）", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let port: number;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-bind-"));
    port = await freePort();
    daemon = Daemon.create({
      port,
      dataDir: path.join(tmpDir, "data"),
      watchIntervalMs: 99999,
      tickIntervalMs: 99999,
      disableAutoSpawn: true,
    });
    await daemon.start();
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("127.0.0.1 からは届く", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    assert.equal(res.status, 200);
  });

  it("外から見えるアドレスには出ていない", async (t) => {
    const external = externalAddress();
    if (!external) {
      t.skip("ループバック以外のアドレスが無い環境なので確かめられない");
      return;
    }
    assert.equal(
      await canConnect(external, port),
      false,
      `${external}:${port} に繋がってはいけない（Kobo は認証を持たない）`
    );
  });

  it("砦が空振りしていない：0.0.0.0 で立てれば外から繋がる", async (t) => {
    const external = externalAddress();
    if (!external) {
      t.skip("ループバック以外のアドレスが無い環境なので確かめられない");
      return;
    }
    // **上の検査が「たまたま繋がらない」で通っていないこと**を確かめる。
    // 明示的に広げたときは本当に届く＝上の閉じ方が効いている証拠になる
    const openDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-bind-open-"));
    const openPort = await freePort();
    const open = Daemon.create({
      port: openPort,
      dataDir: path.join(openDir, "data"),
      watchIntervalMs: 99999,
      tickIntervalMs: 99999,
      disableAutoSpawn: true,
      bindHost: "0.0.0.0",
    });
    await open.start();
    try {
      assert.equal(
        await canConnect(external, openPort),
        true,
        "明示的に広げたら外から繋がること（繋がらないなら上の検査は空振り）"
      );
    } finally {
      await open.stop();
      fs.rmSync(openDir, { recursive: true, force: true });
    }
  });
});

// ── a3 / a5: Kobo の帳簿は番頭に書けない ──────────────────────────────────────

describe("[task-0061/a3,a5] 番頭は Kobo の帳簿へ書けない（決定63）", () => {
  let dir: string;
  let place: string;
  let koboData: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-ledger-"));
    // **Kobo のデータ置き場が「場所」の中にある構成**。配置任せだと守れないのはこの形
    place = path.join(dir, "srv");
    koboData = path.join(place, "kobo-data");
    fs.mkdirSync(path.join(koboData, "events"), { recursive: true });
    fs.writeFileSync(path.join(koboData, "events", "2026-08.jsonl"), '{"type":"task_created"}\n');
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 書き込みを全部許した場所で `file.write` を組み立てる（守りを外すかどうかを選べる）。 */
  function writeTool(guarded: boolean) {
    const places = new PlaceRegistry([
      createStaticPlaceProvider([
        { id: "srv", label: "サーバ", path: place, writable: ["**"] },
      ]),
    ]);
    const tools = createFileWriteTools(places, guarded ? { protectedPaths: [koboData] } : {});
    return tools.find((t) => t.name === "file.write")!;
  }

  it("`**` を許した場所の中でも、Kobo の帳簿には書けない", async () => {
    await assert.rejects(
      () =>
        writeTool(true).execute({
          path: "kobo-data/events/2026-08.jsonl",
          content: '{"type":"task_merged"}\n',
        }),
      /書き込めません/,
      "帳簿の書き換えは、どの設定でも通らないこと"
    );
    // 中身が変わっていないこと（拒まれたのに書けていた、が起きない）
    assert.match(
      fs.readFileSync(path.join(koboData, "events", "2026-08.jsonl"), "utf-8"),
      /task_created/
    );
  });

  it("新しいファイルも作れない（帳簿の脇に置くのも駄目）", async () => {
    await assert.rejects(
      () => writeTool(true).execute({ path: "kobo-data/spawn-ledger.json", content: "{}" }),
      /書き込めません/
    );
    assert.equal(fs.existsSync(path.join(koboData, "spawn-ledger.json")), false);
  });

  it("砦が空振りしていない：守りを外すと本当に書けてしまう", async () => {
    // 上の2件が「別の理由で失敗している」のではないことを確かめる。
    // **これが通ってしまう配置を、いままで配置任せで避けていた**（決定63）
    await writeTool(false).execute({ path: "kobo-data/proof.txt", content: "書けた" });
    assert.equal(
      fs.readFileSync(path.join(koboData, "proof.txt"), "utf-8"),
      "書けた",
      "protectedPaths を外せば書ける＝上の拒否は砦が効いている証拠"
    );
    fs.rmSync(path.join(koboData, "proof.txt"));
  });
});

// ── a4: bin 名の衝突 ─────────────────────────────────────────────────────────

describe("[task-0061/a4] bin 名 banto の衝突が無い", () => {
  const repoRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    ".."
  );

  it("`banto` を名乗るのは番頭ホストだけ（Kobo のクライアントは kobo）", () => {
    const owners: Array<{ pkg: string; bins: string[] }> = [];
    for (const pkg of fs.readdirSync(path.join(repoRoot, "packages"))) {
      const manifestPath = path.join(repoRoot, "packages", pkg, "package.json");
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
        bin?: Record<string, string>;
      };
      if (manifest.bin) owners.push({ pkg, bins: Object.keys(manifest.bin) });
    }

    const claimingBanto = owners.filter((o) => o.bins.includes("banto"));
    assert.equal(
      claimingBanto.length,
      1,
      `bin "banto" を名乗るのは1つだけ。いま名乗っているのは: ${JSON.stringify(claimingBanto)}`
    );
    assert.equal(claimingBanto[0]!.pkg, "banto-host", "`banto` は番頭のもの（PO が打つのは番頭）");

    const cli = owners.find((o) => o.pkg === "banto-cli");
    assert.deepEqual(cli?.bins, ["kobo"], "Kobo のクライアントは kobo と名乗る");
  });
});
