# 𝐁𝐚𝐩𝐩𝐚 𝐗 — WhatsApp bot starter

## What this is
A fresh Node.js starter using the unofficial Baileys WhatsApp Web protocol. It includes a pairing-code endpoint, separate session folders, basic reconnect logic, and group utility commands. It is not an official WhatsApp API client and cannot guarantee that an account will never be restricted.

## Requirements
- Node.js 20+
- A persistent disk for `sessions/` if you want sessions to survive restarts/redeploys
- A private `PAIRING_SECRET`

## Run locally
1. Copy `.env.example` to `.env`.
2. Set a long random `PAIRING_SECRET`.
3. Set `OWNER_NUMBERS` to your own number(s), digits only with country code.
4. Run `npm install`
5. Run `npm start`

## Pair a number
POST to `/pair` with JSON:
`{"phone":"8801XXXXXXXXX"}`

Include HTTP header `x-pairing-secret: YOUR_SECRET`.
The response returns a pairing code. On that phone, open WhatsApp > Linked devices > Link with phone number and enter the code.

Never share the pairing code, session directory, or pairing secret. Only connect accounts you own or are authorized to administer.

## Hosting notes
The free tier of many hosts may sleep, restart, or have ephemeral filesystems. If the `sessions/` folder is lost, you may need to pair again. Do not put session files in a public repository. Add environment variables through the host dashboard, not in source code.

## Starter commands
.menu, .help, .info, .about, .ping, .owner, .runtime, .date, .time, .support, .status, .rules, .antispam, .echo, .say, .calc, .groupinfo, .admins, .members, .tagall, .hidetag, .link, .revoke, .promote, .demote

Some commands require the bot account to be a group admin. Use tagging for `.promote @user` and `.demote @user`. Commands that send a lot of notifications (such as `.tagall`) should be used only with group consent.

## Security / limitations
- No software can make unofficial automation 100% ban-proof.
- Avoid bulk messaging, unsolicited messages, spam, and attempts to bypass platform limits.
- This starter is for testing and learning. Add rate limits, secure session storage, audit logs, and stronger authorization before exposing it publicly.
- Multi-user sessions need persistent storage and careful isolation. Free hosting is not guaranteed to be reliable.
