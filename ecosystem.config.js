// Run the panel itself under pm2:
//   pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: 'pagermon-panel',
      script: 'server.js',
      cwd: __dirname,
      env: { PANEL_CONFIG: __dirname + '/config.json' },
      autorestart: true,
      max_restarts: 20,
      watch: false,
    },
  ],
};
