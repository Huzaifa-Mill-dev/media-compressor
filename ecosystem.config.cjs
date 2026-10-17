// pm2 process definition (the deploy workflow starts the app from this file, never from a stale saved command).
module.exports = {
  apps: [
    {
      name: "media-compressor",
      script: "server/dist/index.js",
      cwd: __dirname,
      node_args: "--max-old-space-size=384",
      max_memory_restart: "600M",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        // nginx terminates TLS in front of the app: trust one proxy hop so rate limiting sees real client IPs.
        TRUST_PROXY: "1",
      },
    },
  ],
};
