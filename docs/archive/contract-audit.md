> Status: superseded on 2026-10-05 by [README.md](../../README.md) and [docs/superpowers/specs/2026-10-05-flipthememe-solana-hackathon-build-design.md](../superpowers/specs/2026-10-05-flipthememe-solana-hackathon-build-design.md). Kept for history; it reviews the September program draft (`MOCK_ONLY`, `lock_round` / `activate_round`, `settle_round` with two prices, the example program id), which was replaced. The later review notes (5 and 6 October 2026) were local working notes and are not part of the repository.

# Статический аудит - 15 сентября 2026

**Граница проверки.** Это внутренний аудит исходного кода, не независимое заключение и не разрешение принимать деньги. Проверены `programs/flip-the-meme/src/lib.rs`, модель `packages/arena-core`, keeper и экран mobile. Rust/Solana/Anchor на машине отсутствуют, поэтому Anchor build, IDL, account-size и runtime/integration-тесты пока не подтверждены.

## Итог

Репозиторий корректно маркирует текущий режим как mock/devnet draft. Денежную программу нельзя деплоить или использовать даже на devnet до закрытия P0. Самая опасная найденная проблема - администратор может снова изменить уже финализированный раунд через неограниченные переходы `lock_round`/`activate_round`; а результат всё ещё определяется двумя непроверяемыми значениями от price authority.

## Исполнение исправлений

- Исправлено в исходнике: точные переходы `Scheduled → Open → Locked → Active → terminal`; финальный раунд больше нельзя повторно lock/activate/settle.
- Исправлено в исходнике: strict session expiry, безопасное переиздание revoked/expired session и учёт общих available/locked обязательств.
- Исправлено в исходнике: `withdraw_round_fees` доступен treasury только после claim каждой позиции и проверяет reserve плюс все пользовательские обязательства.
- Защитно закрыто: `MOCK_ONLY` теперь отклоняет deposit и создание раунда on-chain; mobile не создаёт ложную локальную позицию.
- Подтверждено: `cargo check` проходит с закреплённым `anchor-lang 1.1.2`; Rust, MSVC Build Tools и Windows SDK подготовлены локально.
- Остаётся внешней зависимостью: program keypair/ID, проверяемый live-price adapter, Solana/Anchor runtime и integration-тесты. Эти пункты нельзя объявить закрытыми до появления соответствующей инфраструктуры и правила рынка.

## Найденные проблемы

| Приоритет | Где | Наблюдение и риск | Требуемое условие закрытия |
|---|---|---|---|
| P0 | `lib.rs`: `lock_round`, `activate_round` | Инструкции проверяют лишь время, но не предыдущее состояние. После `SETTLED_*` или `REFUNDABLE` admin может вызвать `lock_round`, потом `activate_round`, а price authority - новый settlement. Уже получившие claim не участвуют в новом результате, остальные получают изменённый результат. | Разрешить только `Scheduled → Open → Locked → Active → terminal`; каждую инструкцию ограничить точным предыдущим `RoundStatus`. Финальные статусы должны быть необратимы; покрыть retry и вызовы после каждого terminal state. |
| P0 | `lib.rs`: `settle_round`, `Round`; keeper | Контракт принимает две голые цены от одного доверенного ключа. В Round нет идентификатора источника/наблюдений, границ P0/P1, метода агрегации или доказательства связи с `pool`. Price authority может рассчитать другой рынок или произвольный исход. | До реализации проверяемого адаптера оставлять программу в `MOCK_ONLY` и не принимать депозиты. Зафиксировать в Round source/pool/rule/window и хеш или проверяемые ссылки на наблюдения; добавить fixtures и негативные тесты. |
| P0 | `declare_id!`, `Anchor.toml` | В обоих местах задан стандартный пример Anchor `Fg6Pa…`; это не ключ развёртывания и клиенты не могут безопасно определить, какую программу вызывают. | Сгенерировать отдельный program keypair для devnet, синхронно заменить `declare_id!`, `Anchor.toml`, сгенерированный IDL и mobile environment; зафиксировать upgrade authority. |
| P0 | сборка/тесты | На текущей машине нет `cargo`, `anchor` и `solana`; program draft не скомпилирован. Следовательно PDA constraints, `InitSpace`, lamport mutations и инструкции не были исполнены. | Закрепить совместимую версию Anchor/Solana/Rust, выполнить `anchor build` и integration tests с двумя кошельками: deposit → session bet → settle → claim; refund; replay; cutoff/expiry/deadline границы; переполнение и неверные аккаунты. |
| P1 | `lib.rs`: fee/dust | Комиссия и lamport-остаток округления остаются в общем Config, но нет ledger-а, счётчика обработанных победителей или безопасного `withdraw_fee`. Их нельзя прозрачно отделить от невостребованных выплат. | Хранить fee/dust/claimed obligations раздельно; переводить только доказанный остаток после всех допустимых claims либо не вводить fee withdrawal в MVP. Невостребованные claims не считать округлением. |
| P1 | `lib.rs`: `start_session` | Session PDA создаётся с `init` и никогда не закрывается/не переинициализируется. После revoke или expiry та же пара vault + session signer больше не может получить новое разрешение. | Либо документировать ротацию signer для каждой новой сессии, либо добавить безопасное переиздание/закрытие при согласии authority и проверить, что старый ключ нельзя оживить. |
| P2 | `lib.rs`: session expiry | Bet допускается при `now == expiry` (`now <= expiry`). Если expiry - момент истечения, это расширяет разрешение на один слот/секунду относительно обычной семантики. | Зафиксировать семантику и, если expiry исключителен, применить `now < expiry`; добавить boundary test. |
| P2 | mobile `App.tsx` | Нажатие «ВЫБРАТЬ» после подключения меняет только локальный `entered`; нет deposit, session, подписанной `place_bet`, подтверждения, восстановления или claim/refund. Экран также показывает mock pools/chart как OPEN. | До wallet-flow держать действие явно как demo/mock и не выдавать его за позицию. Для devnet подключить authoritative snapshot, transaction lifecycle и direct claim/refund. |
| P2 | mobile/keeper config | `apiBaseUrl` использует `10.0.2.2`, который работает лишь в Android emulator, а сам App API не потребляет. На физическом устройстве keeper по этому адресу недоступен. | Использовать доступный HTTPS endpoint или настраиваемый LAN URL для development build; тестировать на физическом Android. |

## Проверенные положительные свойства

- `withdraw` удерживает rent-exempt reserve Config и уменьшает только `vault.available`; заблокированная ставка не выводится.
- Position PDA включает `(round, authority)` и `init` предотвращает вторую позицию на тот же раунд.
- Session проверяет signer, revoke, сумму одной ставки и накопленный cap; сессионный ключ не имеет инструкции вывода.
- `claim` связывает Config с `round.config`; получатель начисления - исходный Vault, не вызывающий keeper.
- Расчёт использует lamports и `u128` для произведения prize × stake; tie, пустая сторона и timeout дают возврат без комиссии.
- JS-модель использует `bigint`; `pnpm test` прошёл 7/7, `pnpm --filter @flipthememe/mobile typecheck` прошёл.

## Обязательная повторная проверка

После P0 нужны compiled Anchor tests и независимый review. До них запрещены mainnet, реальные средства, заявления о готовом APK или о live market-price settlement. Отдельно вручную пройти на двух устройствах: потерянный RPC-ответ после исполнения, double tap, уход в фон, перезапуск, остановка keeper и permissionless refund после deadline.
