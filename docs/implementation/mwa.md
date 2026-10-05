# Mobile Wallet Adapter: выбранная связка

Используется текущий для новых React Native приложений пакет `@wallet-ui/react-native-kit` с `@solana/kit`, devnet и `MobileWalletProvider` в `apps/mobile/App.tsx`.

`apps/mobile/polyfill.js` вызывается до импорта Solana-кода. Это обязательный порядок для `react-native-quick-crypto`.

Для MWA нельзя использовать Expo Go: нужны Kotlin native modules и custom Expo development build. После `pnpm install` запускать:

```powershell
pnpm android
```

Приложение использует `https://flipthememe.app` и относительную `icon.png` как identity MWA. До внешней проверки APK нужно опубликовать Digital Asset Links для ключа подписи; иначе кошелёк имеет право отклонить авторизацию.

Текущий экран вызывает `connect`/`disconnect`. Следующая денежная операция должна собрать `place_bet` из сгенерированного Anchor-клиента и отправить его через MWA. Нельзя заменять её локальным переключением состояния или разрешать сессионному ключу вывод средств.
