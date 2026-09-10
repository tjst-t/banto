// 自己申告のほうが厳しかったときの「宣言の直し」が、**どこに書かれるか**
// （`declaration-repair-project-overlay`、2026-09-10）。
//
// 以前は Project の上書きを混ぜて解決した一覧を、**projectId 抜きで**保存していた：
//   - その Project の上書きが、全 Project の既定に漏れる
//   - 当の Project の上書きは直らないので、次に起動しても同じ食い違いが出る
// **写しの汚染**（規則3）。直すのは「この Module がこう申告した」という Module 固有の
// 事実であって、その Project の事情ではない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { RuntimeConfigStore } from "../config/runtime.js";
import {
  loadModuleDeclarations,
  repairDeclarationMeta,
  setModuleDeclarations,
} from "./declaration.js";

const PROJECT = "project-1";
const OTHER = "project-2";

async function withConfig(fn: (config: RuntimeConfigStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-repair-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const config = new RuntimeConfigStore(dir, log);
    await config.load();
    await fn(config);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** この Project だけ、filesystem に env を1つ足した状態を作る。 */
async function givenProjectOverride(config: RuntimeConfigStore): Promise<void> {
  const current = loadModuleDeclarations(config, PROJECT);
  await setModuleDeclarations(
    config,
    current.map((d) =>
      d.name === "filesystem"
        ? { ...d, launch: { ...d.launch, env: { ...d.launch.env, ONLY_HERE: "1" } } }
        : d,
    ),
    PROJECT,
  );
}

test("Module 固有の直しは instance 既定へ——Project の上書きを巻き込まない", async () => {
  await withConfig(async (config) => {
    await givenProjectOverride(config);

    await repairDeclarationMeta(config, {
      name: "vault",
      projectId: PROJECT,
      stricter: { scope: "project" },
    });

    // 直った（既定として、全 Project に効く）
    assert.equal(loadModuleDeclarations(config, "").find((d) => d.name === "vault")!.meta.scope, "project");
    assert.equal(loadModuleDeclarations(config, OTHER).find((d) => d.name === "vault")!.meta.scope, "project");

    // **その Project の事情は既定に漏れていない**
    const defaultFs = loadModuleDeclarations(config, "").find((d) => d.name === "filesystem")!;
    assert.equal(defaultFs.launch.env?.ONLY_HERE, undefined, "Project の上書きが既定に漏れた");
    const otherFs = loadModuleDeclarations(config, OTHER).find((d) => d.name === "filesystem")!;
    assert.equal(otherFs.launch.env?.ONLY_HERE, undefined, "別の Project にまで漏れた");

    // 当の Project の上書きはそのまま残っている（消してもいない）
    const mineFs = loadModuleDeclarations(config, PROJECT).find((d) => d.name === "filesystem")!;
    assert.equal(mineFs.launch.env?.ONLY_HERE, "1", "その Project の上書きを消してしまった");
  });
});

test("既定に無い Module（Project の上書きでだけ足したもの）は、その Project に直す", async () => {
  await withConfig(async (config) => {
    const current = loadModuleDeclarations(config, PROJECT);
    await setModuleDeclarations(
      config,
      [
        ...current,
        {
          name: "only-here",
          launch: { command: "node", args: ["x.js"] },
          meta: { satisfies: ["x"], dependsOn: [], isolation: "subprocess" },
        },
      ],
      PROJECT,
    );

    const result = await repairDeclarationMeta(config, {
      name: "only-here",
      projectId: PROJECT,
      stricter: { handlesSecrets: true },
    });

    assert.equal(result.writtenTo, "project");
    assert.equal(
      loadModuleDeclarations(config, PROJECT).find((d) => d.name === "only-here")!.meta.handlesSecrets,
      true,
    );
    // 既定には、そんな Module は生えていない
    assert.equal(loadModuleDeclarations(config, "").some((d) => d.name === "only-here"), false);
  });
});

test("直した内容は、Project 上書きのあるモジュールにもそのまま効く（上書きは別の項目だけ）", async () => {
  await withConfig(async (config) => {
    await givenProjectOverride(config);

    await repairDeclarationMeta(config, {
      name: "filesystem",
      projectId: PROJECT,
      stricter: { handlesSecrets: true },
    });

    const mine = loadModuleDeclarations(config, PROJECT).find((d) => d.name === "filesystem")!;
    assert.equal(mine.meta.handlesSecrets, true, "直しがこの Project に届いていない");
    assert.equal(mine.launch.env?.ONLY_HERE, "1", "この Project の上書きが消えた");
  });
});
