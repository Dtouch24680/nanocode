/**
 * PM2 ecosystem config for Nanocode.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs nanocode
 *   pm2 restart nanocode
 *   pm2 stop nanocode
 *   pm2 delete nanocode
 *
 * Architecture: docs/architecture.md#server-architecture
 */

module.exports = {
  apps: [
    {
      name: 'nanocode',
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
