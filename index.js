
import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import makeWASocket, {
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is missing in Render Environment');
}

const bot = new Telegraf(TOKEN);
const sessionsDir = path.resolve('sessions');
const logger = pino({ level: 'silent' });

fs.mkdirSync(sessionsDir, { recursive: true });

app.get('/', (_req, res) => {
  res.send('Bappa X is running');
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const waiting = new Set();
const activeNumbers = new Set();

bot.start(async (ctx) => {
  waiting.add(ctx.from.id);

  await ctx.reply(
    'Welcome to Bappa X!\n\n' +
    'Send your WhatsApp number with country code, digits only.\n' +
    'Example: 8801XXXXXXXXX'
  );
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const message = ctx.message.text.trim();

  if (message.startsWith('/')) return;

  if (!waiting.has(userId)) {
    await ctx.reply('Send /start first.');
    return;
  }

  const phone = message.replace(/\D/g, '');

  if (phone.length < 8 || phone.length > 15) {
    await ctx.reply(
      'Invalid number. Send country code and number using digits only.'
    );
    return;
  }

  if (activeNumbers.has(phone)) {
    await ctx.reply(
      'A pairing request is already running for this number. Please wait.'
    );
    return;
  }

  waiting.delete(userId);
  activeNumbers.add(phone);

  const sessionDir = path.join(sessionsDir, phone);

  try {
    fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } =
      await useMultiFileAuthState(sessionDir);

    if (state.creds.registered) {
      await ctx.reply(
        'This number already has registered session credentials. ' +
        'I will not create another pairing code. Check your existing session.'
      );
      return;
    }

    const sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    let codeRequested = false;
    let codeSent = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;

      console.log('WhatsApp connection:', connection);

      if (qr && !codeRequested && !state.creds.registered) {
        codeRequested = true;

        try {
          const code = await sock.requestPairingCode(phone);

          codeSent = true;

          await ctx.reply(
            `Your WhatsApp pairing code: ${code}\n\n` +
            'Open WhatsApp → Linked devices → Link a device → ' +
            'Link with phone number instead.\n\n' +
            'Enter the code shown above. Keep it private.'
          );
        } catch (err) {
          console.error(
            'Pairing code error:',
            err?.message || err
          );

          await ctx.reply(
            'Could not generate the pairing code. ' +
            'Check the Render logs before trying again.'
          );
        }
      }

      if (connection === 'open') {
        console.log('WhatsApp connected successfully:', phone);

        if (codeSent) {
          await ctx.reply(
            'WhatsApp linked successfully!'
          ).catch(() => {});
        }
      }

      if (connection === 'close') {
        console.error(
          'WhatsApp disconnected:',
          lastDisconnect?.error?.message || 'Unknown reason'
        );
      }
    });
  } catch (err) {
    console.error('Pairing setup failed:', err?.stack || err);

    await ctx.reply(
      'Pairing setup failed. Please check the Render logs.'
    ).catch(() => {});
  } finally {
    activeNumbers.delete(phone);
  }
});

bot.catch((err) => {
  console.error('Telegram bot error:', err?.stack || err);
});

(async () => {
  app.listen(PORT, () => {
    console.log(`Bappa X listening on port ${PORT}`);
  });

  await bot.launch();
  console.log('Telegram bot started');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
