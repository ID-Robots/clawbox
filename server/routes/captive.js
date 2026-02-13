const { Router } = require('express');
const router = Router();

const PORTAL_URL = 'http://10.42.0.1/';

// Android
router.get('/generate_204', (req, res) => res.redirect(302, PORTAL_URL));
router.get('/gen_204', (req, res) => res.redirect(302, PORTAL_URL));

// Apple
router.get('/hotspot-detect.html', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send('<HTML><HEAD><TITLE>ClawBox Setup</TITLE></HEAD><BODY>Please complete setup.</BODY></HTML>');
});
router.get('/library/test/success.html', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send('<HTML><HEAD><TITLE>ClawBox Setup</TITLE></HEAD><BODY>Please complete setup.</BODY></HTML>');
});

// Windows NCSI
router.get('/connecttest.txt', (req, res) => res.redirect(302, PORTAL_URL));
router.get('/redirect', (req, res) => res.redirect(302, PORTAL_URL));
router.get('/ncsi.txt', (req, res) => res.redirect(302, PORTAL_URL));

// Firefox
router.get('/canonical.html', (req, res) => res.redirect(302, PORTAL_URL));
router.get('/success.txt', (req, res) => res.redirect(302, PORTAL_URL));

module.exports = router;
