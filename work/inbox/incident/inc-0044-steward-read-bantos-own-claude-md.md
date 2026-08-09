---
id: inc-0044
type: incident
kind: incident
origin: po
class: prompt-hygiene
status: resolved
refs: [adr-0010, spec-ui, inc-0043]
---

## 内容

**番頭が毎セッション、banto 自身の開発規約（`CLAUDE.md`）を読んでいた。**

PO の問い：「bantoのAIがbanto自身のCLAUDE.mdを毎回読んでるの？ CLAUDE.md はあくまで banto の
開発のためのドキュメントであり、bantoのAIが毎回読むべきものではありません」。実測した。

```
システムプロンプト全体: 4,973 文字
  "Development Rules": ★入っている
  "npm run dev:web":   ★入っている
  "P1**: スコープ外パスに触らない": ★入っている

CLAUDE.md は 655 文字目から:
  …<project_context>⏎<project_instructions path=".../banto/CLAUDE.md">⏎ ▼ # banto（番頭）
```

**4,973 文字のうち 4,399 文字が banto の開発規約だった（88%）。**

## 原因

pi の `DefaultResourceLoader` は既定で cwd から `CLAUDE.md` / `AGENTS.md` を拾い、
**システムプロンプトの後ろへ継ぎ足す**。番頭ホストの cwd は：

```
deploy/banto.service:  WorkingDirectory=/home/ubuntu/ghq/github.com/tjst-t/banto
host-session.ts:       const cwd = options.cwd ?? process.cwd();
```

＝ **banto のインストール先**。誰も決めていない。ハーネスの既定が、そのまま製品の人格に
流れ込んでいた。

## 二重に間違っている

1. **番頭は banto の開発者ではない。** `CLAUDE.md` は banto を開発する側（Claude Code）への
   指示——「スコープ外パスに触らない」「`npm run dev:web`」「`docs/spec/` を読め」。
   製品として店を切り盛りする番頭の人格ではない
2. **仮に「案件の文脈を読む」のが正しいとしても、拾っているのはインストール先**であって
   相談している案件ではない。loamium の話をしていても banto の CLAUDE.md が載る

さらに、番頭の知識の入れ方は決定26（SKILL の progressive disclosure：一覧だけを載せ、
本体は `skill.read` で引く）で設計してある。**置き場に落ちている物を丸ごと継ぎ足す経路は、
その設計を素通りしていた。**

## 職人はこの限りではない

| | cwd | 拾うもの | 妥当か |
|---|---|---|---|
| 職人 | ワークツリー | **その案件のリポジトリの `CLAUDE.md`** | ✓ 正しい |
| 番頭 | インストール先 | banto 自身の開発規約 | ✗ |

職人はその案件の中で手を動かすので、そこの規約を読むのは正しい。`pi-rpc-driver` は変えない。

## 直したこと

`host-session.ts` の `DefaultResourceLoader` に **`noContextFiles: true`**。

```
4,973 文字 → 574 文字（消えた 4,399 文字は全部 banto の開発規約）
```

## 見張り

`tests/acceptance/host-no-context-files.spec.ts`。**banto の CLAUDE.md を名指ししない**
——名前が変わったり別の置き場へ移ったりすると黙って効かなくなる（inc-0040・inc-0043 と
同じ罠）。一時ディレクトリに目印入りの `CLAUDE.md` / `AGENTS.md` を置き、
**それがプロンプトへ入らないこと**を見る。あわせて**職人からは取り上げていないこと**も見張る。

## 学び

**ハーネスの既定が、製品の人格に漏れていた。** ADR-0010 は「pi は無改造で扱う」と決めており
それ自体は正しいが、**無改造で扱う＝既定のまま使う、ではない**。ハーネスが親切でやることの
うち、製品として要らないものは明示的に切る必要がある。

気づけなかった理由もはっきりしている。`banto-host-tools.spec.ts` に
**「pi appends discovered context files (this repo's own CLAUDE.md)」と書いてあった**
——起きていることは分かっていて、**それを望ましくないと誰も判断しなかった**。
コメントは事実の記録であって、判断ではない。
