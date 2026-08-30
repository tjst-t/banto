// 規則3 のプロパティ試験。§2.1 の境界線「いつでも捨てて0から再計算でき、
// 再計算結果と必ず一致する」を実行可能にする。ベンチより先に書く
// （harness が膨らんでから書くと試験が飛ぶ——計画のメモ）。
//
// これは PoC の成果物のうち、唯一 本実装に持ち込む価値があるもの
// （テストの「形」——具体的な arm 実装は捨てる）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, truncate, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StoreB } from './arm-b.mjs';
import { StoreC } from './arm-c.mjs';
import { canonical, makeEvent } from './shared/fold.mjs';
import { xorshift32 } from './shared/rand.mjs';
import { truncateTornTail } from './shared/jsonl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

async function tmpDir() {
  return mkdtemp(path.join(tmpdir(), 'banto-poc-es-'));
}

async function assertRule3(store) {
  const incremental = canonical(store.state());
  const { state: fromScratch } = await store.rebuildFromScratch();
  assert.equal(canonical(fromScratch), incremental,
    '増分で保った state が、ログだけからの再計算と一致しない');
}

// ---- 決定性・純粋性・canonicalizability -----------------------------------

test('fold は決定的（同じ入力→同じ出力）', () => {
  const rng = xorshift32(1);
  const events = Array.from({ length: 50 }, (_, i) => makeEvent(rng, i));
  const { fold } = requireFold();
  const a = canonical(fold(events));
  const b = canonical(fold(events));
  assert.equal(a, b);
});

test('apply は入力を書き換えない（凍結した event でも壊れない）', () => {
  const { empty, apply } = requireFold();
  const rng = xorshift32(2);
  const e = Object.freeze(makeEvent(rng, 0));
  const s0 = Object.freeze(empty());
  assert.doesNotThrow(() => apply(s0, e));
});

test('state は JSON 往復で不変（canonicalizable）', () => {
  const { empty, apply } = requireFold();
  const rng = xorshift32(3);
  let s = empty();
  for (let i = 0; i < 20; i++) s = apply(s, makeEvent(rng, i));
  const roundTripped = JSON.parse(JSON.stringify(s));
  assert.equal(canonical(s), canonical(roundTripped));
});

function requireFold() {
  // 同一モジュールを複数箇所から使う都合上、動的 import はせず re-export する。
  return _foldModule;
}
import * as _foldModule from './shared/fold.mjs';

// ---- 単一プロセス内：操作列のたびに規則3を確認 ----------------------------

for (const ArmCtor of [StoreB, StoreC]) {
  test(`${ArmCtor.name}: append のたびに規則3が成り立つ（順序は追記順、at では決まらない）`, async () => {
    const dir = await tmpDir();
    try {
      const store = await ArmCtor.open(dir);
      const rng = xorshift32(42);
      for (let i = 0; i < 30; i++) {
        // at をわざと逆行させる（クロックスキュー・過去についてのイベントを模す）
        const at = new Date(2000000000000 - i * 1000).toISOString();
        await store.append(makeEvent(rng, i, { at }));
        await assertRule3(store);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${ArmCtor.name}: 並行 append は intact かつ順序が保たれる`, async () => {
    const dir = await tmpDir();
    try {
      const store = await ArmCtor.open(dir);
      const rng = xorshift32(7);
      // 200件・Promise.allSettled で同時に投げる。10件では実際にはレースが顕在化せず
      // 「たまたま通った」だけだった（実測 2026-08-30）——200件で初めて、直列化していない
      // 実装だと fd キャッシュ（shared/jsonl.mjs）がレースして fd がリークすることが
      // 分かった。**この発見が「append はプロセス内で直列化する」という決定に繋がった**
      // （shared/queue.mjs、arm-b.mjs・arm-c.mjs の append 実装）。
      const N = 200;
      const events = Array.from({ length: N }, (_, i) => makeEvent(rng, i));
      const results = await Promise.allSettled(events.map((e) => store.append(e)));
      const rejected = results.filter((r) => r.status === 'rejected');
      if (rejected.length > 0) {
        // 静かに失敗を握りつぶさない。何件失敗したかを記録した上で、
        // 少なくともログの中身自体は壊れていないことを確認する。
        console.log(`  [note] 並行 append で ${rejected.length}/${N} 件が reject された:`,
          rejected[0].reason?.message);
      }
      assert.equal(store.cursor().seq, N, `cursor.seq が ${N} に届いていない——取りこぼしがある`);
      // 追記された行がすべて JSON として読めるか（intact か）を確認する
      const raw = await readFile(path.join(dir, 'log.jsonl'), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      assert.equal(lines.length, N, `ディスク上の行数が ${N} と一致しない`);
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line), `壊れた行: ${line.slice(0, 80)}`);
      }
      await assertRule3(store);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('StoreC: checkpoint → dropDerived しても規則3は保たれる', async () => {
  const dir = await tmpDir();
  try {
    const store = await StoreC.open(dir);
    const rng = xorshift32(11);
    for (let i = 0; i < 15; i++) await store.append(makeEvent(rng, i));
    await store.checkpoint();
    await assertRule3(store);
    await store.dropDerived();
    await assertRule3(store); // snapshot を消しても state 自体は変わらない
    // dropDerived 後に reopen しても、ログだけから正しく再構築できる
    const reopened = await StoreC.open(dir);
    assert.equal(canonical(reopened.state()), canonical(store.state()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('StoreC: 毒入り snapshot（版違い・cursor 末尾越え・中身改竄）はすべて弾かれ、rebuild に落ちる', async () => {
  const dir = await tmpDir();
  try {
    const store = await StoreC.open(dir);
    const rng = xorshift32(13);
    for (let i = 0; i < 10; i++) await store.append(makeEvent(rng, i));
    await store.checkpoint();
    const snapPath = path.join(dir, 'snapshot.json');
    const goodSnap = JSON.parse(await readFile(snapPath, 'utf8'));

    // (i) 版違い
    await writeFile(snapPath, JSON.stringify({ ...goodSnap, foldVersion: 'wrong-version' }));
    let reopened = await StoreC.open(dir);
    assert.equal(canonical(reopened.state()), canonical(store.state()));
    assert.ok(reopened.snapshotRejections.includes('version-mismatch'));

    // (ii) cursor がログ末尾を越える
    await writeFile(snapPath, JSON.stringify({
      ...goodSnap, cursor: { ...goodSnap.cursor, byteOffset: goodSnap.cursor.byteOffset + 999999 },
    }));
    reopened = await StoreC.open(dir);
    assert.equal(canonical(reopened.state()), canonical(store.state()));
    assert.ok(reopened.snapshotRejections.includes('cursor-past-eof'));

    // (iii) 中身だけ改竄（version・cursor は正しいまま、state だけ書き換える）。
    // 実測で判明したトレードオフ：軽量な open()（cursor/version だけ見る）は
    // これを検出「できない」——検出には verifyIntegrity()（O(n)、明示的に呼ぶ）が要る。
    const tamperedSnap = { ...goodSnap, state: { counts: { hacked: 999 }, lastByType: {}, total: 999 } };
    await writeFile(snapPath, JSON.stringify(tamperedSnap));
    reopened = await StoreC.open(dir);
    assert.equal(reopened.state().total, 999,
      '軽量な open() は state 改竄をそのまま信頼するはず（意図した制約——下の verifyIntegrity で検出する）');

    const verdict = await reopened.verifyIntegrity();
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'state-tampered',
      'coveredBytesHash（ログ側のハッシュ）だけでは state 自身の改竄は検出できない' +
      '——実際に一度これで検出漏れした（integrityHash を追加する前）。state と' +
      'coveredBytesHash を合わせてハッシュする必要がある');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('torn な最終レコードは「無い」とみなされ、黙って捨てず次の append で切り詰められる', async () => {
  const dir = await tmpDir();
  const logPath = path.join(dir, 'log.jsonl');
  try {
    const store = await StoreB.open(dir);
    const rng = xorshift32(21);
    for (let i = 0; i < 5; i++) await store.append(makeEvent(rng, i));
    const sizeBefore = (await stat(logPath)).size;
    // 末尾を壊す（'\n' を含まない半端なバイト列を追加）
    const fh = await (await import('node:fs/promises')).open(logPath, 'a');
    await fh.write(Buffer.from('{"v":1,"id":"broken'));
    await fh.close();

    // 読み直すと torn な行は無視される
    const reopened = await StoreB.open(dir);
    assert.equal(reopened.cursor().seq, 5, 'torn レコードが1件として数えられてしまっている');

    // 次の append の前に、torn tail を明示的に切り詰める（規則2：黙って混在させない）
    const truncated = await truncateTornTail(logPath);
    assert.equal(truncated, true);
    const sizeAfter = (await stat(logPath)).size;
    assert.equal(sizeAfter, sizeBefore, '切り詰め後のサイズが壊れる前と一致しない');

    await reopened.append(makeEvent(rng, 5));
    await assertRule3(reopened);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- 別プロセスでの再開（同一プロセスの reopen では singleton に助けられて通ってしまう） ----

test('StoreC: 別プロセスで reopen しても、書いたプロセスの state と一致する', async () => {
  const dir = await tmpDir();
  try {
    const store = await StoreC.open(dir);
    const rng = xorshift32(99);
    for (let i = 0; i < 20; i++) await store.append(makeEvent(rng, i));
    await store.checkpoint();
    const expected = canonical(store.state());

    const child = spawnSync(process.execPath, [path.join(here, 'shared', 'reopen-and-print.mjs'), dir], {
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, `子プロセスが失敗: ${child.stderr}`);
    const actual = child.stdout.trim();
    assert.equal(actual, expected, '別プロセスでの再構築結果が、書いたプロセスの state と一致しない');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
