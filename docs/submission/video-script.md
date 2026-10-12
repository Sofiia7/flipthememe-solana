# Demo video: shot list and voiceover

> Updated audio for APK 29 is in `media/voice/build29`: nine MP3s, matching SRT subtitles and `lines.json` with measured speech boundaries. Use these files when editing. The older files directly in `media/voice`, including its preview, contain outdated wording.

Target length 2:45-2:55 (both hackathons accept up to 3 minutes). English voiceover generated with edge-tts, captions burned in, assembled with ffmpeg.

## How to record (for Sofia)

- Seeker: pull down Quick Settings, **Screen record**, sound off (the voice is added later), "show touches" on if offered.
- Record each shot as a separate clip, portrait, 10-40 seconds. Retakes are cheap; keep the best.
- Before recording: Seed Vault Wallet switched to Devnet (with some devnet SOL, or empty if you want to show GET TEST SOL), the keeper running, the app freshly opened (the X lane shows posts a few seconds after start). For shot 8 grant the notification permission on the first bet and keep the phone locked for the end of the round once, so the notification shows on the lock screen. The second person for a two-player round can use Solflare on another phone.
- Send the clips to the laptop (USB or Google Drive) into `media/raw/` in the repository folder (git-ignored, not committed).

## Shots and voiceover

| # | Time | What is on screen | Voiceover |
|---|---|---|---|
| 1 | 0:00-0:14 | Arena opens: an X post slides into the lane at the top (MOON or SCAM), live chart, entry timer | This is FlipTheMeme. Every minute a new round opens on a busy memecoin whose PumpSwap pool is only minutes old. And crypto Twitter is already arguing about it, live, right on top. |
| 2 | 0:14-0:28 | Token header: pool age, liquidity, trades per 5 minutes; the price line moving; a tap opens DexScreener | The price is the token's price in SOL, read every second from its PumpSwap pool on mainnet. You call UP or DOWN without buying the token. A one-minute move, result in about two minutes. |
| 3 | 0:28-0:56 | Guest taps UP; the sheet names the original round, exact amount and session limits; one approval in Seed Vault Wallet (if the wallet is empty, show GET TEST SOL for two seconds first) | I tap UP. Mobile Wallet Adapter opens the Seeker's own Seed Vault Wallet once. One approval deposits test SOL into my in-app vault, opens a limited device session. The default is one hour and 0.02 SOL per call. My original call goes in only if that round is still open and the exact amount still fits. That key can only place bets; the program gives it no way to withdraw. |
| 4 | 0:56-1:10 | YOU'RE IN, the face joins the UP side, "N IN - X SOL" on the open round; then one more tap on the next round | From now on every call is one tap, with no wallet pop-up. My pixel face joins the UP side, and it travels inside the bet itself. |
| 5 | 1:10-1:28 | Entry closes, HOUSE appears on DOWN | Rounds are matched one to one. Only the amount both sides cover plays, and any surplus comes back without a fee. On devnet a house account can fill the short side, capped on chain per round and per day, so a solo player can still get a matched round. |
| 6 | 1:28-1:52 | Yellow "START PRICE IN 0:12" band, "LOCKING START", then the dashed start-price line: green above, red below, "+8.73%", "WINNING NOW" | The start price is not the price when I tapped. It is the average of ten seconds that start thirty seconds after entry closes, so it is still unknown when anyone taps. Then comes the one-minute move. Green above the line, red below. |
| 7 | 1:52-2:20 | Win celebration: coin logo, +0.42%, "3 IN A ROW", balance grows; SAME CALL button; History with start price and exit, Explorer link | A win pays 1.96 times the matched part of the stake. The attestor samples the pool and publishes one signed certificate for the window. The keeper relays that same certificate. Both services are currently run by our team. The program does the math on chain and credits my vault, the signed samples stay in the transaction. I see my matched stake, refund and net result, then the next round’s token before repeating. |
| 8 | 2:20-2:40 | "Challenge a friend": the card arrives in Telegram with its link; the link opens the round page, then the app; cut to the notification shade: "Round #123: did your UP call win?" | Then I challenge a friend. The card goes out with a link: the page asks them to take the other side, and with the app installed one tap opens the round. And if I leave the app, a notification brings me back when the round is over. |
| 9 | 2:40-2:52 | Closing card from the deck: program id, repository | FlipTheMeme. Built for Seeker, live on Solana devnet today. Pick a side. |

Shots 6 and 7 come from the same round: start recording before entry closes and keep going until the result (about two and a half minutes), then cut.

## Production

1. `edge-tts --voice en-US-AndrewNeural` (fallback `en-US-GuyNeural`), one MP3 per line, then measure durations.
2. Trim each clip to its line, add captions with the same text, 1080x1920 output, 30 fps.
3. Title and closing cards are rendered from the pitch deck slides.
4. Export `FlipTheMeme-demo.mp4`, under 100 MB, upload as an unlisted YouTube video or a Drive link for the forms.
