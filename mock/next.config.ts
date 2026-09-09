import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // LAN 内の他端末（携帯等）や Caddy 経由のホスト名から dev サーバへアクセス
  // するために要る（Next 15.2+ の既定ブロックを解除。無いと HMR やアセット取得が壊れる）。
  // ここに無いホスト名で開くと、`/_next/*` への取得が Origin ヘッダ付きのときだけ
  // 403 になり、**画面は描かれるのにボタンが何も効かない**という壊れ方をする
  // （実測・2026-09-09——mock.banto.tjstkm.net で発生）
  allowedDevOrigins: ["192.168.1.47", "*.local", "banto.tjstkm.net", "*.banto.tjstkm.net"],
};

export default nextConfig;
