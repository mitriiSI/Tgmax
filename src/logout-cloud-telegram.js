import 'dotenv/config';

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

try {
  const response = await fetch(`https://api.telegram.org/bot${token}/logOut`, {
    method: 'POST'
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.description ?? `HTTP ${response.status}`);
  }
  console.log('Telegram bot was logged out from the cloud Bot API.');
} catch (error) {
  console.error(`Cloud Telegram logout failed: ${error.message}`);
  process.exit(1);
}
