import type { NextConfig } from "next";

// Every route is per-user and dynamic, so cacheComponents stays off.
const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
