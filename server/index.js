const express = require('express');
const path = require('path');
const apiRoutes = require('./routes/api');
const captiveRoutes = require('./routes/captive');

const app = express();
const PORT = 80;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Captive portal detection must come first
app.use(captiveRoutes);

// API routes
app.use('/api', apiRoutes);

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ClawBox Setup running on http://0.0.0.0:${PORT}`);
});
