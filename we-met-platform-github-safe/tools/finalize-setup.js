const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '..', 'backend', '.env');
if (!fs.existsSync(envPath)) {
  console.error('backend/.env was not found.');
  process.exit(1);
}

let text = fs.readFileSync(envPath, 'utf8');
text = text.replace(/^RESET_SEEDED_PASSWORDS=.*$/m, 'RESET_SEEDED_PASSWORDS=false');
fs.writeFileSync(envPath, text, 'utf8');
console.log('Seed-password reset was turned off. Future database initialization will preserve portal password changes.');
