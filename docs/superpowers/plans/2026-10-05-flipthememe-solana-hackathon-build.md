# FlipTheMeme Solana: план сборки к 9 октября

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** рабочий APK на Seeker с MWA, программа банка 1:1 в devnet без блокировок, keeper на настоящей цене PumpSwap, видео и презентация к 8 октября.

**Architecture:** Anchor-программа держит все деньги и правила; keeper (Node) создаёт раунд каждую минуту, добирает сторону домом и подписывает цены из mainnet-пула; приложение (Expo) читает devnet и mainnet напрямую, ставит ключом сессии. Общий TS-клиент `packages/client` используют keeper, приложение и сверочные тесты.

**Tech Stack:** Rust + anchor-lang 1.1.2, Agave CLI 3.1.x (Windows), litesvm (Rust, тесты), TypeScript + @solana/kit 7, Node 22, Expo 57 / React Native 0.86, @wallet-ui/react-native-kit 4.3 (MWA), GitHub Actions (APK), edge-tts + ffmpeg (видео).

**Спецификация:** [2026-10-05-flipthememe-solana-hackathon-build-design.md](../specs/2026-10-05-flipthememe-solana-hackathon-build-design.md).

**Отступление от формата скилла:** из-за срока план фиксирует интерфейсы, файлы, команды и критерии приёмки, но не дублирует весь код: код пишется один раз в задаче. Интерфейсы ниже обязательны для всех исполнителей.

---

## Общие правила для исполнителей

- Не коммитить: коммиты делает координатор после проверки. Не запускать `pnpm install` без координатора (один lockfile, Windows).
- Никаких длинных тире (U+2014) и en dash (U+2013) ни в коде, ни в текстах. Только `-`.
- Секреты (keypair, keystore, пароли) только вне репозитория: `C:\Users\sofia\.flipthememe\`.
- Для VPS openclaw - только `bash /c/Server/twitter_hermes/tools/vps.sh`, один заход за раз, и только по команде координатора.

## Карта файлов

```
programs/flip-the-meme/src/lib.rs        программа: аккаунты, инструкции, события, ошибки
programs/flip-the-meme/src/payout.rs     чистая математика выплаты (unit-тесты)
programs/flip-the-meme/tests/flow.rs     litesvm: сценарии раундов
programs/flip-the-meme/tests/vectors.rs  печать эталонных байт для TS-клиента
packages/client/src/constants.ts         program id, seeds, параметры, mainnet-адреса
packages/client/src/pda.ts               findConfig/Vault/Session/Round/PositionPda
packages/client/src/accounts.ts          декодеры Config/Vault/Session/Round/Position
packages/client/src/instructions.ts      сборщики всех инструкций
packages/client/src/payout.ts            зеркало payout.rs + превью для UI
packages/client/src/pumpswap.ts          чтение пула PumpSwap, цена, выбор пула
packages/client/src/index.ts             реэкспорт
packages/client/test/*.test.ts           эталоны против Rust, математика, pumpswap
services/keeper/src/*.ts                 keeper (раздел C)
apps/mobile/...                          приложение (раздел D)
.github/workflows/android.yml            сборка APK
```

## Контракт программы (источник истины для клиента)

Seeds: `config` = [`config`]; `vault` = [`vault`, authority]; `session` = [`session`, vault, signer];
`round` = [`round`, id u64 LE]; `position` = [`position`, round, authority].
Дискриминаторы Anchor: инструкция `sha256("global:<snake_name>")[..8]`, аккаунт `sha256("account:<Name>")[..8]`.
Enum в Borsh - один байт: `Side {Up, Down}`, `RoundStatus {Open, Live, Final}`,
`Outcome {Pending, Up, Down, Refund, NotActivated}`, `RefundReason {None, Tie, Unpriceable, Expired}`.

```rust
pub struct Config { admin: Pubkey, price_authority: Pubkey, house_authority: Pubkey, treasury: Pubkey,
  paused: bool, next_round_id: u64, min_stake: u64, max_stake: u64, min_bank: u64,
  fee_win_bps: u16, fee_refund_bps: u16, total_available: u64, total_locked: u64, bump: u8 }
pub struct Vault { authority: Pubkey, available: u64, locked: u64, bump: u8 }
pub struct Session { authority: Pubkey, vault: Pubkey, signer: Pubkey, expiry: i64, max_per_bet: u64,
  session_cap: u64, spent: u64, revoked: bool, bump: u8 }
pub struct Round { id: u64, token_mint: Pubkey, pool: Pubkey, opens_at: i64, cutoff_at: i64,
  strike_start: i64, strike_end: i64, exit_start: i64, exit_end: i64, settle_deadline: i64,
  min_stake: u64, max_stake: u64, min_bank: u64, max_bank: u64, fee_win_bps: u16, fee_refund_bps: u16,
  raw_up: u64, raw_down: u64, house_amount: u64, position_count: u32, claimed_count: u32,
  total_paid: u64, fees_swept: bool, status: RoundStatus, outcome: Outcome, refund_reason: RefundReason,
  strike_price: u64, exit_price: u64, strike_samples: u8, exit_samples: u8, bump: u8 }
pub struct Position { round: Pubkey, authority: Pubkey, side: Side, stake: u64, face: [u8; 8],
  is_house: bool, claimed: bool, payout: u64, bump: u8 }
pub struct PriceSample { slot: u64, price: u64 }
pub struct ConfigParams { price_authority: Pubkey, house_authority: Pubkey, treasury: Pubkey,
  min_stake: u64, max_stake: u64, min_bank: u64, fee_win_bps: u16, fee_refund_bps: u16 }
pub struct CreateRoundArgs { token_mint: Pubkey, pool: Pubkey, opens_at: i64, cutoff_at: i64,
  strike_start: i64, strike_end: i64, exit_start: i64, exit_end: i64, settle_deadline: i64, max_bank: u64 }
```

Инструкции и порядок аккаунтов (`w` - writable, `s` - signer):

| Инструкция | Аргументы | Аккаунты |
|---|---|---|
| `initialize_config` | `params: ConfigParams` | config w, admin ws, system_program |
| `update_config` | `params: ConfigParams` | config w, admin s |
| `set_pause` | `paused: bool` | config w, admin s |
| `open_vault` | - | config, vault w, authority ws, system_program |
| `deposit` | `amount: u64` | config w, vault w, authority ws, system_program |
| `withdraw` | `amount: u64` | config w, vault w, authority ws |
| `start_session` | `expiry: i64, max_per_bet: u64, session_cap: u64` | config, vault, session w, authority ws, session_signer, system_program |
| `revoke_session` | - | vault, session w, authority s |
| `create_round` | `round_id: u64, args: CreateRoundArgs` | config w, round w, admin ws, system_program |
| `place_bet` | `side: Side, amount: u64, face: [u8; 8]` | config w, round w, vault w, session w, position w, session_signer ws, system_program |
| `house_fill` | `amount: u64` | config w, round w, house_vault w, position w, house_authority ws, system_program |
| `set_strike` | `samples: Vec<PriceSample>` | config, round w, price_authority s |
| `settle` | `samples: Vec<PriceSample>` | config, round w, price_authority s |
| `refund_expired` | - | round w |
| `claim` | - | config w, round w, position w, vault w |
| `sweep_fees` | - | config w, round w, treasury w |
| `close_empty_round` | - | config, round w, admin w |

Выплата позиции - раздел 3 спецификации; `payout.rs` и `payout.ts` обязаны совпадать на общих векторах.

---

## Трек A. Программа

### A0. Тулчейн Solana на Windows
- [ ] Скачать `solana-release-x86_64-pc-windows-msvc.tar.bz2` (Agave 3.1.x, последний патч с Windows-сборкой) из GitHub `anza-xyz/agave`, распаковать в `C:\Users\sofia\.local\agave\`, добавить `bin` в PATH сессии.
- [ ] `solana --version`, `cargo-build-sbf --version`.
- [ ] `cargo build-sbf --manifest-path programs/flip-the-meme/Cargo.toml` на текущем черновике. Ожидание: `target/deploy/flip_the_meme.so`.
- [ ] Если сборка под Windows не идёт за 40 минут: собирать `.so` в GitHub Actions (ubuntu, `agave-install`), скачивать артефакт `gh run download`.
- [ ] Ключи: `solana-keygen new --no-bip39-passphrase -o C:\Users\sofia\.flipthememe\keeper.json` и `...\program-id.json`. Airdrop devnet на keeper: `solana airdrop 2 -u devnet` (повторить до 6 SOL; при 429 - попросить Софию пополнить через faucet.solana.com).

### A1. Переписать программу по контракту
- [ ] `payout.rs`: `pub fn position_payout(raw_up, raw_down, outcome, fee_win_bps, fee_refund_bps, side, stake) -> Option<u64>` и `pub fn is_activated(raw_up, raw_down, min_bank) -> bool`, u128 внутри.
- [ ] Unit-тесты `payout.rs` (`cargo test -p flip-the-meme --lib`): равные стороны 1.96x; книга 0.40/0.10 (излишек 0.30 возвращается); проигрыш с излишком; возврат 1% активированного; неактивированный целиком; сумма выплат по раунду не больше банка на 1000 случайных книг.
- [ ] `lib.rs` по таблице инструкций, `declare_id!` из `program-id.json`, `Anchor.toml` с тем же id.
- [ ] `cargo check` и `cargo build-sbf` без предупреждений об ошибках.

### A2. Интеграционные тесты litesvm
- [ ] `programs/flip-the-meme/tests/flow.rs`, dev-dependency `litesvm` (версия, совместимая по сборке; при конфликте типов - конвертер Pubkey/Instruction через байты).
- [ ] Сценарии: полный раунд UP с неравной книгой и излишком; дом выравнивает одиночную ставку и раунд играет; неактивированный; ничья; меньше 5 наблюдений; истёкший срок через `refund_expired`; повторный claim и settle отклонены; ставка ровно в `cutoff_at` отклонена; ставка после `expiry` сессии отклонена; лимит сессии; правило глубины; withdraw больше available отклонён; sweep до последнего claim отклонён, после - treasury получает `U + D - total_paid`; закрытие пустого раунда; чужой signer для admin, price_authority, house_authority, session.
- [ ] Команда: `cargo test --manifest-path programs/flip-the-meme/Cargo.toml` - все зелёные.

### A3. Эталоны для клиента
- [ ] `tests/vectors.rs` пишет `packages/client/test/vectors.json`: байты данных каждой инструкции на фиксированных аргументах, байты сериализованных аккаунтов, выплаты на 50 книгах.

### A4. Деплой devnet
- [ ] `solana program deploy target/deploy/flip_the_meme.so --program-id program-id.json -u devnet -k keeper.json`.
- [ ] Скрипт `services/keeper/scripts/init-config.ts`: `initialize_config` с параметрами devnet (min_stake 0.01, max_stake 0.1, min_bank 0.02 SOL, 200/100 bps), `open_vault` + `deposit 3 SOL` для дома.
- [ ] Записать program id и адреса в `docs/implementation/deployments.md`.

## Трек B. Клиент `packages/client`

- [ ] B1. `package.json` (`@flipthememe/client`, `type: module`, `@solana/kit` ^7.1.1, тесты `node --test` через `tsx` или `--experimental-strip-types`).
- [ ] B2. `constants.ts`, `pda.ts`, `accounts.ts` (декодеры с проверкой дискриминатора), `instructions.ts` (по одному сборщику на инструкцию, возвращают `Instruction` kit).
- [ ] B3. `payout.ts`: зеркало `payout.rs` на bigint + `previewBet(round, side, stake)` для UI (что будет принято и сколько выйдет при победе, если книга не изменится).
- [ ] B4. `pumpswap.ts`: `readPool(rpc, pool)` -> `{ baseMint, quoteMint, baseVault, quoteVault }` (проверка owner и quote = wSOL), `readPrice(rpc, vaults)` -> `{ slot, price, quoteReserve }`, `priceOf(base, quote) = quote * 10^12 / base`; `discoverPools(fetch)` - GeckoTerminal, фильтры спецификации.
- [ ] B5. Тесты: эталоны `vectors.json` побайтно; payout против векторов; `priceOf` на числах пула HIGGS из замера 5.10.

## Трек C. Keeper `services/keeper`

- [ ] C1. Конфиг из env: `DEVNET_RPC`, `MAINNET_RPCS` (список), `KEEPER_KEYPAIR`, `STATE_FILE`, `HOUSE_DAILY_BUDGET`, `HOUSE_ROUND_CAP`.
- [ ] C2. `selector.ts`: выбор пула раз в 60 с, удержание 15 минут, проверка на цепочке.
- [ ] C3. `sampler.ts`: опрос токен-счетов раз в 1 с, кольцо наблюдений на пул, выборка окна `[start, end)` по времени сервера; лог отставания часов devnet.
- [ ] C4. `scheduler.ts`: на каждом тике для раундов `next_round_id - 3 .. next_round_id` выполнить первый невыполненный шаг: create (за 10 с до minute boundary), house_fill (cutoff + 2 с), set_strike (strike_end + 1 с), settle (exit_end + 1 с), claim пачками по 6, sweep, close_empty. Каждый шаг идемпотентен по состоянию аккаунта, ошибки не роняют цикл.
- [ ] C5. `house.ts`: сумма заполнения `min(разница, кап раунда, max_bank/2 - меньшая сторона, остаток бюджета)`; бюджет по суткам UTC в файле состояния.
- [ ] C6. Восстановление при старте и `refund_expired` для просроченных.
- [ ] C7. Прогон на ноутбуке 30 минут против devnet: раунды каждую минуту, пустые закрываются, лог без исключений.
- [ ] C8. Сборка в один файл (esbuild), `Dockerfile`, `docker-compose.yml` (volume для состояния и ключа). Деплой на VPS одним `vps.sh push` после согласия Софии.

## Трек D. Приложение `apps/mobile`

- [ ] D1. Зависимости (через координатора): `@solana/kit@^7.1.1`, `expo-secure-store`, `react-native-svg`, `@react-native-async-storage/async-storage`, `expo-linking`, `@flipthememe/client`. `app.json`: имя, иконка, `scheme: flipthememe`, identity MWA `https://flipthememe.com`.
- [ ] D2. `src/chain/`: `useArena()` (Config, раунды, позиции, опрос 2 с), `useMyAccount()` (Vault, Session, мои позиции), `usePoolPrice(pool)` (mainnet, 1.5 с, кольцо 10 минут), `useTokenInfo(mint)`.
- [ ] D3. `src/wallet/`: `topUpAndPlay(amount)`, `withdraw(amount)`, `revokeSession()`, `airdrop()`; MWA `signTransactions`, отправка в devnet, ожидание подтверждения.
- [ ] D4. `src/session/`: ключ сессии в secure-store, `placeBet(round, side, amount, face)`, `claim(position)`; защита от двойного тапа, восстановление ожидающей ставки после перезапуска по PDA позиции.
- [ ] D5. Arena: график (svg), таймер с подписью фазы, группы UP/DOWN с лицами, превью 1.96x, выбор суммы, мои раунды в полёте, тост результата.
- [ ] D6. Wallet, History, Profile (редактор лица), нижняя навигация.
- [ ] D7. Share: вызов на другую сторону и карточка результата.
- [ ] D8. Состояния ошибок и офлайна из спецификации; `tsc --noEmit` зелёный.
- [ ] D9. Иконка и сплэш из пиксельного лица (PIL), 1024x1024.

## Трек E. Сборка и репозиторий

- [ ] E1. `.gitattributes` (`* text=auto eol=lf`), приватный репозиторий `Sofiia7/flipthememe-solana`, первый push.
- [ ] E2. Ключ подписи (PKCS12) в `C:\Users\sofia\.flipthememe\release.p12` + пароль в `release.txt`; секреты GitHub `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`.
- [ ] E3. `.github/workflows/android.yml`: pnpm, `expo prebuild --platform android`, подпись через config-плагин `apps/mobile/plugins/withReleaseSigning.js`, `assembleRelease`, артефакт `FlipTheMeme-<version>.apk`.
- [ ] E4. Первая сборка текущего каркаса - проверить, что нативная часть (MWA, quick-crypto, nitro) собирается, до готовности фич.

## Трек F. Материалы

- [ ] F1. README для судей (английский): что это, как играть на Seeker в devnet, правила банка 1:1, источник цены и граница доверия, program id, сборка, тесты, ограничения.
- [ ] F2. Сценарий видео и список кадров для Софии; озвучка edge-tts; монтаж ffmpeg; до 3 минут.
- [ ] F3. Презентация 10-12 слайдов (Artifact slides), экспорт PDF.
- [ ] F4. Тексты заявок CLOCK IN и Perps and Prediction Markets.

## Порядок и параллельность

| Когда | Координатор | Исполнители параллельно |
|---|---|---|
| 5.10 день | A1 программа | A0 тулчейн; E1-E4 репозиторий и APK каркаса; B4 pumpswap |
| 5.10 вечер | A2-A3 тесты, A4 деплой | B1-B3, B5 клиент |
| 6.10 | приёмка, интеграция | C keeper (прогон на ноутбуке); D1-D5 приложение |
| 7.10 | тест на Seeker с Софией | D6-D9; C8 деплой VPS; F1, F3 |
| 8.10 | съёмка с Софией, монтаж | F2, F4; финальный APK; репозиторий публичный с согласия Софии |
