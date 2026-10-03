#!/usr/bin/env node
// **workspace を、依存の順に build する**（2026-10-03、リリースの build が落ちた）。
//
// `npm run build --workspaces` は workspace を**並べた順（名前順）**に作る。core は module-contract より先、
// service は shell より先に来るので、使う側が古い（または無い）dist を見て落ちる。いつもは前の build の dist が
// 残っていて気づかなかった——module-contract に新しい名前を足した回に、REL の build が core で落ちた。
//
// 順番は各 package.json の依存（dependencies・devDependencies の @banto/*）から決める。手で並べた一覧は持たない
// （workspace を足すたびに直し忘れる）。循環していたら止める。
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** workspaces の書き方は「a/b」と「a/*」だけ（fs.globSync は Node 22 から——host の版に依らないように） */
function expand(pattern) {
  if (!pattern.endsWith("/*")) return [pattern];
  const base = pattern.slice(0, -2);
  return readdirSync(join(root, base), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(base, e.name));
}

const pkgs = new Map();
for (const pattern of rootPkg.workspaces) {
  for (const dir of expand(pattern)) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    } catch {
      continue; // package.json の無いフォルダは workspace ではない
    }
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    pkgs.set(pkg.name, { name: pkg.name, deps, hasBuild: Boolean(pkg.scripts?.build) });
  }
}

const order = [];
const state = new Map(); // visiting | done
function visit(name, path) {
  if (state.get(name) === "done") return;
  if (state.get(name) === "visiting") throw new Error(`workspace の依存が循環しています: ${[...path, name].join(" → ")}`);
  state.set(name, "visiting");
  for (const dep of pkgs.get(name).deps) if (pkgs.has(dep)) visit(dep, [...path, name]);
  state.set(name, "done");
  order.push(name);
}
for (const name of [...pkgs.keys()].sort()) visit(name, []);

for (const name of order) {
  if (!pkgs.get(name).hasBuild) continue;
  const result = spawnSync("npm", ["run", "build", `--workspace=${name}`], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\nbuild-all: ${name} の build が失敗しました（ここで止めます）`);
    process.exit(result.status ?? 1);
  }
}
console.log(`\nbuild-all: ${order.filter((n) => pkgs.get(n).hasBuild).length} 個を依存の順に build しました`);
