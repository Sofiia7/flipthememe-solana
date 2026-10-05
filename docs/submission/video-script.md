# Demo video: shot list and voiceover

Target length 2:45-2:55 (both hackathons accept up to 3 minutes). English voiceover generated with edge-tts, captions burned in, assembled with ffmpeg.

## How to record (for Sofia)

- Seeker: pull down Quick Settings, **Screen record**, sound off (the voice is added later), "show touches" on if offered.
- Record each shot as a separate clip, portrait, 10-40 seconds. Retakes are cheap; keep the best.
- Before recording: wallet switched to devnet with some devnet SOL, the keeper running, the app freshly opened.
- Send the clips to the laptop (USB or Google Drive) into `C:\Server\memepred_solana\media\raw\` (not committed).

## Shots and voiceover

| # | Time | What is on screen | Voiceover |
|---|---|---|---|
| 1 | 0:00-0:12 | App opens on Arena: live chart, "ENTRY CLOSES IN" timer | This is FlipTheMeme. Every minute there is a new round on the hottest fresh memecoin on Solana. You call UP or DOWN, and you never buy the token. |
| 2 | 0:12-0:28 | Token header (name, age, liquidity), price line moving | The price comes straight from the token's PumpSwap pool on mainnet, read every second. Everyone in the round sees the same chart and the same strike. |
| 3 | 0:28-0:55 | Wallet tab: Connect, MWA sheet, "Top up & play", one approval | Connecting uses Mobile Wallet Adapter. One approval deposits test SOL into my in-app vault, opens a 24 hour session with a budget and funds a small device key. That key can place bets, but it can never withdraw. |
| 4 | 0:55-1:12 | Pick 0.02 SOL, tap UP, the face appears in the UP group | From now on every call is one tap, with no wallet pop-up. My pixel face joins the UP side, and it travels inside the bet itself. |
| 5 | 1:12-1:32 | Entry closes, HOUSE appears on DOWN | Rounds are matched one to one. Only the amount both sides cover plays, and any surplus comes back without a fee. On devnet a house account fills the short side within a daily budget, so even a solo player gets a real round. |
| 6 | 1:32-2:02 | "RESULT IN" timer, strike line on the chart, "winning now" | The strike is not the price when I tapped. It is the average over ten seconds that start thirty seconds after entry closes, so nobody can bet on a price they already see. Then the market has sixty seconds to move. |
| 7 | 2:02-2:25 | Result toast, balance grows, History with strike and exit, Explorer link | A win pays exactly 1.96 times the stake that played. The program settles the round, the keeper credits my vault, and every price observation is stored in the settlement transaction, so anyone can check it. |
| 8 | 2:25-2:38 | Profile: face editor; Share "challenge a friend" | Make your face, then challenge a friend to take the other side with one share. |
| 9 | 2:38-2:50 | Closing card from the deck: program id, repository | FlipTheMeme. Built for Seeker, running on Solana devnet today. Pick a side. |

## Production

1. `edge-tts --voice en-US-AndrewNeural` (fallback `en-US-GuyNeural`), one MP3 per line, then measure durations.
2. Trim each clip to its line, add captions with the same text, 1080x1920 output, 30 fps.
3. Title and closing cards are rendered from the pitch deck slides.
4. Export `FlipTheMeme-demo.mp4`, under 100 MB, upload as an unlisted YouTube video or a Drive link for the forms.
