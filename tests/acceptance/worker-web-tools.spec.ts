/**
 * imp-0005: 職人に「外を読む口」（web.fetch / web.search）を渡す。
 *
 * PO裁定（2026-07-30）：**既定では渡さない**。`worker.delegate` に `network: true` を
 * 渡したときだけ拡張ごと載せる。検索は鍵の要らない経路（DuckDuckGo → Wikipedia）。
 *
 * ここでは外に出ない。取得・検索の HTTP は差し替えた fetch で置き換え、
 * 見たいのは「門番・パース・整形・渡し方」。本物のネットワークが要る部分は
 * 手元で1度確かめて imp-0005 に記録する（テストを外の都合に縛らない）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  PiRpcDriver,
  WEB_TOOL_NAMES,
  fetchPublicUrl,
  htmlToText,
  isPublicHttpUrl,
  keylessSearch,
  parseDuckDuckGoLite,
  parseWikipedia,
  renderSearchHits,
  webToolsExtensionPath,
} from "@banto/worker-pool";

/** 指定の応答を返すだけの fetch。呼ばれたURLを記録する。 */
function fakeFetch(
  responder: (url: string) => { status?: number; body: string; contentType?: string }
): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const { status = 200, body, contentType = "text/html" } = responder(url);
    return new Response(body, { status, headers: { "content-type": contentType } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("[imp-0005] URL の門番（外を読む口が内側への抜け道にならないこと）", () => {
  it("[imp-0005] 公開の http/https は通る", () => {
    for (const url of [
      "https://example.com/a",
      "http://example.com/",
      "https://8.8.8.8/x",
      "http://[2001:4860:4860::8888]/",
      "http://[::ffff:8.8.8.8]/",
    ]) {
      assert.equal(isPublicHttpUrl(url).ok, true, `通るべき: ${url}`);
    }
  });

  it("[imp-0005] 手元と内側のアドレスは弾く", () => {
    // 職人は Kobo・Worker Pool・番頭ホストと同じマシンに居る。ここを通すと、
    // 職人は web.fetch でモジュールの HTTP 面を直接叩けてしまう
    const blocked = [
      "http://localhost:4110/tools/worker.report",
      "http://127.0.0.1:4100/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://0.0.0.0/",
      "http://[::1]:4100/",
      "http://[fe80::1]/",
      "http://[fd00::1]/",
      // new URL() は [::ffff:7f00:1] に正規化する。10進のまま探すと素通りする
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:10.0.0.1]/",
      "http://[0:0:0:0:0:ffff:c0a8:1]/",
    ];
    for (const url of blocked) {
      const verdict = isPublicHttpUrl(url);
      assert.equal(verdict.ok, false, `弾くべき: ${url}`);
    }
  });

  it("[imp-0005] http/https 以外のスキームは弾く", () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "data:text/html,hi"]) {
      assert.equal(isPublicHttpUrl(url).ok, false, `弾くべき: ${url}`);
    }
  });

  it("[imp-0005] 弾いた URL は取りに行かない（理由も返す）", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: "secret" }));
    const outcome = await fetchPublicUrl("http://localhost:4110/tools/worker.report", impl);

    assert.equal(outcome.error, true);
    assert.deepEqual(calls, [], "弾いたのに取りに行っている");
    assert.match(outcome.text, /取得できません/);
  });
});

describe("[imp-0005] web.fetch の取得", () => {
  it("[imp-0005] HTML はタグを落として返す", async () => {
    const { impl } = fakeFetch(() => ({
      body:
        "<html><head><style>p{color:red}</style><script>alert(1)</script></head>" +
        "<body><h1>見出し</h1><p>本文&amp;続き</p></body></html>",
    }));
    const outcome = await fetchPublicUrl("https://example.com/doc", impl);

    assert.equal(outcome.error, false);
    assert.match(outcome.text, /見出し/);
    assert.match(outcome.text, /本文&続き/, "実体参照は戻す");
    assert.doesNotMatch(outcome.text, /alert\(1\)/, "script の中身を渡さない");
    assert.doesNotMatch(outcome.text, /color:red/, "style の中身を渡さない");
    assert.doesNotMatch(outcome.text, /<h1>/, "タグは落とす");
  });

  it("[imp-0005] HTML でなければそのまま返す", async () => {
    const { impl } = fakeFetch(() => ({
      body: '{"a": "<b>"}',
      contentType: "application/json",
    }));
    const outcome = await fetchPublicUrl("https://example.com/x.json", impl);
    assert.match(outcome.text, /\{"a": "<b>"\}/);
  });

  it("[imp-0005] 上限を超えたら切って、切ったことを書く（黙って途中までを全部に見せない）", async () => {
    const { impl } = fakeFetch(() => ({ body: "x".repeat(5000), contentType: "text/plain" }));
    const outcome = await fetchPublicUrl("https://example.com/big", impl, 1000);

    assert.equal(outcome.truncated, true);
    assert.equal(outcome.bytes, 1000);
    assert.match(outcome.text, /打ち切りました/);
  });

  it("[imp-0005] HTTP エラーは成功に見せない", async () => {
    const { impl } = fakeFetch(() => ({ status: 404, body: "nope" }));
    const outcome = await fetchPublicUrl("https://example.com/missing", impl);

    assert.equal(outcome.error, true);
    assert.match(outcome.text, /HTTP 404/);
  });

  it("[imp-0005] 例外も握りつぶさず職人に見える形で返す", async () => {
    const impl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const outcome = await fetchPublicUrl("https://example.invalid/", impl);

    assert.equal(outcome.error, true);
    assert.match(outcome.text, /ENOTFOUND/);
  });
});

describe("[imp-0005] web.search（鍵の要らない経路）", () => {
  // 実物の DuckDuckGo lite から取った形。属性の順・転送URL・スニペットの持ち方を再現する
  const DDG_HTML = `
    <table>
      <tr><td>1.&nbsp;</td><td>
        <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=abc" class="result-link">最初の記事</a>
      </td></tr>
      <tr><td class="result-snippet">最初の<b>抜粋</b>です</td></tr>
      <tr><td>2.&nbsp;</td><td>
        <a class="result-link" href="https://example.org/two">次の記事</a>
      </td></tr>
      <tr><td class="result-snippet">次の抜粋</td></tr>
    </table>`;

  it("[imp-0005] DuckDuckGo lite の HTML から見出し・URL・抜粋を取る", () => {
    const hits = parseDuckDuckGoLite(DDG_HTML);

    assert.equal(hits.length, 2);
    assert.deepEqual(hits[0], {
      title: "最初の記事",
      url: "https://example.com/one",
      snippet: "最初の抜粋です",
    });
    assert.equal(hits[1]?.url, "https://example.org/two", "属性の順に依存しない");
  });

  it("[imp-0005] Wikipedia の JSON から取る", () => {
    const hits = parseWikipedia({
      query: {
        search: [
          { title: "型システム", snippet: '<span class="searchmatch">型</span>の理論' },
          { title: "no title here", snippet: "" },
        ],
      },
    });

    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.title, "型システム");
    assert.equal(hits[0]?.snippet, "型の理論", "検索一致のタグは落とす");
    assert.match(hits[0]?.url ?? "", /^https:\/\/ja\.wikipedia\.org\/wiki\//);
  });

  it("[imp-0005] 壊れた JSON は空を返す（例外にしない）", () => {
    for (const broken of [null, {}, { query: {} }, { query: { search: "nope" } }]) {
      assert.deepEqual(parseWikipedia(broken), []);
    }
  });

  it("[imp-0005] DuckDuckGo が取れれば Wikipedia は叩かない", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: DDG_HTML }));
    const { hits, via } = await keylessSearch("型システム", impl);

    assert.equal(via, "duckduckgo");
    assert.equal(hits.length, 2);
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? "", /lite\.duckduckgo\.com/);
  });

  it("[imp-0005] DuckDuckGo が壊れたら Wikipedia に落ちる（黙って0件にしない）", async () => {
    // 相手の HTML が変わってパースが空になった状況。これが二段にしてある理由
    const { impl, calls } = fakeFetch((url) =>
      url.includes("duckduckgo")
        ? { body: "<html>すっかり変わった画面</html>" }
        : {
            body: JSON.stringify({ query: { search: [{ title: "型システム", snippet: "" }] } }),
            contentType: "application/json",
          }
    );
    const { hits, via } = await keylessSearch("型システム", impl);

    assert.equal(via, "wikipedia");
    assert.equal(hits.length, 1);
    assert.equal(calls.length, 2);
  });

  it("[imp-0005] 両方だめなら「見つからなかった」と言う", async () => {
    const { impl } = fakeFetch(() => ({ status: 503, body: "" }));
    const { hits, via } = await keylessSearch("型システム", impl);

    assert.equal(via, "none");
    assert.deepEqual(hits, []);
    assert.match(renderSearchHits("型システム", hits), /見つかりませんでした/);
  });

  it("[imp-0005] 結果は番号つきの読める形に整える", () => {
    const text = renderSearchHits("q", [
      { title: "A", url: "https://a.example/", snippet: "あ" },
      { title: "B", url: "https://b.example/", snippet: "" },
    ]);
    assert.match(text, /1\. A — https:\/\/a\.example\/\n {3}あ/);
    assert.match(text, /2\. B — https:\/\/b\.example\//);
  });
});

describe("[imp-0005] htmlToText", () => {
  it("[imp-0005] 空白を詰めても段落の切れ目は残す", () => {
    const text = htmlToText("<p>一</p>\n\n\n\n<p>二</p>");
    assert.equal(text.includes("一"), true);
    assert.equal(text.includes("二"), true);
    assert.doesNotMatch(text, /\n{3,}/, "空行が3つ以上続かない");
  });
});

describe("[imp-0005] Tool 名", () => {
  it("[imp-0005] wire名はドットを通さないプロバイダ向けに変換済み（決定22）", () => {
    assert.deepEqual([...WEB_TOOL_NAMES], ["web__fetch", "web__search"]);
  });
});

// ── 実プロセス ──────────────────────────────────────────────────────────────

/**
 * 拡張が**本物の pi に載ること**を確かめる。
 *
 * 単体のテストは関数を直接呼ぶだけなので、拡張として読み込めるか（import が解決するか・
 * pi の registerTool の形が合っているか）は一切見ていない。ここが偽ドライバでは
 * 見えない部分で、実際に3回踏んだ類の穴（fake driver hides real constraints）。
 * LLM もネットワークも使わない。
 */
const PROBE_EXTENSION = `
import * as fs from "node:fs";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi API は実行時に渡される (I4)
export default function (pi: any): void {
  pi.on("session_start", () => {
    const dest = process.env["PROBE_FILE"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上 (I4)
    if (dest) fs.writeFileSync(dest, JSON.stringify(pi.getAllTools().map((t: any) => t.name)));
  });
}
`;

let tmpDir: string;
let probePath: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-web-tools-"));
  probePath = path.join(tmpDir, "probe.ts");
  fs.writeFileSync(probePath, PROBE_EXTENSION, "utf8");
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("[imp-0005] 実プロセスで拡張が載ること", () => {
  it("[imp-0005] 本物の pi に web.fetch / web.search が登録される", async () => {
    const sessionDir = path.join(tmpDir, "sessions");
    const worktree = path.join(tmpDir, "wt");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    const probeFile = path.join(tmpDir, "tools.json");

    const driver = new PiRpcDriver({ sessionBaseDir: sessionDir, extensionPath: probePath });

    const prev = { probe: process.env["PROBE_FILE"], offline: process.env["PI_OFFLINE"] };
    process.env["PROBE_FILE"] = probeFile;
    process.env["PI_OFFLINE"] = "1";
    try {
      const handle = await driver.spawn({
        taskId: "web-tools-real",
        worktreePath: worktree,
        sessionPath: path.join(sessionDir, "web-tools-real.jsonl"),
        systemPrompt: "",
        tools: [],
        driverOptions: { extensionPaths: [webToolsExtensionPath()] },
      });
      try {
        const deadline = Date.now() + 15_000;
        while (!fs.existsSync(probeFile) && Date.now() < deadline) {
          await new Promise<void>((r) => setTimeout(r, 50));
        }
        assert.ok(fs.existsSync(probeFile), "pi が起動して拡張が走らなかった");
      } finally {
        await driver.kill(handle.sessionId);
      }
    } finally {
      if (prev.probe === undefined) delete process.env["PROBE_FILE"];
      else process.env["PROBE_FILE"] = prev.probe;
      if (prev.offline === undefined) delete process.env["PI_OFFLINE"];
      else process.env["PI_OFFLINE"] = prev.offline;
    }

    const tools = JSON.parse(fs.readFileSync(probeFile, "utf8")) as string[];
    for (const name of WEB_TOOL_NAMES) {
      assert.ok(tools.includes(name), `${name} が登録されていない: ${tools.join(",")}`);
    }
  });
});
