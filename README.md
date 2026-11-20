# Switcher Remote

Every Claude session on all your PCs, on all your accounts, in one browser window. It's the web app for [Claude Account Switcher](https://github.com/charles00ds/claude-account-switcher)'s vault: sign in with your vault username and password, and see what each PC's VS Code is running, live.

- **Watch** every session's transcript live, with each account's usage.
- **Reply** to a session: on a PC with `claudeSwitcher.remoteReplies` on, flip the session's **Remote** switch. Your reply goes in as your own prompt once Claude is idle.
- **Answer Claude's prompts** in Remote sessions: allow or deny a tool, answer a question, approve a plan.
- **Run the session**: change its model, effort and permission mode, see its subagents and context, **Compact now**, run its slash commands, or move it to another account.
- **Send images** with a reply: paste, drop or attach up to 4.
- **Stop** a Remote session mid-turn.
- **Get notified** when Claude is waiting on you (the bell), even with the app closed. Install it from the browser (on iPhone: Share, then Add to Home Screen) for an app of its own.
- **Unlock with a passkey** on a device you choose to remember.
- **Start a session**: pick a PC, a long-lived-token account and one of the folders that PC allows (`claudeSwitcher.remoteRepos`), and write the first message.

## How it works

- Each PC's VS Code (with `claudeSwitcher.remoteSessions` turned on) keeps a stream open to the vault server's relay. While a browser is watching, it publishes the PC's accounts, their usage and its open sessions, and streams the transcript of the session you open.
- **End-to-end encrypted.** This app derives your vault keys in the browser, exactly as the extension does (scrypt, then HKDF-SHA256), and decrypts everything here with AES-256-GCM. The vault server only passes ciphertext along. Each message is bound to its purpose and its PC, so the server can't redirect or replay one as another.
- The keys live only in this tab's memory. Closing or reloading it means unlocking again; only your username is remembered.

## Development

```sh
npm ci
npm test          # crypto checked against vectors made by the extension
npm run dev       # proxies /api to a vault on 127.0.0.1:8787, or VAULT_URL
npm run build     # dist/, served by the vault server from its releases folder
```

To publish: `powershell -File scripts\publish.ps1` (builds, tests and uploads to the vault server over `ssh biloy`; no sudo).

`src/test/vectors.json` is made by the extension's `src/vault.ts`; regenerate it there rather than editing it. `src/types.ts` mirrors the extension's `src/relay.ts` and `src/transcript.ts`: only add fields, so an older extension and a newer web app (or the other way round) still understand each other.

| File | |
|---|---|
| `src/crypto.ts` | key derivation and the vault's blob format |
| `src/remote.ts` | signing in, the relay stream, watching a session |
| `src/main.ts`, `src/styles.css`, `index.html` | the interface |
| `design/mock.html` | the clickable design mock, with the parts that come next |
