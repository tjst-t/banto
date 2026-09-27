# PoC 10：Project の実行場所に VM を選べるか

**捨てる前提のコード**。決めるための計測だけ。

問い：ハイパーバイザーやカーネルに触るアプリを banto で開発するには、Project をコンテナではなく VM で
動かす必要がある。banto と同じ条件（incus-user の制限つき区画）で、次が成り立つか。

1. VM を作れるか
2. VM の中で `/dev/kvm` が使えるか（入れ子の仮想化）
3. VM に Project のフォルダを見せられるか・持ち主がどう見えるか（コンテナは `raw.idmap` で揃えたが、VM には効かない）
4. コンテナに `/dev/kvm` を渡せるか
5. コンテナの入れ子（Incus on Incus・Docker）を許せるか

あわせて、2026-09-27 に起動元を切り替えたあとも Project のコンテナに古い読み取り専用のマウントが残っていた件
（`docs/specs/v4-security.md` §2）を、host 側の disk デバイスの一覧で確かめる（0c）。

## 分かっていること（2026-09-27、コンテナの中から）

- この機械自体が VM（`hypervisor` フラグ）。CPU は AMD で `svm` が見え、`kvm_amd` の `nested=1`
- Project のコンテナの中に `/dev/kvm` は無い
- 制限つき区画は入れ子を許し、proxy デバイスを禁じ、ホストのフォルダはホームの下だけ（PoC 09）

## 実行

host で、banto を動かしているユーザーで：

```sh
sh poc/10-project-vm/probe.sh 2>&1 | tee ~/banto-probe-$(date +%Y%m%d-%H%M).log
```

## 結果

（未実行）
