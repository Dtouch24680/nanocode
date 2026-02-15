/**
 * PM2 ecosystem config for Codebuilder.
 *
 * Two processes:
 *   - codebuilder (:3000) — unified server (task orchestration + terminal)
 *   - terminal    (:4000) — backward-compatible standalone terminal server
 *
 * Both share the same SQLite database and terminal routes.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs codebuilder
 *   pm2 restart all
 *   pm2 stop all
 *   pm2 delete all
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
        CLAUDECODE: '',
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000,
        CLAUDECODE: '',
      },
    },
    {
      name: 'terminal',
      script: 'terminal/server.js',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
        CLAUDECODE: '',
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 4000,
        CLAUDECODE: '',
      },
    },
  ],
}
