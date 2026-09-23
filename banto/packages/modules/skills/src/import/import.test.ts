// 取り込み（アーキ仕様 §5.7、決定・2026-09-23）。
//
// 見ること：
// - **AI の `import_skill` は仮置きまで**。置き場に入るのは、人（`{admin: true}` の刻印）が押したときだけ
// - ref を省いたら、そのときの commit に解決して固定する（`HEAD` のまま持たない）
// - 承認の前に出すもの——出所・SKILL.md の中身・`scripts/` の有無・届かない記述
// - 置き場の外へ出ない（ZIP の `../`、仮置きの id、消す名前）

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSkillsServer } from "../server.js";
import { skillsAppHtml } from "../app.js";
import { parseGithubLocation } from "./source.js";
import type { FetchLike } from "./github.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const PDF_MD = [
  "---",
  "name: pdf",
  "description: PDF からテキストと表を抜き出す",
  "---",
  "# PDF",
  "",
  "表を抜くには `python scripts/extract.py input.pdf` を実行する。",
  "",
].join("\n");

/** GitHub の偽物。API と raw を URL で引き分ける。 */
function fakeGithub(files: Record<string, string>, opts: { rateLimited?: boolean } = {}) {
  const seen: string[] = [];
  const api = "https://api.test";
  const raw = "https://raw.test";
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer as ArrayBuffer,
  });
  const fetch: FetchLike = async (url) => {
    seen.push(url);
    if (opts.rateLimited) return response(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790140339" });
    if (/\/repos\/acme\/skills\/commits\/(HEAD|main|v1)$/.test(url.replace(api, ""))) {
      return response(200, { sha: SHA, commit: { tree: { sha: "root" } } });
    }
    if (url === `${api}/repos/acme/skills/git/trees/root`) return response(200, { tree: [{ path: "skills", type: "tree", sha: "t-skills" }] });
    if (url === `${api}/repos/acme/skills/git/trees/t-skills`) return response(200, { tree: [{ path: "pdf", type: "tree", sha: "t-pdf" }] });
    if (url === `${api}/repos/acme/skills/git/trees/t-pdf?recursive=1`) {
      return response(200, {
        tree: Object.entries(files).map(([path, body]) => ({ path, type: "blob", sha: path, size: body.length })),
      });
    }
    const prefix = `${raw}/acme/skills/${SHA}/skills/pdf/`;
    if (url.startsWith(prefix)) {
      const path = decodeURIComponent(url.slice(prefix.length));
      if (path in files) return response(200, files[path]);
    }
    return response(404, {});
  };
  return { fetch, seen, endpoints: { api, raw } };
}

async function withServer(
  github: ReturnType<typeof fakeGithub>,
  fn: (ctx: { client: Client; dataDir: string }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "banto-skills-import-"));
  try {
    const server = createSkillsServer({ dataDir, fetch: github.fetch, github: github.endpoints });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "host", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    await fn({ client, dataDir });
    await client.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

const HUMAN = { "dev.banto/caller": { admin: true } };
const AI = { "dev.banto/caller": { project: "p1" } };

async function call(client: Client, name: string, args: Record<string, unknown>, meta: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args, _meta: meta })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent?: Record<string, unknown>;
  };
  return res;
}

/** AI の `import_skill` の結果から仮置きの id を読み、人の口で中身を引く（会話の中の画面と同じ手順）。 */
async function previewOf(client: Client, res: { content: Array<{ text: string }> }) {
  const id = res.content[0]!.text.match(/取り込みの id：([0-9a-f-]{36})/)?.[1];
  assert.ok(id, `結果に仮置きの id が無い: ${res.content[0]!.text}`);
  const got = await call(client, "get_skill_import", { stagingId: id }, HUMAN);
  const state = got.structuredContent as { state: string; preview: Record<string, unknown> };
  assert.equal(state.state, "pending");
  return state.preview;
}

async function skillNames(client: Client): Promise<string[]> {
  const { resources } = await client.listResources();
  return resources.filter((r) => r._meta?.["dev.banto/skill"]).map((r) => r.name);
}

test("AI の import_skill は仮置きまで——人が押したときだけ置き場に入り、配られる", async () => {
  const gh = fakeGithub({ "SKILL.md": PDF_MD, "scripts/extract.py": "print(1)", "reference.md": "# 資料" });
  await withServer(gh, async ({ client, dataDir }) => {
    const res = await call(client, "import_skill", { source: "https://github.com/acme/skills/tree/main/skills/pdf" }, AI);
    assert.equal(res.isError, undefined, res.content[0]?.text);
    // **AI の文脈には中身を載せない**（SKILL.md は数十 KB になる）——id だけ
    assert.equal(res.content[0]!.text.includes("剪定"), false);
    assert.ok(res.content[0]!.text.length < 600, "AI への返事が長すぎる（中身を載せている）");
    // AI は中身を引く口を使えない
    const byAiGet = await call(client, "get_skill_import", { stagingId: "00000000-0000-0000-0000-000000000000" }, AI);
    assert.equal(byAiGet.isError, true);
    const preview = (await previewOf(client, res)) as {
      stagingId: string;
      name: string;
      source: { kind: string; repo: string; path: string; ref: string | null; commit: string };
      skillMd: string;
      hasScripts: boolean;
      unreachable: Array<{ line: number; text: string }>;
      files: Array<{ path: string }>;
    };
    // 承認の前に出すもの
    assert.equal(preview.name, "pdf");
    assert.deepEqual(
      { repo: preview.source.repo, path: preview.source.path, ref: preview.source.ref, commit: preview.source.commit },
      { repo: "acme/skills", path: "skills/pdf", ref: "main", commit: SHA },
    );
    assert.equal(preview.skillMd, PDF_MD);
    assert.equal(preview.hasScripts, true);
    assert.deepEqual(
      preview.unreachable.map((u) => u.line),
      [7],
      "スクリプトの実行を前提にした行を見つけていない",
    );
    assert.deepEqual(
      preview.files.map((f) => f.path),
      ["SKILL.md", "reference.md", "scripts/extract.py"],
    );
    // AI への返事は「取り込んでいない」と言う
    assert.match(res.content[0]!.text, /取り込むかは人が決めます/);

    // **まだ配られていない**
    assert.deepEqual(await skillNames(client), []);

    // AI の刻印では押せない（可視性で見えないが、刻印でも確かめる）
    const byAi = await call(client, "confirm_skill_import", { stagingId: preview.stagingId }, AI);
    assert.equal(byAi.isError, true);
    assert.match(byAi.content[0]!.text, /人の操作からだけ/);
    assert.deepEqual(await skillNames(client), []);

    // 人が押す
    const ok = await call(client, "confirm_skill_import", { stagingId: preview.stagingId }, HUMAN);
    assert.equal(ok.isError, undefined, ok.content[0]?.text);
    assert.deepEqual(await skillNames(client), ["pdf"]);
    // 兄弟も配られる。中身は原文のまま
    const body = await client.readResource({ uri: "skill://pdf/SKILL.md" });
    assert.equal((body.contents[0] as { text: string }).text, PDF_MD);
    const ref = await client.readResource({ uri: "skill://pdf/reference.md" });
    assert.equal((ref.contents[0] as { text: string }).text, "# 資料");

    // 出所が残る——写しの中ではなく、別の場所に
    const listed = await call(client, "list_installed_skills", {}, HUMAN);
    const skills = (listed.structuredContent as { skills: Array<{ name: string; source: { commit: string } }> }).skills;
    assert.equal(skills[0]!.source.commit, SHA);
    const stored = JSON.parse(await readFile(join(dataDir, "sources", "pdf.json"), "utf8")) as { importedAt?: string };
    assert.ok(stored.importedAt, "いつ取り込んだかが残っていない");

    // 同じ仮置きは2度使えない。ただし**何が起きたかは引ける**（会話を読み直したときの画面）
    const again = await call(client, "confirm_skill_import", { stagingId: preview.stagingId }, HUMAN);
    assert.equal(again.isError, true);
    const after = await call(client, "get_skill_import", { stagingId: preview.stagingId }, HUMAN);
    assert.deepEqual(
      [(after.structuredContent as { state: string }).state, (after.structuredContent as { name: string }).name],
      ["confirmed", "pdf"],
    );
  });
});

test("ref を省いたら、そのときの commit に解決して固定する（HEAD のまま持たない）", async () => {
  const gh = fakeGithub({ "SKILL.md": PDF_MD });
  await withServer(gh, async ({ client }) => {
    const res = await call(client, "import_skill", { source: "acme/skills/skills/pdf" }, AI);
    const source = ((await previewOf(client, res)) as { source: { ref: string | null; commit: string } }).source;
    assert.equal(source.ref, null);
    assert.equal(source.commit, SHA);
    // 中身は解決した commit から取っている（途中でブランチが進んでも跨らない）
    assert.ok(gh.seen.some((u) => u.includes(`/${SHA}/skills/pdf/SKILL.md`)), gh.seen.join("\n"));
  });
});

test("取り込めないときは理由を返す——上限・無いフォルダ・SKILL.md の無いフォルダ", async () => {
  await withServer(fakeGithub({ "SKILL.md": PDF_MD }, { rateLimited: true }), async ({ client }) => {
    const res = await call(client, "import_skill", { source: "acme/skills/skills/pdf" }, AI);
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /上限（未認証で1時間に60回）/);
  });
  await withServer(fakeGithub({ "SKILL.md": PDF_MD }), async ({ client }) => {
    const res = await call(client, "import_skill", { source: "acme/skills/skills/nope" }, AI);
    assert.match(res.content[0]!.text, /フォルダ「skills\/nope」が acme\/skills にありません/);
  });
  await withServer(fakeGithub({ "README.md": "x" }), async ({ client }) => {
    const res = await call(client, "import_skill", { source: "acme/skills/skills/pdf" }, AI);
    assert.match(res.content[0]!.text, /SKILL\.md がありません/);
  });
});

test("ZIP から取り込める——入れ子のフォルダでも、いちばん浅い SKILL.md を根にする", async () => {
  const zip = zipSync({
    "download/pdf/SKILL.md": strToU8(PDF_MD),
    "download/pdf/references/forms.md": strToU8("# フォーム"),
    "__MACOSX/download/pdf/._SKILL.md": strToU8("junk"),
  });
  await withServer(fakeGithub({}), async ({ client }) => {
    const res = await call(
      client,
      "prepare_skill_import",
      { zipBase64: Buffer.from(zip).toString("base64"), fileName: "pdf.zip" },
      HUMAN,
    );
    assert.equal(res.isError, undefined, res.content[0]?.text);
    const preview = res.structuredContent as { stagingId: string; files: Array<{ path: string }>; source: { kind: string; fileName: string } };
    assert.deepEqual(
      preview.files.map((f) => f.path),
      ["SKILL.md", "references/forms.md"],
    );
    assert.deepEqual([preview.source.kind, preview.source.fileName], ["zip", "pdf.zip"]);
    await call(client, "confirm_skill_import", { stagingId: preview.stagingId }, HUMAN);
    const forms = await client.readResource({ uri: "skill://pdf/references/forms.md" });
    assert.equal((forms.contents[0] as { text: string }).text, "# フォーム");

    // AI は ZIP の口を使えない（人の操作だけ）
    const byAi = await call(client, "prepare_skill_import", { zipBase64: Buffer.from(zip).toString("base64") }, AI);
    assert.equal(byAi.isError, true);
  });
});

test("読めない ZIP は理由つきで断る——Skill が2つ、置き場の外を指すパス", async () => {
  const two = zipSync({ "a/SKILL.md": strToU8(PDF_MD), "b/SKILL.md": strToU8(PDF_MD) });
  const escape = zipSync({ "SKILL.md": strToU8(PDF_MD), "../evil.md": strToU8("x") });
  await withServer(fakeGithub({}), async ({ client }) => {
    const r1 = await call(client, "prepare_skill_import", { zipBase64: Buffer.from(two).toString("base64") }, HUMAN);
    assert.match(r1.content[0]!.text, /Skill が 2 つ/);
    const r2 = await call(client, "prepare_skill_import", { zipBase64: Buffer.from(escape).toString("base64") }, HUMAN);
    assert.match(r2.content[0]!.text, /取り込めないパス/);
    assert.deepEqual(await skillNames(client), []);
  });
});

test("同じ名前を取り込むと、確認に「入れ替わる」が出て、押すと中身が入れ替わる。消せる", async () => {
  const first = zipSync({ "SKILL.md": strToU8(PDF_MD) });
  const second = zipSync({ "SKILL.md": strToU8(PDF_MD.replace("# PDF", "# PDF 第2版")) });
  await withServer(fakeGithub({}), async ({ client }) => {
    const p1 = await call(client, "prepare_skill_import", { zipBase64: Buffer.from(first).toString("base64"), fileName: "v1.zip" }, HUMAN);
    await call(client, "confirm_skill_import", { stagingId: (p1.structuredContent as { stagingId: string }).stagingId }, HUMAN);
    const p2 = await call(client, "prepare_skill_import", { zipBase64: Buffer.from(second).toString("base64"), fileName: "v2.zip" }, HUMAN);
    const preview = p2.structuredContent as { stagingId: string; replaces: { source: { fileName: string } } | null };
    assert.equal(preview.replaces?.source.fileName, "v1.zip");
    await call(client, "confirm_skill_import", { stagingId: preview.stagingId }, HUMAN);
    const body = await client.readResource({ uri: "skill://pdf/SKILL.md" });
    assert.match((body.contents[0] as { text: string }).text, /第2版/);

    const removed = await call(client, "remove_skill", { name: "pdf" }, HUMAN);
    assert.equal(removed.isError, undefined, removed.content[0]?.text);
    assert.deepEqual(await skillNames(client), []);
    assert.equal((await call(client, "remove_skill", { name: "../skills" }, HUMAN)).isError, true);
  });
});

test("仮置きの id はこちらが振ったものだけ——任意のパスを捨てさせない・読ませない", async () => {
  await withServer(fakeGithub({}), async ({ client }) => {
    for (const tool of ["discard_skill_import", "get_skill_import"]) {
      const res = await call(client, tool, { stagingId: "../../skills" }, HUMAN);
      assert.equal(res.isError, true);
      assert.match(res.content[0]!.text, /id が読めません/);
    }
  });
});

test("取りやめたものは、取りやめたと引ける", async () => {
  const zip = zipSync({ "SKILL.md": strToU8(PDF_MD) });
  await withServer(fakeGithub({}), async ({ client }) => {
    const p = await call(client, "prepare_skill_import", { zipBase64: Buffer.from(zip).toString("base64") }, HUMAN);
    const id = (p.structuredContent as { stagingId: string }).stagingId;
    await call(client, "discard_skill_import", { stagingId: id }, HUMAN);
    const got = await call(client, "get_skill_import", { stagingId: id }, HUMAN);
    assert.equal((got.structuredContent as { state: string }).state, "discarded");
    assert.deepEqual(await skillNames(client), []);
  });
});

test("GitHub の場所の書き方", () => {
  assert.deepEqual(parseGithubLocation("https://github.com/anthropics/skills/tree/main/skills/pdf"), {
    owner: "anthropics",
    repo: "skills",
    path: "skills/pdf",
    ref: "main",
  });
  assert.deepEqual(parseGithubLocation("https://github.com/anthropics/skills/blob/v1/skills/pdf/SKILL.md"), {
    owner: "anthropics",
    repo: "skills",
    path: "skills/pdf",
    ref: "v1",
  });
  assert.deepEqual(parseGithubLocation("https://github.com/acme/one-skill"), { owner: "acme", repo: "one-skill", path: "" });
  assert.deepEqual(parseGithubLocation("acme/skills/skills/pdf@feature/x"), {
    owner: "acme",
    repo: "skills",
    path: "skills/pdf",
    ref: "feature/x",
  });
  assert.throws(() => parseGithubLocation("https://gitlab.com/a/b"), /GitHub だけ/);
  assert.throws(() => parseGithubLocation("acme/skills/../x"), /「\.\.」/);
});

test("画面の HTML は、テンプレートの中に JS のテンプレートを持たない（壊れた HTML を配らない）", () => {
  for (const mode of ["tool", "manage"] as const) {
    const html = skillsAppHtml(mode);
    assert.ok(html.includes(`const MODE = "${mode}"`));
    assert.ok(!html.includes("__MODE__"));
    const script = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
    assert.ok(!script.includes("`"), "画面の JS にバッククォートが入っている");
  }
});

test("押されていない仮置きがたまったら、それ以上は仮置きしない", async () => {
  const { MAX_PENDING_IMPORTS } = await import("./staging.js");
  const zip = Buffer.from(zipSync({ "SKILL.md": strToU8(PDF_MD) })).toString("base64");
  await withServer(fakeGithub({}), async ({ client }) => {
    for (let i = 0; i < MAX_PENDING_IMPORTS; i += 1) {
      const r = await call(client, "prepare_skill_import", { zipBase64: zip }, HUMAN);
      assert.equal(r.isError, undefined, r.content[0]?.text);
    }
    const over = await call(client, "prepare_skill_import", { zipBase64: zip }, HUMAN);
    assert.equal(over.isError, true);
    assert.match(over.content[0]!.text, /たまっています/);
  });
});

test("繋がらないときは、繋がらない理由を言う（fetch failed の1語にしない）", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "banto-skills-import-"));
  try {
    const failing: FetchLike = async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.test"), { code: "EAI_AGAIN" }),
      });
    };
    const server = createSkillsServer({ dataDir, fetch: failing, github: { api: "https://api.test", raw: "https://raw.test" } });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "host", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    const res = await call(client, "import_skill", { source: "acme/skills/skills/pdf" }, AI);
    assert.equal(res.isError, true);
    assert.equal(res.content[0]!.text, "api.test に繋がりません（EAI_AGAIN）");
    await client.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
