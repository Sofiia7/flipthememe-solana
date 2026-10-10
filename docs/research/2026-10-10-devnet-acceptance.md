# Live devnet acceptance — round 6622

10 октября 2026 выполнен серверный денежный цикл двух новых операторских кошельков. Проверка отказывается работать вне Solana devnet по genesis hash. Ключи остаются в закрытой persistent-папке VPS; до broadcast сохраняется журнал подписанных транзакций для безопасного возобновления.

- UP и DOWN: по 0.02 тестового SOL, обе транзакции подтверждены.
- Финал: DOWN, `refundReason=0`, по 10 samples в strike и exit; цена 187304844221 → 187304688097 в масштабе программы.
- Позиции после claim: UP — 0, DOWN — 0.0392 SOL. Проверено совпадение с формулой контракта.
- Обе claimed-позиции восстановлены через HTTP history без локальной истории клиента. PUT архива требует подпись keeper; GET возвращает сохранённые данные, отдельной detached-подписи в GET нет.
- Для публикации устранён дневной лимит KV writes: новые snapshots/archive pages хранятся в SQLite Durable Objects, старые KV записи переносятся при чтении. Live Worker `e42bbbc9-1b3d-4bf9-bf82-a2ba07931516`, deployed 10:15 UTC. Проверки link 49/49 и Worker dry-run прошли.
- Доступные средства выведены; vault available/locked — 0. Сессии отозваны и закрыты.

Ставка UP: `TP6isZonukVN6UG2RFLAyEirvBmeiGMPuQsuDMKTJnyFQe2R7j3f4xLBJSHqGRf7TE5wSGijpH1nQe2SyqVxxVV`. Остальные подписи сохранены в [публичном журнале проверки](devnet-acceptance-6622.json) без ключей и wire payload.

Закрытие position с возвратом rent и проверкой сохранности HTTP-истории выполняет отдельный одноразовый процесс на VPS после обязательной задержки программы. Самое раннее запланированное время: **11:14:55 UTC / 13:14:55 Budapest**. На момент публикации этого отчёта этот шаг ожидает задержки и не объявлен пройденным. Журнал: `/home/openclaw/ftm-sol-keeper/deploy/data/acceptance-20261010/close.log`; итог: `proof.json`, `closed=true` и stage `position-close-rent-and-archive-verified`.

Это серверное доказательство работы на devnet. Мобильный UI, MWA, Seeker lifecycle и реальные пользовательские когорты им не проверены. Физический Seeker пользователь проверяет самостоятельно по `docs/android-seeker-checklist-ru.md`.
