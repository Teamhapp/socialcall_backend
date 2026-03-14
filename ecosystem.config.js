// PM2 process manager config
// Usage:
//   pm2 start ecosystem.config.js          # start
//   pm2 reload ecosystem.config.js         # zero-downtime restart
//   pm2 logs socialcall                    # stream logs
//   pm2 monit                              # real-time dashboard
//
// ⚠️  IMPORTANT — instances is set to 1 because Socket.IO stores the
//   online-users map in process memory.  To scale to multiple CPUs:
//   1. npm install @socket.io/redis-adapter
//   2. Wire the adapter in src/socket/socket.js
//   3. Set instances: 'max' here

module.exports = {
  apps: [
    {
      name: 'socialcall',
      script: 'server.js',
      instances: 1,         // see note above before increasing
      exec_mode: 'fork',    // change to 'cluster' when Redis adapter is ready
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 5000,
      },
      // Graceful shutdown — give Socket.IO time to close connections
      kill_timeout: 5000,
      // Auto-restart on crash with exponential back-off
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      // Structured logs
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
    },
  ],
};
