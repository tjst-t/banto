// コンテナの前提を確かめて、足りないものと直し方を出す（入れる人・運用する人のための口）。
// usage: node packages/container/dist/doctor.js   → 足りなければ終了コード 1
import { checkContainerPrereqs, hostPrereqDeps } from "./prereqs.js";

const result = await checkContainerPrereqs(hostPrereqDeps());
if (result.ok) {
  console.log(`コンテナの前提はそろっています（Incus ${result.serverVersion}）。`);
} else {
  for (const p of result.problems) console.log(`✖ ${p.message}\n  直し方：${p.fix}`);
  process.exitCode = 1;
}
