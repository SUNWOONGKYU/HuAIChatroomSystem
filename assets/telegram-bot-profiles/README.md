# Telegram bot profile colors

Use these profile pictures so Telegram shows stable role colors instead of random default initials.

| Bot | PNG preview | Bot API JPG | Color |
| --- | --- | --- | --- |
| LeaderBot | `leaderbot-deep-orange.png` | `leaderbot-deep-orange.jpg` | deep orange `#D9480F` |
| ClaudeBot | `claudebot-orange.png` | `claudebot-orange.jpg` | orange `#F59F00` |
| CodexBot | `codexbot-purple.png` | `codexbot-purple.jpg` | purple `#7C3AED` |
| AuditBot | `auditbot-gold.png` | `auditbot-gold.jpg` | gold `#F2C94C` |

Apply automatically with Telegram Bot API:

```powershell
npm run apply:telegram-bot-profiles
```

The script calls `setMyProfilePhoto` for all four role bots using `.env.operation.local`. It prints only role, username, and status; raw bot tokens are not printed.

Manual fallback: open `@BotFather`, run `/setuserpic`, select each bot, and upload the matching PNG file.
