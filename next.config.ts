import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/api/telegram/webhook": [
      "./automation/config/analytics.example.yaml",
      "./automation/config/publication.example.yaml",
      "./automation/config/research.example.yaml",
      "./automation/config/review.example.yaml",
      "./automation/config/social.example.yaml",
      "./automation/config/writing.example.yaml",
    ],
  },
};

export default nextConfig;
