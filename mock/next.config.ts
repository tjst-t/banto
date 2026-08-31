import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // LAN 内の他端末（携帯等）から dev サーバへアクセスするために要る
  // （Next 15.2+ の既定ブロックを解除。無いと HMR やアセット取得が壊れる）
  allowedDevOrigins: ["192.168.1.47", "*.local"],
};

export default nextConfig;
