'use strict';
// Prépare le mode « téléphone sur le même Wi-Fi » : HOST=0.0.0.0 et un jeton d'accès généré, écrits dans .env.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const file = path.join(__dirname, '..', '.env');
let txt = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const has = (k) => new RegExp(`^\\s*${k}\\s*=\\s*\\S`, 'm').test(txt);
const set = (k, v) => {
  const re = new RegExp(`^\\s*${k}\\s*=.*$`, 'm');
  txt = re.test(txt) ? txt.replace(re, `${k}=${v}`) : txt.replace(/\s*$/, '\n') + `${k}=${v}\n`;
};
set('HOST', '0.0.0.0');
let token = (txt.match(/^\s*APP_ACCESS_TOKEN\s*=\s*(\S+)/m) || [])[1];
if (!token) { token = crypto.randomBytes(9).toString('base64url'); set('APP_ACCESS_TOKEN', token); }
fs.writeFileSync(file, txt);
console.log('\n  Mode téléphone prêt.');
console.log('  Ton jeton d\'accès (à saisir une fois sur le téléphone) : ' + token + '\n');
