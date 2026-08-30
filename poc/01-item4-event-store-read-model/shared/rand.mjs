// シード付き疑似乱数（xorshift32）。fast-check は依存として足さなかった
// （規則10——今回の目的は「決定的に再現できる操作列」で十分、自動 shrinking までは要らない。
// 失敗したら seed をログに残せば再現できる）。
export function xorshift32(seed) {
  let x = seed >>> 0 || 1;
  return function rng() {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0xffffffff;
  };
}

export function randomSeed() {
  // Date.now()/Math.random() はワークフロー内では使えない制約があるが、
  // これは単なる CLI スクリプトなので使ってよい。再現したい場合は
  // 出力された seed を引数で渡し直す。
  return (Math.random() * 0xffffffff) >>> 0;
}
