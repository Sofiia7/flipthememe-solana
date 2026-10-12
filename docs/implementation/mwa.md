# Mobile Wallet Adapter: выбранная связка

Используется текущий для новых React Native приложений пакет `@wallet-ui/react-native-kit` с `@solana/kit`, devnet и `MobileWalletProvider` в `apps/mobile/App.tsx`.

`apps/mobile/polyfill.js` вызывается до импорта Solana-кода. Это обязательный порядок для `react-native-quick-crypto`.

Для MWA нельзя использовать Expo Go: нужны Kotlin native modules и custom Expo development build. После `pnpm install` запускать:

```powershell
pnpm android
```

Identity MWA: `https://flipthememe.com` и относительная `icon-512.png` (`APP_IDENTITY` в `apps/mobile/src/config.ts`). `favicon.ico` на сайте отдаёт HTML, поэтому иконка указана явно. Digital Asset Links для ключа подписи публикует `services/link` на `sol.flipthememe.com` (App Links для ссылок `/r/<round>`); для домена identity `flipthememe.com` они не проверялись, а без проверки домена кошелёк имеет право отклонить авторизацию.

Проверено на devnet: Seed Vault Wallet на Seeker (Settings, Network, Devnet) Solflare и Jupiter Mobile (на втором телефоне, 12 октября) подписывают; Phantom в наших тестах открывался, но не возвращал подписи через MWA.

Через MWA подписываются только операции владельца:

- **Top up & play** - одна транзакция: `open_vault` (при первом пополнении), `deposit`, `start_session` (7 дней, не больше 0.1 SOL на ставку, запас оборота в 100 раз больше игрового баланса: программа считает ставки нарастающим итогом, поэтому лимит ограничивает частоту ставок ключа, а не потерю, ведь ставки берутся из vault) и перевод 0.005 SOL ключу устройства (device key), когда у него мало SOL на комиссии сети (rent позиций берётся из игрового баланса);
- `withdraw` и `revoke_session`.

Кошелёк только подписывает (`signTransactions`), в devnet транзакцию отправляет приложение. Если кошелёк отклоняет кэшированную авторизацию (истекла или выдана прошлой установке), приложение запрашивает её заново в новой MWA-сессии.

`place_bet` подписывает ключ устройства (device key: ed25519, хранится в `expo-secure-store`), без окна кошелька. Инструкции собирает `packages/client` на кодеках `@solana/kit`, без генератора Anchor. У ключа устройства нет инструкции вывода средств или изменения своих лимитов; его ставки программа проверяет по сроку, лимиту на ставку и бюджету сессии.
