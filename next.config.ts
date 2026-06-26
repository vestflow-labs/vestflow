import type { NextConfig } from "next";

const isMainnet = process.env.NEXT_PUBLIC_NETWORK === "mainnet";

const rpcOrigin = isMainnet
  ? "https://mainnet.sorobanrpc.com"
  : "https://soroban-testnet.stellar.org";

const cspHeader = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline' 'unsafe-eval'`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: blob:`,
  `font-src 'self'`,
  `connect-src 'self' ${rpcOrigin} https://horizon.stellar.org https://horizon-testnet.stellar.org`,
  `frame-ancestors 'none'`,
].join("; ");

const nextConfig: NextConfig = {
  output: process.env.DOCKER_BUILD ? "standalone" : undefined,
  serverExternalPackages: ["better-sqlite3"],
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: cspHeader,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
