/**
 * PM2 ecosystem config for Codebuilder.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs codebuilder
 *   pm2 restart codebuilder
 *   pm2 stop codebuilder
 *   pm2 delete codebuilder
 *
 * Architecture: docs/architecture.md#server-architecture
 */

module.exports = {
  apps: [
    {
      name: 'codebuilder',
      script: 'server/index.js',
      node_args: '--experimental-vm-modules',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        CLAUDECODE: '',
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000,
        CLAUDECODE: '',
      },
    },
  ],
}
