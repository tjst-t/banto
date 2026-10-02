#!/usr/bin/env node
// git の credential helper（git は `<この helper> get` の形で呼び、標準入力に protocol・host を渡す）。
//
// **秘密を持たない**：トークンは引数にも環境にも無い。Module が clone の間だけ立てる socket（持ち主だけが入れる
// フォルダの中）に「この相手の資格情報を」と聞き、返ってきたものを git に渡すだけ（`credential-server.ts`）。
// `get` 以外（store・erase）は何もしない——git に覚えさせない。

import { connect } from "node:net";

const [socketPath, action] = process.argv.slice(2);
if (action !== "get" || !socketPath) process.exit(0);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c: string) => (input += c));
process.stdin.on("end", () => {
  const fields = Object.fromEntries(
    input
      .split("\n")
      .map((l) => l.split("="))
      .filter((kv) => kv.length >= 2)
      .map(([k, ...v]) => [k, v.join("=")]),
  ) as Record<string, string>;
  const socket = connect(socketPath, () => {
    socket.end(JSON.stringify({ protocol: fields.protocol ?? "", host: fields.host ?? "" }) + "\n");
  });
  let answer = "";
  socket.setEncoding("utf8");
  socket.on("data", (c: string) => (answer += c));
  socket.on("end", () => process.stdout.write(answer));
  // 届かなかった——資格情報を渡さずに終わる（git は認証で断られ、その理由を言う）。秘密は文言に入らない
  socket.on("error", (err) => {
    process.stderr.write(`banto の資格情報の窓口に届きませんでした（${err.message}）\n`);
  });
});
