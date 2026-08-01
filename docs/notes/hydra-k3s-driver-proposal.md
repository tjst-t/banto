---
id: hydra-k3s-driver-proposal
type: note
status: draft
refs: [spec-environment, adr-0010]
---

# Hydra k3s ベース検証環境ドライバ 設計提案

## 1. 概要

oicteam/hydra（医療ファイルアーカイブ基盤、k3s 前提）の検証環境を banto のドライバ契約（`docs/spec/environment.md` §2）で提供する**カスタムドライバの設計提案**。provision 方式は **k3d（k3s in Docker）** を第一選択とし、タスクごとの使い捨て k3s クラスタ上で hydra の devvm smoke スイート（マニフェスト検証〜実機相当 smoke）を回せるようにする。外部 VM（Proxmox）方式は 2 本目のプロファイルとして段階的に追加する。

## 2. Hydra の調査結果（根拠ファイルパス）

### 2.1 構成

- Hydra は NTT East 向け医療ファイルアーカイブ基盤。自社サービスは Storage Core API / Workflow Worker / Admin API(+admin-web)（`docs/design/adr/0009-k3s.md`、`CLAUDE.md`）
- k3s 採用（ADR-0009）。インフラは 3 層（`docs/design/adr/0028-vm-provisioning-config-management.md`）: Layer1=Proxmox（cloud-init・手動）/ Layer2=Ansible / Layer3=ArgoCD+Helm。「VM の中身=Ansible、k3s の中身=ArgoCD」
- dev 環境は Proxmox 上の 4 VM（`docs/design/operations/environments.md` §1、`docs/runbooks/build/dev-coldstart.md`）:
  - `hydra-dev-k3s-01` 10.10.254.51（8vCPU/32GB）: k3s 1 ノードに全 Pod（CNPG/storage-core/workflow-worker/admin-*/temporal/registry 等）
  - `hydra-dev-vault-01` 10.10.254.52: Vault Server（Raft、Shamir 5/3、k3s 外置き = ADR-0029）
  - `hydra-dev-proxy-01` 10.10.254.53: Proxy VM（NFS/Samba/FUSE）
  - `hydra-dev-localstack-01` 10.10.254.54: moto（S3 hot + Glacier cold×2）
  - ユーザ spadmin、SSH + GitHub 鍵同期（ADR-0028）

### 2.2 k3s の構築方法

- `ansible/roles/k3s-node/tasks/main.yml`: k3s 公式インストーラ（`v1.30.4+k3s1`）、`server --disable=traefik --disable=servicelb --write-kubeconfig-mode=644`。dev は containerd に `localhost:5000` を http insecure で登録（registries.yaml、in-cluster registry 用）
- `ansible/roles/k3s-base-operators/tasks/main.yml`: Helm install — cert-manager v1.15.3 / ArgoCD 7.6.8（NodePort 30080）/ ESO 0.10.4 / CNPG 0.22.1 / Reloader 1.2.0 / kube-prometheus-stack 62.7.0
- CNI は Flannel→Cilium 入替（`ansible/roles/k3s-node/tasks/cilium.yml`、ADR-0019、opt-in タグ）。hydra-system は default-deny netpol（`deploy/k8s/netpol/base/default-deny.yaml`）→ **netpol 検証には Cilium が必要**

### 2.3 アプリデリバリ（two-loop）

- `docs/runbooks/build/dev-deploy.md` / ADR-0041:
  - outer loop: ArgoCD が `deploy/k8s/*/overlays/dev` を git から reconcile（kubectl apply 直接実行は禁止 = ADR-0024）
  - inner loop: ko/buildah で `localhost:5000/hydra/<comp>:0.1.0-dev` に push → Pod 削除で再作成（imagePullPolicy: Always、manifest 不変で Argo Synced 維持）
- registry: `deploy/k8s/registry/registry.yaml`（registry:2.8.3、hostPort 5000、local-path PVC 10Gi。bootstrap 層 = Argo 管理外）
- 環境差分は kustomize overlays + Ansible inventory（ADR-0038）: SPIFFE trust-domain `spiffe://hydra.{env}`、Vault アドレス、バケット `hydra-{env}-*`

### 2.4 シークレット・依存サービス

- Vault(10.10.254.52) + ESO。ClusterSecretStore `vault-kv-dev` が k8s auth でログインし、`storage-core-db` / `workflow-worker-db` / `admin-api-db` / `admin-api-jwt` 等の ExternalSecret を生成（`deploy/eso/`）
- DB DSN は CNPG 生成 secret から Vault に seed（`ansible/scripts/deploy-dev-k8s.sh` の `seed_vault_db`、pgbouncer 経由 DSN）。cert-manager↔Vault PKI の bootstrap Secret も Argo 管理外
- メタ DB は CloudNativePG Cluster `hydra-metadb`（hydra-system）+ pgbouncer。DB migration は golang-migrate Job（`ansible/scripts/db-migrate.sh`、Cilium 起動レース対策リトライ入り）

### 2.5 検証（priority_rule 9）

- Story done の必要条件 = dev VM 実機 deploy + smoke（`CLAUDE.md`、Makefile）
- `tests/acceptance/devvm/*`（build tag `devvm`、`make test-devvm`）: backend_smoke_test.go（moto への flashblade/s3glacier PUT-GET-Restore、実 Vault Transit、ESO 経由 secret 注入）、admin_api_smoke_test.go、storage_core_smoke_test.go、proxy_fuse_*、workflow_smoke_test.go 等 50 本
- admin ログイン E2E: password→MFA(TOTP)→session→`GET /v1/admin/tenants` 200（`docs/runbooks/build/dev-coldstart.md`）

### 2.6 本番と検証で変わる点・変えられない点

- dev までは moto 統一、staging から実機 FlashBlade + Deep Archive（ADR-0024）。実機特有（Restore レイテンシ 12-48h / rate limit / 性能）は dev では見えない
- **個人 dev は「ローカル PC (Docker Compose で k3d + moto + PostgreSQL) で代替可能」と ADR-0024 に明記** → k3d の前例あり
- staging は skeleton（`ansible/inventory/staging/hosts.yml`、10.20.2.x、実機 Backend 予定）。prod は 9-10 VM（environments.md §3）

## 3. ドライバ設計案（7動詞）

前提: ドライバ = プロジェクト内実行ファイル（`meta/drivers/hydra-k3s`）。argv[1]=動詞、stdin=JSON、stdout=JSON、exit 0 以外=失敗。handle は不透明 JSON `{cluster, taskId, stateDir}`。管理下リソースは `hydra-<taskId>` プレフィックス命名。状態は stateDir（例: `~/.local/state/banto-hydra-k3s/<taskId>/`）に保持し、k3d/Docker から再導出可能にする（クラッシュ回復）。

### provision

入力: config + taskId + workdir。手順:

1. k3d cluster create `hydra-<taskId>` — k3s は実 dev と同じ `v1.30.4+k3s1`、`--disable traefik --disable servicelb`、**flannel 無効 + Cilium Helm install**（netpol 検証のため）。ノードに `expires=<ts>` ラベル（spec §7.4 の可視性の保険に相当）
2. k3d registry を**空きホストポート**に割当て（複数インスタンスのポート衝突回避。push は host→割当てポート、pull は node containerd が k3d ネットワーク内レジストリを見る = 実 dev の registries.yaml と同機構）
3. Helm install base operators（cert-manager / ESO / CNPG / Reloader。k3s-base-operators と同バージョン）
4. **Vault dev-mode コンテナ**を sibling / in-cluster に起動 → k8s auth 有効化 → `seed_vault_db` 相当の secret seed（ESO ClusterSecretStore の Vault アドレスは kustomize patch で差替え）
5. **moto コンテナ**を起動（S3 hot + Glacier cold。実 dev と同じモック前提）し、backend endpoint を patch
6. workdir の `deploy/k8s/*/overlays/dev` を `kubectl apply -k` で適用（Vault アドレス・moto endpoint・trust-domain を driver 用 patch で置換。ADR-0038 のパラメータ化機構を利用）
7. アプリ image をビルド・push（`make devvm-deploy COMPONENT=all` 相当）→ CNPG Ready 待ち → `db-migrate.sh up` → admin ユーザ seed
8. 出力 `{handle}`

プロビジョン時間は数分〜10 分超（image ビルド含む）を想定。config で `build_images: true|false` を切り替え可能にし、事前ビルド済み 0.1.0-dev image を使う高速モードも用意。

### deploy

入力: handle + artifactPath。**inner loop 相当**:

- artifactPath の basename / config の `components` マップから component 名を解決（例: `dist/storage-core/` → storage-core）
- ビルド済み image を in-cluster registry に push（`localhost:5000/hydra/<comp>:0.1.0-dev`）→ `kubectl delete pod -l app.kubernetes.io/name=<comp>` → Deployment が Always 再 pull で再作成（実 dev の inner loop と同一）
- マニフェスト変更も反映したい場合は workdir の overlay を `kubectl apply -k`（使い捨て環境のため直接 apply。ADR-0024 との関係は §6 参照）
- artifact→component の解決規約は実装時の未決事項（§6）

### healthcheck

入力: handle。出力 `{ok, detail?}`:

- `kubectl get nodes` 全 Ready
- 主要 Deployment（storage-core / workflow-worker / admin-api / admin-web / registry / CNPG cluster）が Available / Ready
- Vault シード済み・migration 完了・ESO ExternalSecret が Synced
- 必要なら admin-api の `/readyz` 等への HTTP probe。失敗時は detail に理由

### run

入力: handle + cmd + workdir。出力 `{exit, log_path}`:

- `bash -lc <cmd>` を cwd=workdir で実行。env に KUBECONFIG（k3d kubeconfig get で再生成可）、各サービス endpoint（NodePort の空きホストポート割当て）を注入
- devvm テストが期待する env 契約（KUBECONFIG / VAULT_ADDR / S3 endpoint 等）は config で定義し、helpers の実装に合わせる
- ログは stateDir の `run-<n>.log` に書く。タイムアウトは config の `timeout_ms`（未指定時は既定 30m。spec §8 の未決に追従）

### collect

入力: handle + dest dir:

- 全 namespace の Pod ログ（`kubectl logs`）、`kubectl describe`、ExternalSecret/Argo 状態を dest にファイル化
- stateDir の run ログ・テスト成果物（junit 等）を dest へコピー

### teardown

入力: handle。**冪等必須**:

- `k3d cluster delete hydra-<taskId>`（registry 含む）。事前に `k3d cluster list` で存在確認し、無ければ exit 0（成功扱い）
- Docker コンテナごと消えるため孤児 VM リスクは構造的に無い

### list

入力: —。出力 `[{handle, name, created}]`:

- `k3d cluster list` + stateDir を突き合わせ、`hydra-<taskId>` プレフィックスのクラスタを列挙。created は handle の記録 or Docker inspect の Created
- Environment Pool の照合（spec §5）に使う

## 4. provision 方式の比較と推奨

| 観点 | **k3d（k3s in Docker）** | Proxmox VM（4VM 相当） | Proxmox VM（1VM） |
|---|---|---|---|
| provision 速度 | 数十秒〜10 分（image ビルド含む） | 20〜40 分（ansible site.yml 込み） | 10 分超（VM clone + k3s 構築） |
| コスト | ホストの Docker のみ（追加費なし） | VM リソース恒常確保 + Proxmox 運用 | 同上（1VM 分） |
| 使い捨て性 | 最高（コンテナ削除で完全消滅） | 低（VM 削除は遅く孤児リスク） | 中 |
| 実 dev との一致度 | k3s 本体は同バイナリ・同バージョン。Vault/moto はコンテナで代替 | 同一トポロジ（Vault/Proxy/moto VM 個別） | OS/containerd は実機、Vault/moto はコンテナ |
| netpol（Cilium）検証 | 可（flannel 無効 + Cilium helm） | 可 | 可 |
| proxy FUSE/NFS/Samba 検証 | **不可**（対象外） | 可 | 不可 |
| credentials（sops） | 不要（Docker ソケットのみ） | 要（スコープ済み Proxmox トークン） | 要 |
| TTL・quota・照合との相性 | **最良**（強制 teardown=高速、照合=cluster list） | 可（§7 リファレンス準拠） | 可 |
| 前例 | ADR-0024 が「個人 dev は k3d + moto + PostgreSQL」と明記 | spec §7 のリファレンス実装 | — |

**推奨: k3d**

1. 検証ニーズの中心は「アプリの k8s マニフェスト検証〜実機 smoke」。k3d は実 dev と同じ k3s v1.30.4+k3s1・同 containerd レジストリ機構・Cilium/netpol まで再現でき、devvm スイートの大部分（storage-core / admin-api / workflow / CNPG / ESO / netpol / migration / temporal / tiering）を実 k8s API 上で回せる
2. ADR-0024 が k3d を公式の代替手段として認めており再発明でない（D6）
3. spec §5 の最優先機構（TTL・照合・孤児防止）と最も相性が良く、外部リソースの消し忘れリスクが構造的に無い。credentials 不要なので sops・Environment Pool HTTP 面の露出も減る
4. 補完: proxy_fuse 等の Proxy VM 依存テストはドライバ環境の対象外とし、共有 dev VM（priority_rule 9）が引き続き担う。実機 FlashBlade/Deep Archive 検証が必要になったら spec §7 の Proxmox ドライバを雛形に 2 本目のプロファイルを足す

## 5. meta/environments.yaml のプロファイル定義案

```yaml
# oicteam/hydra リポジトリの meta/environments.yaml（新設）
profiles:
  hydra-k3s:                 # タスクごとの使い捨て検証環境
    driver: ./meta/drivers/hydra-k3s
    config:
      k3s_version: v1.30.4+k3s1      # 実 dev と同じ（ADR-0009 / k3s-node role）
      disable: [traefik, servicelb]  # 実 dev と同じ
      cni: cilium                    # netpol 検証用（ADR-0019）
      registry: true                 # in-cluster registry（k3d registry、空きポート割当）
      vault: { mode: dev, seed: true }   # dev-mode Vault + seed_vault_db 相当
      moto: true                     # S3 hot + Glacier cold モック
      app_overlay: deploy/k8s        # workdir の overlays/dev を apply（driver patch 適用）
      build_images: true             # provision 時に全 image をビルド・push
      components:                    # deploy の artifact→component 解決
        storage-core:    { label: app.kubernetes.io/name=storage-core }
        workflow-worker: { label: app.kubernetes.io/name=workflow-worker }
        admin-api:       { label: app.kubernetes.io/name=admin-api }
        admin-web:       { label: app.kubernetes.io/name=admin-web }
      timeout_ms: 1800000             # run の既定タイムアウト（30m）
    ttl: 4h                # defaultTtl(30m) では provision が完了しないため明示。maxTtl(24h) 内
    quota: { max_instances: 2 }       # maxInstancesPerProfile(4) 以下。ホスト RAM の制約から2
    # credentials: なし（Docker ソケットのみ。sops 経路不要）
```

capacity 上限との整合: `ttl: 4h ≤ maxTtlMs(24h)`、`quota.max_instances: 2 ≤ maxInstancesPerProfile(4)`。全スタック 1 インスタンスあたり RAM 6〜8GB を想定し、quota はホストリソースに合わせて調整する。

## 6. リスク・未決事項・実装時の注意点

- **provision 時間 vs TTL**: 既定 30m では cold-start（image ビルド込み）が間に合わない。プロファイルで `ttl: 4h` を明示必須。`build_images: false`（事前ビルド image 使用）の高速モードを用意し、用途で使い分ける
- **ADR-0024「kubectl apply 直接実行禁止」との関係**: 規律の対象は共有 dev 環境。使い捨て driver 環境では kustomize 直接 apply を使うが、**hydra 側で対象外とすることの確認が必要**（未決事項）
- **proxy FUSE/NFS/Samba テストは対象外**: 共有 dev VM（priority_rule 9）が引き続き担当。スコープ線引きを明文化する
- **deploy の artifact→component 解決**: 契約上 artifactPath しか渡らないため、basename 規約 or config の components マップで解決。実装時に規約を確定する
- **run のタイムアウト**: spec §8 未決（Environment Pool 側で一律かプロファイルか）。driver は config の `timeout_ms` を受ける形にし、Pool 側の裁定を待つ
- **ホストリソース**: 複数インスタンスの同時稼働で RAM/Disk が逼迫。quota と監視が必要（k3d クラスタ + registry + 全 Pod で 6〜8GB/台）
- **k3d と k3s のバージョン追従**: k3s バージョンは実 dev に揃える。k3d 自体の更新で挙動が変わる可能性あり
- **ホスト再起動時**: k3d クラスタは Docker 再起動で復活する。handle からの再アタッチ（`k3d kubeconfig get`）と、起動後の healthcheck を必ず行う
- **実機依存検証（staging 相当）**: 本提案は dev 相当まで。実機 FlashBlade/Deep Archive を使う検証は別プロファイル（Proxmox、§7 参照）で対応

## 関連

- `docs/spec/environment.md`（ドライバ契約・§7 Proxmox リファレンス・§5.1 上限）
- oicteam/hydra: `docs/design/adr/0009-k3s.md` / `0024-dev-test-environment.md` / `0028-vm-provisioning-config-management.md` / `0038-env-parameterization.md` / `0041-dev-delivery-registry-argocd.md`、`docs/runbooks/build/dev-deploy.md`、`ansible/roles/k3s-node/tasks/main.yml`、`deploy/k8s/netpol/base/default-deny.yaml`、`tests/acceptance/devvm/`
