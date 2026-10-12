# Live devnet acceptance - round 6622

On October 10, 2026, a server-side money cycle was run with two new operator wallets. The check refuses to run outside Solana devnet, as determined by the genesis hash. The keys remain in a closed persistent folder on the VPS; before broadcast, a journal of signed transactions is saved so that the run can be safely resumed.

- UP and DOWN: 0.02 test SOL each, both transactions confirmed.
- Final: DOWN, `refundReason=0`, 10 samples each in strike and exit; price 187304844221 → 187304688097 in program scale.
- Positions after claim: UP - 0, DOWN - 0.0392 SOL. The match with the contract formula was verified.
- Both claimed positions were recovered through HTTP history without the client's local history. The archive PUT requires a keeper signature; GET returns the stored data, and there is no separate detached signature in GET.
- To enable publication, the daily KV writes limit was eliminated: new snapshots/archive pages are stored in SQLite Durable Objects, and old KV entries are migrated on read. Live Worker `e42bbbc9-1b3d-4bf9-bf82-a2ba07931516`, deployed 10:15 UTC. Link checks 49/49 and the Worker dry-run passed.
- Available funds were withdrawn; vault available/locked - 0. Sessions revoked and closed.

UP bet: `TP6isZonukVN6UG2RFLAyEirvBmeiGMPuQsuDMKTJnyFQe2R7j3f4xLBJSHqGRf7TE5wSGijpH1nQe2SyqVxxVV`. The remaining signatures are stored in the [public verification journal](devnet-acceptance-6622.json) without keys or wire payload.

Closing the position with a rent refund and verifying that the HTTP history is preserved is done by a separate one-off process on the VPS after the program's mandatory delay. Earliest scheduled time: **11:14:55 UTC / 13:14:55 Budapest**. At the time this report was published, this step was waiting out the delay and is not declared passed. Log: `/home/openclaw/ftm-sol-keeper/deploy/data/acceptance-20261010/close.log`; result: `proof.json`, `closed=true` and stage `position-close-rent-and-archive-verified`.

This is server-side proof of operation on devnet. It does not verify the mobile UI, MWA, the Seeker lifecycle or real user cohorts. The user checks the physical Seeker independently using `docs/android-seeker-checklist.md`.
