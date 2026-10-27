import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

const PORT = Number(process.env.PORT || 3000);
const PAIRING_SECRET = process.env.PAIRING_SECRET || '';
const OWNER_NUMBERS = new Set(
  (process.env.OWNER_NUMBERS || '').split(',').map(x => x.replace(/\D/g, '')).filter(Boolean)
);
const SESSION_ROOT = path.resolve('sessions');
fs.mkdirSync(SESSION_ROOT, { recursive: true });

const sockets = new Map();
const starting = new Set();
const logger = pino({ level: 'silent' });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeId = value => String(value).replace(/\D/g, '').slice(0, 20);
const isGroup = jid => jid?.endsWith('@g.us');

app.get('/', (_req, res) => {
  res.type('text').send('𝐁𝐚𝐩𝐩𝐚 𝐗 is running. Keep pairing secret private.');
});
app.get('/health', (_req, res) => res.json({ ok: true, sessions: sockets.size }));

// Pairing endpoint. Protect this endpoint: never publish PAIRING_SECRET.
app.post('/pair', async (req, res) => {
  const supplied = String(req.get('x-pairing-secret') || req.body.secret || '');
  if (!PAIRING_SECRET || supplied !== PAIRING_SECRET) {
    return res.status(401).json({ error: 'Unauthorized. Set and provide the pairing secret.' });
  }
  const phone = safeId(req.body.phone);
  if (phone.length < 8) return res.status(400).json({ error: 'Send phone with country code, digits only.' });
  if (starting.has(phone) || sockets.has(phone)) {
    return res.status(409).json({ error: 'This number is already connected or starting.' });
  }

  starting.add(phone);
  try {
    const sessionDir = path.join(SESSION_ROOT, phone);
    fs.mkdirSync(sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });
    sockets.set(phone, sock);
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try { await handleMessage(phone, sock, msg); }
        catch (err) { console.error('Message handler error:', err?.message || err); }
      }
    });
    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') console.log(`Session connected: ${phone}`);
      if (connection === 'close') {
        sockets.delete(phone);
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          // Conservative reconnect: do not spin in a rapid loop.
          await sleep(5000);
          if (fs.existsSync(sessionDir)) startSavedSession(phone).catch(() => {});
        } else {
          console.log(`Session logged out: ${phone}. Re-pair it manually.`);
        }
      }
    });

    // Pairing code is requested only if credentials are not registered yet.
    if (!state.creds.registered) {
      await sleep(1500);
      const code = await sock.requestPairingCode(phone);
      return res.json({ phone, pairingCode: code, note: 'Enter this code in WhatsApp > Linked devices > Link with phone number.' });
    }
    return res.json({ phone, note: 'Saved session loaded. Check /health and server logs.' });
  } catch (err) {
    sockets.delete(phone);
    return res.status(500).json({ error: 'Could not start session. Check server logs and package compatibility.' });
  } finally {
    starting.delete(phone);
  }
});

async function startSavedSession(phone) {
  if (starting.has(phone) || sockets.has(phone)) return;
  starting.add(phone);
  try {
    const sessionDir = path.join(SESSION_ROOT, phone);
    if (!fs.existsSync(path.join(sessionDir, 'creds.json'))) return;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({
      auth: state, logger, printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false, syncFullHistory: false
    });
    sockets.set(phone, sock);
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async update => {
      if (update.connection === 'close') {
        sockets.delete(phone);
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          await sleep(5000);
          startSavedSession(phone).catch(() => {});
        }
      }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try { await handleMessage(phone, sock, msg); }
        catch (err) { console.error('Message handler error:', err?.message || err); }
      }
    });
  } finally {
    starting.delete(phone);
  }
}

// Attach message listeners to newly paired sessions too.
const originalPairRouteNote = true;
async function handleMessage(sessionOwner, sock, msg) {
  if (!msg.message || msg.key?.fromMe) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  const text = (msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    '').trim();
  if (!text.startsWith('.')) return;

  const [rawCommand, ...args] = text.slice(1).split(/\s+/);
  const command = (rawCommand || '').toLowerCase();
  const senderJid = msg.key.participant || msg.key.remoteJid;
  const senderNumber = safeId(senderJid.split('@')[0].split(':')[0]);
  const isOwner = OWNER_NUMBERS.has(senderNumber) || OWNER_NUMBERS.has(sessionOwner);
  const reply = body => sock.sendMessage(jid, { text: body }, { quoted: msg });

  const simple = {
    menu: '𝐁𝐚𝐩𝐩𝐚 𝐗 Commands\\n.info .ping .menu .help .owner .runtime .groupinfo .admins .members .rules\\n.tagall .hidetag .link .revoke .promote .demote .warn .warnings .clearwarn .antispam\\n.time .date .calc .echo .say .support .about .status',
    help: 'Use .menu to see available commands.',
    info: '𝐁𝐚𝐩𝐩𝐚 𝐗 — multi-session WhatsApp bot starter.',
    about: 'Built for personal/group utility. No ban-proof guarantee.',
    ping: 'Pong! 🏓',
    owner: 'Bot owner contact is configured by the deployment owner.',
    runtime: `Node.js ${process.version}`,
    date: new Date().toLocaleDateString('en-GB'),
    time: new Date().toLocaleTimeString('en-GB'),
    support: 'Contact the bot deployment owner for help.',
    status: 'Bot session is processing messages.',
    rules: 'Group rules: be respectful, avoid spam, and follow group admin instructions.',
    antispam: 'Anti-spam guidance: avoid repeated messages, unsolicited bulk messaging, and command flooding.'
  };
  if (command in simple) return reply(simple[command]);

  if (command === 'echo' || command === 'say') {
    const content = args.join(' ').slice(0, 500);
    return reply(content || 'Usage: .echo your text');
  }
  if (command === 'calc') {
    const expr = args.join('').slice(0, 80);
    if (!/^[\d+\-*/().% ]+$/.test(expr)) return reply('Usage: .calc 2+2 (numbers and basic operators only)');
    try {
      // Deliberately support arithmetic only; no eval.
      const tokens = expr.match(/\d+(?:\.\d+)?|[()+\-*/%]/g) || [];
      if (tokens.join('') !== expr.replace(/\s/g, '')) return reply('Invalid expression.');
      const result = arithmetic(tokens);
      return reply(`Result: ${result}`);
    } catch { return reply('Invalid calculation.'); }
  }
  if (!isGroup(jid)) {
    if (['groupinfo','admins','members','tagall','hidetag','link','revoke','promote','demote','warn','warnings','clearwarn'].includes(command)) {
      return reply('This command works in groups only.');
    }
  }
  if (command === 'groupinfo') {
    const m = await sock.groupMetadata(jid);
    return reply(`Group: ${m.subject}\\nMembers: ${m.participants.length}\\nOwner: ${m.owner || 'Unknown'}`);
  }
  if (command === 'admins') {
    const m = await sock.groupMetadata(jid);
    return reply('Admins:\\n' + m.participants.filter(p => p.admin).map(p => '@' + p.id.split('@')[0]).join('\\n'));
  }
  if (command === 'members') {
    const m = await sock.groupMetadata(jid);
    return reply(`Members: ${m.participants.length}`);
  }
  if (command === 'tagall' || command === 'hidetag') {
    const m = await sock.groupMetadata(jid);
    const mentions = m.participants.map(p => p.id);
    const body = command === 'tagall'
      ? `Attention everyone!\\n${mentions.map(id => '@' + id.split('@')[0]).join(' ')}`
      : (args.join(' ') || 'Notice');
    return sock.sendMessage(jid, { text: body, mentions });
  }
  if (command === 'link') {
    const code = await sock.groupInviteCode(jid);
    return reply(`Group invite link: https://chat.whatsapp.com/${code}`);
  }
  if (command === 'revoke') {
    const m = await sock.groupMetadata(jid);
    if (!m.participants.some(p => p.id === sock.user.id && p.admin)) return reply('Bot must be a group admin.');
    const code = await sock.groupRevokeInvite(jid);
    return reply('Group invite link has been reset.');
  }
  if (command === 'promote' || command === 'demote') {
    const m = await sock.groupMetadata(jid);
    if (!m.participants.some(p => p.id === sock.user.id && p.admin)) return reply('Bot must be a group admin.');
    if (!isOwner && !m.participants.some(p => p.id === senderJid && p.admin)) return reply('Only the configured owner or a group admin can use this command.');
    const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!target) return reply(`Tag a member: .${command} @user`);
    await sock.groupParticipantsUpdate(jid, [target], command);
    return reply(`Requested ${command} action for @${target.split('@')[0]}.`);
  }
  if (['warn','warnings','clearwarn'].includes(command)) {
    return reply('Warning storage is not enabled in this starter yet.');
  }
  if (command === 'calc') return reply('Usage: .calc 2+2');
  if (command === 'clear') return reply('This starter does not delete chat history.');
  if (command === 'tagall' && args.length > 0) return reply('Use .tagall');
  return reply('Unknown command. Use .menu');
}

// Safe arithmetic parser using recursive descent.
function arithmetic(tokens) {
  let i = 0;
  function factor() {
    const t = tokens[i++];
    if (t === '(') { const v = expr(); if (tokens[i++] !== ')') throw Error(); return v; }
    if (t === '+') return factor();
    if (t === '-') return -factor();
    const n = Number(t); if (!Number.isFinite(n)) throw Error(); return n;
  }
  function term() {
    let v = factor();
    while (['*','/','%'].includes(tokens[i])) {
      const op = tokens[i++], n = factor();
      if ((op === '/' || op === '%') && n === 0) throw Error();
      v = op === '*' ? v*n : op === '/' ? v/n : v%n;
    }
    return v;
  }
  function expr() {
    let v = term();
    while (['+','-'].includes(tokens[i])) {
      const op = tokens[i++], n = term(); v = op === '+' ? v+n : v-n;
    }
    return v;
  }
  const value = expr();
  if (i !== tokens.length || !Number.isFinite(value)) throw Error();
  return value;
}

// Load previously saved sessions on startup. Use persistent disk for reliability.
for (const phone of fs.readdirSync(SESSION_ROOT)) {
  if (/^\d{8,20}$/.test(phone)) startSavedSession(phone).catch(err => console.error(err));
}

app.listen(PORT, () => console.log(`𝐁𝐚𝐩𝐩𝐚 𝐗 listening on ${PORT}`));
