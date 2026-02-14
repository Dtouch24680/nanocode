/**
 * PM2 ecosystem config for Codebuilder services.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs          # start all
 *   pm2 start ecosystem.config.cjs --only terminal
 *   pm2 logs terminal                        # tail terminal logs
 *   pm2 restart terminal                     # restart terminal
 *   pm2 stop all                             # stop all
 *   pm2 delete all                           # remove from pm2 list
 *
 * Architecture: docs/architecture.md
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
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
    },
    {
      name: 'terminal',
      script: 'terminal/server.js',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 4000,
      },
    },
  ],
}
