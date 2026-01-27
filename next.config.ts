import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Allow our internal proxy endpoints to be used with <Image />
    localPatterns: [
      {
        pathname: "/api/thumbnail-proxy",
      },
      {
        pathname: "/api/image-proxy",
      },
    ],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        port: '',
        pathname: '/drive-storage/**',
      },
      {
        protocol: 'https',
        hostname: 'drive.google.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'googleusercontent.com',
        port: '',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
