import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import makeWASocket, {
  Browsers,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

const app = express();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.PAIRING_SECRET || '';
const sessions = path.resolve('sessions');
fs.mkdirSync(sessions, { recursive: true });

app.get('/', (_req, res) => res.send('Bappa X is running'));
app.get('/health', (_req, res) => res.json({ ok: true }));

const waiting = new Set();
const logger = pino({ level: 'silent' });

bot.start(async ctx => {
  waiting.add(ctx.from.id);
  await ctx.reply(
    'Welcome to Bappa X!\n\nSend your WhatsApp number with country code, digits only.\nExample: 8801XXXXXXXXX'
  );
});

bot.on('text', async ctx => {
  if (ctx.message.text.startsWith('/')) return;
  if (!waiting.has(ctx.from.id)) {
    return ctx.reply('Send /start first.');
  }

  const phone = ctx.message.text.replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15) {
    return ctx.reply('Invalid number. Send country code + number, digits only.');
  }

  waiting.delete(ctx.from.id);
  const dir = path.join(sessions, phone);

  try {
    if (fs.existsSync(path.join(dir, 'creds.json'))) {
      return ctx.reply('A saved session exists for this number. Contact the bot owner.');
    }

    fs.mkdirSync(dir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);
    const code = await sock.requestPairingCode(phone);
    await ctx.reply(
      `Your WhatsApp pairing code: ${code}\n\nOn WhatsApp: Linked devices → Link with phone number, then enter this code.\n\nKeep the code private.`
    );
  } catch (err) {
    console.error('Pairing failed:', err?.message || err);
    await ctx.reply('Pairing failed. Check Render logs and try again later.');
  }
});

bot.catch(err => console.error('Telegram error:', err?.message || err));

(async () => {
  app.listen(PORT, () => console.log(`Bappa X listening on ${PORT}`));
  await bot.launch();
  console.log('Telegram bot started');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
