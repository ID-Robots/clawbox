const { Router } = require('express');
const router = Router();
const network = require('../lib/network');
const configStore = require('../lib/config-store');
const systemInfo = require('../lib/system-info');

// GET /api/wifi/scan
router.get('/wifi/scan', async (req, res) => {
  try {
    const networks = await network.scanWifi();
    res.json({ networks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wifi/connect
router.post('/wifi/connect', async (req, res) => {
  const { ssid, password } = req.body;
  if (!ssid) return res.status(400).json({ error: 'SSID is required' });

  try {
    // Save credentials
    await configStore.set('wifi_ssid', ssid);
    await configStore.set('wifi_configured', true);

    // Respond before switching networks (client will lose connection)
    res.json({
      success: true,
      message: 'WiFi credentials saved. Switching networks in 5 seconds...'
    });

    // Delay then switch: tear down AP, connect as client
    setTimeout(async () => {
      try {
        await network.switchToClient(ssid, password);
      } catch (err) {
        console.error('[WiFi] Failed to connect, restarting AP:', err.message);
        await network.restartAP();
      }
    }, 5000);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wifi/status
router.get('/wifi/status', async (req, res) => {
  try {
    const status = await network.getWifiStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/telegram/configure
router.post('/telegram/configure', async (req, res) => {
  const { botToken } = req.body;
  if (!botToken) return res.status(400).json({ error: 'Bot token is required' });
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
    return res.status(400).json({ error: 'Invalid bot token format' });
  }

  try {
    await configStore.set('telegram_bot_token', botToken);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/telegram/status
router.get('/telegram/status', async (req, res) => {
  try {
    const token = await configStore.get('telegram_bot_token');
    res.json({ configured: !!token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/system/info
router.get('/system/info', async (req, res) => {
  try {
    const info = await systemInfo.gather();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/complete
router.post('/setup/complete', async (req, res) => {
  try {
    await configStore.set('setup_complete', true);
    await configStore.set('setup_completed_at', new Date().toISOString());
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/setup/status
router.get('/setup/status', async (req, res) => {
  try {
    const config = await configStore.getAll();
    res.json({
      setup_complete: !!config.setup_complete,
      wifi_configured: !!config.wifi_configured,
      telegram_configured: !!config.telegram_bot_token
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
