const wizard = {
  currentStep: 1,
  selectedSSID: null,
  selectedSecurity: '',

  goTo(step) {
    // Hide all steps
    document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
    // Show target step
    document.getElementById('step-' + step).classList.add('active');

    // Update progress bar
    document.querySelectorAll('.progress-step').forEach(el => {
      const s = parseInt(el.dataset.step);
      el.classList.toggle('active', s <= step);
      el.classList.toggle('done', s < step);
    });

    this.currentStep = step;

    // Trigger actions on step enter
    if (step === 2) this.scanWifi();
    if (step === 4) this.loadSystemInfo();
  },

  async scanWifi() {
    const list = document.getElementById('wifi-list');
    list.innerHTML = '<div class="loading"><div class="spinner"></div> Scanning for networks...</div>';

    try {
      const res = await fetch('/api/wifi/scan');
      const data = await res.json();

      if (!data.networks || data.networks.length === 0) {
        list.innerHTML = '<div class="empty">No networks found. <button class="btn-link" onclick="wizard.scanWifi()">Try again</button></div>';
        return;
      }

      list.innerHTML = data.networks.map(n => {
        const bars = Math.min(4, Math.max(1, Math.ceil(n.signal / 25)));
        const lock = n.security && n.security !== '' && n.security !== '--';
        return `
          <div class="wifi-item" onclick="wizard.selectNetwork('${escapeHtml(n.ssid)}', '${escapeHtml(n.security || '')}')">
            <div class="wifi-signal">${signalBars(bars)}</div>
            <div class="wifi-name">${escapeHtml(n.ssid)}</div>
            <div class="wifi-lock">${lock ? '&#128274;' : ''}</div>
          </div>`;
      }).join('');
    } catch (err) {
      list.innerHTML = '<div class="error">Scan failed. <button class="btn-link" onclick="wizard.scanWifi()">Retry</button></div>';
    }
  },

  selectNetwork(ssid, security) {
    this.selectedSSID = ssid;
    this.selectedSecurity = security;
    document.getElementById('selected-ssid').textContent = ssid;

    const passField = document.getElementById('password-field');
    const isOpen = !security || security === '' || security === '--';
    passField.style.display = isOpen ? 'none' : 'block';
    document.getElementById('wifi-password').value = '';

    hideStatus('wifi-status');
    document.getElementById('wifi-modal').classList.remove('hidden');
  },

  closeModal() {
    document.getElementById('wifi-modal').classList.add('hidden');
  },

  async connectWifi() {
    const password = document.getElementById('wifi-password').value;
    const btn = document.getElementById('wifi-connect-btn');
    btn.disabled = true;
    btn.textContent = 'Connecting...';

    try {
      const res = await fetch('/api/wifi/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssid: this.selectedSSID, password })
      });
      const data = await res.json();

      if (data.success) {
        showStatus('wifi-status', 'success',
          'WiFi credentials saved! ClawBox will switch to your home network in a few seconds. ' +
          'Reconnect to your home WiFi and visit http://clawbox.local to continue.');
        // Auto-advance after delay
        setTimeout(() => {
          this.closeModal();
          this.goTo(3);
        }, 3000);
      } else {
        showStatus('wifi-status', 'error', data.error || 'Connection failed');
      }
    } catch (err) {
      showStatus('wifi-status', 'error', 'Connection failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  },

  async saveTelegram() {
    const token = document.getElementById('bot-token').value.trim();
    if (!token) {
      showStatus('telegram-status', 'error', 'Please enter a bot token');
      return;
    }

    try {
      const res = await fetch('/api/telegram/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: token })
      });
      const data = await res.json();

      if (data.success) {
        showStatus('telegram-status', 'success', 'Telegram bot configured!');
        setTimeout(() => this.goTo(4), 1000);
      } else {
        showStatus('telegram-status', 'error', data.error || 'Failed to save');
      }
    } catch (err) {
      showStatus('telegram-status', 'error', 'Failed: ' + err.message);
    }
  },

  async loadSystemInfo() {
    const container = document.getElementById('system-info');
    container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading system info...</div>';

    try {
      const res = await fetch('/api/system/info');
      const info = await res.json();

      container.innerHTML = `
        <div class="info-item">
          <span class="info-label">Hostname</span>
          <span class="info-value">${escapeHtml(info.hostname)}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Platform</span>
          <span class="info-value">${escapeHtml(info.platform)}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Architecture</span>
          <span class="info-value">${escapeHtml(info.arch)}</span>
        </div>
        <div class="info-item">
          <span class="info-label">CPUs</span>
          <span class="info-value">${info.cpus}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Memory</span>
          <span class="info-value">${escapeHtml(info.memoryFree)} free / ${escapeHtml(info.memoryTotal)}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Temperature</span>
          <span class="info-value">${escapeHtml(info.temperature)}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Uptime</span>
          <span class="info-value">${escapeHtml(info.uptime)}</span>
        </div>`;
    } catch {
      container.innerHTML = '<div class="error">Failed to load system info</div>';
    }
  },

  async completeSetup() {
    try {
      await fetch('/api/setup/complete', { method: 'POST' });
      document.querySelector('#step-4 .card h1').textContent = 'Setup Complete!';
      document.querySelector('#step-4 .btn-primary').textContent = 'Done';
      document.querySelector('#step-4 .btn-primary').onclick = null;
    } catch { /* ignore */ }
  }
};

// --- Helpers ---

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function signalBars(level) {
  let svg = '<svg width="16" height="16" viewBox="0 0 16 16">';
  for (let i = 0; i < 4; i++) {
    const h = 4 + i * 3;
    const y = 16 - h;
    const fill = i < level ? '#2563eb' : '#d1d5db';
    svg += `<rect x="${i * 4}" y="${y}" width="3" height="${h}" rx="1" fill="${fill}"/>`;
  }
  svg += '</svg>';
  return svg;
}

function showStatus(id, type, msg) {
  const el = document.getElementById(id);
  el.className = 'status-msg ' + type;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideStatus(id) {
  document.getElementById(id).classList.add('hidden');
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  // Check if setup is already complete
  fetch('/api/setup/status')
    .then(r => r.json())
    .then(data => {
      if (data.setup_complete) {
        wizard.goTo(4);
      }
    })
    .catch(() => {});
});
