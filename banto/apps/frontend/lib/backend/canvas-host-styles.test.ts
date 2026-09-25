// Canvas に渡す banto の色と段（v4-frontend.md §6.27）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McpUiHostContextSchema } from "@modelcontextprotocol/ext-apps/app-bridge";
import { CANVAS_STYLE_SOURCES, readCanvasStyles } from "./canvas-host-styles.ts";

const GLOBALS = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
/** 層A の `:root { … }`（最初のもの）と `.dark { … }` */
function block(selector: string): string {
  const start = GLOBALS.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `globals.css に ${selector} が無い`);
  return GLOBALS.slice(start, GLOBALS.indexOf("\n}", start));
}

test("対応表の元は、どれも globals.css の層A に在る（名前を変えたら、ここで落ちる）", () => {
  const root = block(":root");
  for (const source of new Set(Object.values(CANVAS_STYLE_SOURCES))) {
    assert.match(root, new RegExp(`\\n\\s*${source}:`), `${source} が層A に無い`);
  }
});

test("明暗で変わる色は、.dark にも在る——片方だけだと、暗いときに明るい色が渡る", () => {
  const dark = block(".dark");
  const root = block(":root");
  for (const source of new Set(Object.values(CANVAS_STYLE_SOURCES))) {
    if (!/^--banto-(surface|text|line|accent|ok|warn|stop|on-color|sh-)/.test(source)) continue;
    if (/^--banto-text-(xs|sm|md|lg|xl|2xl|3xl)/.test(source)) continue; // 字の段は明暗で変わらない
    assert.ok(root.includes(`${source}:`));
    assert.match(dark, new RegExp(`\\n\\s*${source}:`), `${source} が .dark に無い`);
  }
});

test("読んだ値を標準の名前で並べ、読めなかった banto の名前は隠さずに返す", () => {
  const values: Record<string, string> = { "--banto-surface": " #fff ", "--banto-stop": "#6e56cf" };
  const { variables, missing } = readCanvasStyles((name) => values[name] ?? "");
  assert.equal(variables["--color-background-primary"], "#fff");
  assert.equal(variables["--color-text-danger"], "#6e56cf");
  assert.equal(variables["--color-border-danger"], "#6e56cf");
  assert.ok(!("--color-text-primary" in variables), "読めないものを空で渡している");
  assert.ok(missing.includes("--banto-text"));
  assert.ok(!missing.includes("--banto-surface"));
});

test("渡すものは SDK の検査を通る（標準の名前だけ——独自の名前は画面の初期化で断られる）", () => {
  const { variables } = readCanvasStyles((name) => `value-of(${name})`);
  const parsed = McpUiHostContextSchema.safeParse({ theme: "dark", styles: { variables } });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3)));
  // 確かめの確かめ：独自の名前を足すと断られる
  const bad = McpUiHostContextSchema.safeParse({ styles: { variables: { ...variables, "--banto-turn": "#ce4620" } } });
  assert.equal(bad.success, false);
});
