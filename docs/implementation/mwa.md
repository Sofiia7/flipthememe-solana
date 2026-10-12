# Mobile Wallet Adapter: the chosen stack

We use `@wallet-ui/react-native-kit`, the package that is current for new React Native apps, together with `@solana/kit`, devnet and `MobileWalletProvider` in `apps/mobile/App.tsx`.

`apps/mobile/polyfill.js` is called before any Solana code is imported. This order is mandatory for `react-native-quick-crypto`.

MWA cannot be used with Expo Go: it needs Kotlin native modules and a custom Expo development build. After `pnpm install`, run:

```powershell
pnpm android
```

MWA identity: `https://flipthememe.com` and the relative `icon-512.png` (`APP_IDENTITY` in `apps/mobile/src/config.ts`). `favicon.ico` on the site returns HTML, so the icon is specified explicitly. Digital Asset Links for the signing key are published by `services/link` on `sol.flipthememe.com` (App Links for `/r/<round>` links); they were not verified for the identity domain `flipthememe.com`, and without domain verification a wallet is allowed to reject the authorization.

Verified on devnet: Seed Vault Wallet on Seeker (Settings, Network, Devnet), Solflare and Jupiter Mobile (on a second phone, October 12) sign; in our tests Phantom opened but did not return signatures through MWA.

Only owner operations are signed through MWA:

- **Top up & play** - one transaction: `open_vault` (on the first top-up), `deposit`, `start_session` (7 days, at most 0.1 SOL per bet, a turnover allowance 100 times the in-game balance: the program counts bets as a running total, so the limit bounds how often the key can bet, not the loss, since bets are drawn from the vault) and a transfer of 0.005 SOL to the device key when it has little SOL for network fees (position rent is taken from the in-game balance);
- `withdraw` and `revoke_session`.

The wallet only signs (`signTransactions`); on devnet the app sends the transaction. If the wallet rejects a cached authorization (expired or issued to a previous install), the app requests it again in a new MWA session.

`place_bet` is signed by the device key (ed25519, stored in `expo-secure-store`), with no wallet window. The instructions are built by `packages/client` on `@solana/kit` codecs, without an Anchor generator. The device key has no instruction to withdraw funds or change its own limits; the program checks its bets against the expiry, the per-bet limit and the session budget.
