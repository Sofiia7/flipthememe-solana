# Demo video: shot list and voiceover (build 41, 12 October 2026)

Target length 2:45-2:55 (the hackathon accepts up to 3 minutes). English voiceover generated with edge-tts, captions burned in, assembled with ffmpeg. Earlier audio in `media/voice/build29` matches most lines below; lines 3, 7 and 8 changed and are regenerated at edit time.

## How to record (for Sofia)

- Only on build 41 (the one that goes into the form). Two phones: a Seeker with Seed Vault Wallet and a second one with Jupiter Mobile, both on devnet.
- Seeker: quick settings shade, **Screen record**, sound off (the voice is added later), turn on "show touches" if available. Portrait orientation.
- Each shot is a separate clip of 10-40 seconds. Retakes are cheap, we keep the best one. Shots 5 to 7 come from one round: start recording before entry closes and do not stop until the result, about two and a half minutes.
- Before recording: reopen the app (the X feed appears after a few seconds), the in-game balance on the Seeker is at least 0.1 SOL, and the wallet on the second phone is empty so that GET TEST SOL is shown.
- Clips go in `C:\Server\memepred_solana\media\raw\` (the folder is not in git) or on Drive.

## Shots and voiceover

| # | Time | What is on screen | Voiceover |
|---|---|---|---|
| 1 | 0:00-0:14 | Arena opens: an X post slides into the lane at the top (MOON or SCAM), live chart, entry timer | This is FlipTheMeme. Every minute a new round opens on a busy memecoin whose PumpSwap pool is only hours old. And crypto Twitter is already arguing about it, live, right on top. |
| 2 | 0:14-0:28 | Token header: pool age, liquidity, trades per 5 minutes; the price line moving; a tap opens DexScreener | The price is the token's price in SOL, read every second from its PumpSwap pool on mainnet. You call UP or DOWN without buying the token. A one-minute move, result in about two minutes. |
| 3 | 0:28-0:56 | Second phone, empty wallet: tap UP, GET TEST SOL in the sheet (two seconds), one approval in Jupiter Mobile; back in the arena the call goes in by itself: BET ACCEPTED | I tap UP. Mobile Wallet Adapter opens my wallet once. One approval tops up my in-app vault and opens a limited device session: one hour and 0.02 SOL per call by default. The call I tapped goes in by itself, on the same coin. That key can only place bets; the program gives it no way to withdraw. |
| 4 | 0:56-1:10 | YOU'RE IN, the face joins the UP side, "1 IN" on the open round; then one more tap on the next round, no wallet | From now on every call is one tap, with no wallet pop-up. My pixel face joins the UP side, and it travels inside the bet itself. |
| 5 | 1:10-1:28 | Seeker takes DOWN in the same round: both faces, UP 0.02 and DOWN 0.02, no house; entry closes | Rounds are matched one to one between players. Only the amount both sides cover plays, and any surplus comes back without a fee. On devnet a house account can fill the short side, capped on chain per round and per day, so a solo player still gets a matched round. |
| 6 | 1:28-1:52 | "START PRICE IN 0:12" band, "START PRICE SOON", then the dashed start-price line: green above, red below, "+8.73%", "WINNING NOW" | The start price is not the price when I tapped. It is the average of ten seconds that start thirty seconds after entry closes, so it is still unknown when anyone taps. Then comes the one-minute move. Green above the line, red below. |
| 7 | 1:52-2:20 | Win celebration: coin logo, +0.42%, "2 IN A ROW", balance grows; SAME CALL button; History with start price and exit, Explorer link | A win pays 1.96 times the matched part of the stake. An attestor samples the pool and signs one price certificate per window; anyone can relay it, and the program checks the signature on chain. The attestor is run by our team for now. I see my matched stake, refund and net result, then the next round's coin before repeating. |
| 8 | 2:20-2:40 | "Challenge a friend": the card goes to Telegram; on the second phone the link opens the app with the pink card "OXBLA CALLED UP ON $COIN", one tap on DOWN; cut to the notification shade: "Round #123: did your UP call win?" | Then I challenge a friend. The link opens the app with my call on screen and one button for the other side. And if I leave the app, a notification brings me back when the round is over. |
| 9 | 2:40-2:52 | Closing card from the deck: program id, repository | FlipTheMeme. Built for Seeker, live on Solana devnet today. Pick a side. |

Shots 5 to 7 come from the same round: Seeker records from before entry closes until the result. Shot 3 and 8 are recorded on the second phone. If the coin changes while the wallet approves, the yellow card "THE COIN CHANGED WHILE YOU APPROVED" appears: keep it in, it is a feature, and tap its button.

## Production

1. `edge-tts --voice en-US-AndrewNeural` (fallback `en-US-GuyNeural`), one MP3 per line, then measure durations.
2. Trim each clip to its line, add captions with the same text, 1080x1920 output, 30 fps.
3. Title and closing cards are rendered from the pitch deck slides.
4. Export `FlipTheMeme-demo.mp4`, under 100 MB, upload as an unlisted YouTube video or a Drive link for the form.
