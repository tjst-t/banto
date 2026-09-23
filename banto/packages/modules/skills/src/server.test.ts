// 同梱の Skill Module——`SKILL.md` を印つきの資源として、兄弟ファイルを同じ URI の下に配る。
// 実際の MCP のやり取りを InMemoryTransport で通し、core の読み手（`discoverSkills`）と
// 同じ約束（一覧の `name`・`description` が frontmatter の2項目）を見る。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSkillsServer } from "./server.js";
import { parseSkillMd } from "./skill-md.js";

async function withSkills(
  files: Record<string, string>,
  fn: (client: Client, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "banto-skills-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const server = createSkillsServer({ skillsDir: root });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "host", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    await fn(client, root);
    await client.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const PDF_SKILL = `---
name: pdf
description: >
  PDF からテキストと表を抜き出す。
  PDF を扱うときに使う。
license: Apache-2.0
---
# PDF

詳しくは [forms](references/forms.md) を読む。
`;

test("SKILL.md を印つきで配り、名前と説明は frontmatter のまま一覧に載せる", async () => {
  await withSkills(
    {
      "pdf/SKILL.md": PDF_SKILL,
      "pdf/references/forms.md": "# フォームの埋め方",
      "pdf/scripts/fill.py": "print('x')",
      "pdf/.DS_Store": "隠しファイル",
    },
    async (client) => {
      const { resources } = await client.listResources();
      const skill = resources.find((r) => r.uri === "skill://pdf/SKILL.md");
      assert.ok(skill, JSON.stringify(resources.map((r) => r.uri)));
      assert.equal(skill.name, "pdf");
      assert.equal(skill.description, "PDF からテキストと表を抜き出す。 PDF を扱うときに使う。\n");
      assert.deepEqual(skill._meta, { "dev.banto/skill": true });

      // 兄弟は印を付けずに、同じ Skill の URI の下に（本文の相対パスがそのまま引ける）
      const siblings = resources.filter((r) => r.uri.startsWith("skill://pdf/") && r.uri !== "skill://pdf/SKILL.md");
      assert.deepEqual(
        siblings.map((r) => [r.uri, r._meta]),
        [
          ["skill://pdf/references/forms.md", undefined],
          ["skill://pdf/scripts/fill.py", undefined],
        ],
        "隠しファイルが配られている、または兄弟に印が付いている",
      );
    },
  );
});

test("本体も兄弟も読める。一覧に無いものは読めない（置き場の外へ出ない）", async () => {
  await withSkills(
    { "pdf/SKILL.md": PDF_SKILL, "pdf/references/forms.md": "# フォームの埋め方", "secret.txt": "外" },
    async (client, root) => {
      await symlink(join(root, "secret.txt"), join(root, "pdf", "references", "link.md"));
      const body = await client.readResource({ uri: "skill://pdf/SKILL.md" });
      assert.match((body.contents[0] as { text: string }).text, /詳しくは \[forms\]/);
      const forms = await client.readResource({ uri: "skill://pdf/references/forms.md" });
      assert.equal((forms.contents[0] as { text: string }).text, "# フォームの埋め方");
      assert.equal((forms.contents[0] as { mimeType: string }).mimeType, "text/markdown");

      for (const uri of [
        "skill://pdf/../secret.txt",
        "skill://pdf/%2E%2E/secret.txt",
        "skill://pdf/references/link.md",
        "skill://nope/SKILL.md",
      ]) {
        await assert.rejects(() => client.readResource({ uri }), Error, `${uri} が読めてしまった`);
      }
    },
  );
});

test("読めない Skill は配らない——形が違う・フォルダ名と名前が違う・SKILL.md が無い", async () => {
  await withSkills(
    {
      "ok/SKILL.md": "---\nname: ok\ndescription: 動く\n---\n本文",
      "wrong-name/SKILL.md": "---\nname: other\ndescription: 名前が違う\n---\n",
      "no-front/SKILL.md": "# frontmatter が無い",
      "bad-yaml/SKILL.md": "---\nname: [壊れた\n---\n",
      "empty/README.md": "SKILL.md が無い",
    },
    async (client) => {
      const { resources } = await client.listResources();
      assert.deepEqual(
        resources.filter((r) => r._meta?.["dev.banto/skill"]).map((r) => r.name),
        ["ok"],
      );
    },
  );
});

test("frontmatter を読む——必須の2項目が無ければ理由を言う", () => {
  const ok = parseSkillMd("---\r\nname: x\r\ndescription: \"引用つき: 値\"\r\n---\r\n本文");
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.skill.description, "引用つき: 値");
  assert.equal(ok.ok && ok.skill.body, "本文");
  const missing = parseSkillMd("---\nname: x\n---\n");
  assert.equal(missing.ok, false);
  assert.match(!missing.ok ? missing.problem : "", /説明がありません/);
});

test("置き場がまだ無ければ、何も配らない（落ちない）", async () => {
  const server = createSkillsServer({ skillsDir: join(tmpdir(), "banto-skills-does-not-exist") });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  const { resources } = await client.listResources();
  assert.deepEqual(
    resources.map((r) => r.uri),
    ["skill://module"],
  );
  await client.close();
});
