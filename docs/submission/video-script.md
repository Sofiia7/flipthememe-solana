# Demo video: shot list and voiceover

Target length 2:45-2:55 (both hackathons accept up to 3 minutes). English voiceover generated with edge-tts, captions burned in, assembled with ffmpeg.

## How to record (for Sofia)

- Seeker: pull down Quick Settings, **Screen record**, sound off (the voice is added later), "show touches" on if offered.
- Record each shot as a separate clip, portrait, 10-40 seconds. Retakes are cheap; keep the best.
- Before recording: Seed Vault Wallet switched to Devnet with some devnet SOL, the keeper running, the app freshly opened (the X lane shows posts a few seconds after start).
- Send the clips to the laptop (USB or Google Drive) into `C:\Server\memepred_solana\media\raw\` (not committed).

## Shots and voiceover

| # | Time | What is on screen | Voiceover |
|---|---|---|---|
| 1 | 0:00-0:14 | Arena opens: an X post slides into the lane at the top (MOON or SCAM), live chart, entry timer | This is FlipTheMeme. Every minute a new round opens on a busy memecoin whose PumpSwap pool is only minutes old. And crypto Twitter is already arguing about it, live, right on top. |
| 2 | 0:14-0:28 | Token header: pool age, liquidity, trades per 5 minutes; the price line moving; a tap opens DexScreener | The price is the token's price in SOL, read every second from its PumpSwap pool on mainnet. You call UP or DOWN without buying the token. |
| 3 | 0:28-0:52 | Wallet: Connect with Seed Vault Wallet, "Top up & play", one approval | Connecting uses Mobile Wallet Adapter with the Seeker's own Seed Vault Wallet. One approval deposits test SOL into my in-app vault and opens a 24 hour session for a small device key. That key can place bets within its budget; the program gives it no way to withdraw. |
| 4 | 0:52-1:08 | Pick 0.02 SOL, tap UP, the face joins the UP side | From now on every call is one tap, with no wallet pop-up. My pixel face joins the UP side, and it travels inside the bet itself. |
| 5 | 1:08-1:28 | Entry closes, HOUSE appears on DOWN | Rounds are matched one to one. Only the amount both sides cover plays, and any surplus comes back without a fee. On devnet a house account can fill the short side, capped on chain per round and per day, so a solo player can still get a matched round. |
| 6 | 1:28-1:58 | Yellow "STRIKE IN" band, "FIXING STRIKE", then the dashed strike line: green above, red below, "+8.73%", "WINNING NOW" | The strike is not the price when I tapped. It is the average of ten seconds that start thirty seconds after entry closes, so it is still unknown when anyone taps. Then comes the sixty-second move. Green above the line, red below. |
| 7 | 1:58-2:20 | Win celebration, balance grows, History with strike and exit, Explorer link | A win pays 1.96 times the matched part of the stake. Every price needs two signatures: the keeper's, and an independent attestor's that samples the pool on its own. The program does the math on chain and credits my vault, and every sample stays in the transaction. |
| 8 | 2:20-2:40 | "Challenge a friend": the card arrives in Telegram with its link; the link opens the round page, then the app | Then I challenge a friend. The card goes out with a link: the page asks them to take the other side, and with the app installed one tap opens the round. |
| 9 | 2:40-2:52 | Closing card from the deck: program id, repository | FlipTheMeme. Built for Seeker, live on Solana devnet today. Pick a side. |

Shots 6 and 7 come from the same round: start recording before entry closes and keep going until the result (about two and a half minutes), then cut.

## Production

1. `edge-tts --voice en-US-AndrewNeural` (fallback `en-US-GuyNeural`), one MP3 per line, then measure durations.
2. Trim each clip to its line, add captions with the same text, 1080x1920 output, 30 fps.
3. Title and closing cards are rendered from the pitch deck slides.
4. Export `FlipTheMeme-demo.mp4`, under 100 MB, upload as an unlisted YouTube video or a Drive link for the forms.
