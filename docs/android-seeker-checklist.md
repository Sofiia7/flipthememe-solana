# Checking APK #41 on Seeker

APK: install page `https://sol.flipthememe.com/get`, version 0.1.0, versionCode 41, arm64.
SHA-256: `544c015fbdada21fc4dbb6c72338fa3c1c77e88180eaea0cc139d2ab2d47a5de`.
Use devnet and test SOL. ADB and a USB connection are not needed.

1. Open the app with no wallet connected: the token, direction, amount and result time are clear; the chart and timer are visible.
2. Tap UP or DOWN as a guest, check the amount and the session limits in the confirmation. Confirm in Seed Vault Wallet. The bet should appear by itself and exactly once. Repeat with a connected wallet and a zero balance (Wallet, Revoke all): this is a different button branch.
3. In the next round check one-tap entry. Delay the first wallet approval until the round closes: the bet should go into the next round of the same coin. If the coin has changed, a yellow card appears with a button for the new coin and NOT NOW; a bet on a different coin never happens on its own, and there is no silent return to the screen either.
4. After a confirmed bet, close the app and open it again. The active position should be restored. Check the chart of the selected position, the result, matching, refund and the final amount in History.
5. Turn off the internet while waiting for the result and bring it back. The data should recover without placing the bet again. The network error should be clear.
6. In Wallet check the available and locked amounts, withdraw the available amount, then Revoke all. After the revoke, a new bet should require a new session.
7. Open the invitation to a friend through the browser and the app: the right token/round, the pink card "X called UP" with a button for the opposite side (one tap, if the session is active), NOT NOW fits on a 360 dp screen, a repeated link shows the card again. Check the notification after leaving the app, if notifications are allowed.
8. Set the system font to 150% and turn on Reduce motion. Check Arena, the top-up form, the result and Wallet: the buttons are reachable, important text is not cut off, the pages scroll.

If something breaks, it is enough to write down the step, the error text, the approximate time and the round number. Do not send a seed phrase, private keys or RPC secrets. Full matrix: [android-acceptance.md](android-acceptance.md).

The server-side run of two operator wallets in round #6622 has already verified bets, settlement, the archive, withdrawal and closing of sessions. Round #8723 on October 12 was played by two people on two phones with no house bet. This does not replace this run of the mobile interface and MWA.
