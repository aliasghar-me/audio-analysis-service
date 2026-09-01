import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * Proxy the API through this origin instead of configuring CORS.
 *
 * The browser only ever talks to its own origin, so there is no preflight and
 * no allowlist to keep in sync, and the same client code works in development,
 * in Docker and behind a reverse proxy with one environment variable. Next
 * streams a rewrite, so a large upload is not buffered here on its way past.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  // In a workspace, tracing has to start at the repo root or the standalone
  // bundle misses the hoisted node_modules and the server will not boot.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  async rewrites() {
    const apiUrl = process.env.API_URL ?? 'http://localhost:4490';
    return [
      { source: '/api/:path*', destination: `${apiUrl}/api/:path*` },
      { source: '/health', destination: `${apiUrl}/health` },
    ];
  },
};

export default nextConfig;
