module.exports = {
  apps: [{
    name: 'resultshield',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 1000,
    exp_backoff_restart_delay: 100,
    env: { NODE_ENV: 'development' }
  }]
};
