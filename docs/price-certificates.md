# Canonical price certificates

This is the replacement for the keeper transaction co-signing protocol. Deployment status belongs
in the root README; a source change alone does not mean the devnet program was upgraded.

`GET https://sol.flipthememe.com/v1/attestation?round=<id>&kind=strike|exit` needs no token.
The attestor reads the round PDA on devnet, waits until 1.5 seconds after the measurement window,
then fixes its own observations from `[start, end)`: the first observation per confirmed mainnet
slot, sorted by slot, at most 16. Callers cannot propose samples. SQLite stores the exact message
and sample list before signing; retries and Durable Object eviction cannot change the list.
Fewer than five observations certify an unpriceable window, which the program refunds under its
existing house-forfeit rule. Certificates are retained for six hours, longer than the maximum
on-chain pricing deadline. The endpoint rejects expired windows; the program independently checks
its clock and round state.

The Ed25519 signed bytes, with integers in little endian order, are:

| Field | Encoding |
| --- | --- |
| Domain | UTF-8 `FlipTheMeme devnet price v1` followed by a zero byte |
| Program, round PDA, mainnet pool | Three 32-byte public keys |
| Kind | u8: 0 strike, 1 exit |
| Window start, end | Two i64 Unix timestamps |
| Sample count | u32 |
| Samples | Each: u64 confirmed mainnet slot, u64 price |

Relayers submit a native Ed25519 verification instruction immediately followed by
`set_strike_attested` or `settle_attested`. The program checks the preceding instruction's program
id, one signature, exact self-contained offsets, attestor key from OracleConfig and exact signed
message. Proofs from another program, round, pool, window or kind cannot be reused. CPI submission
through a different top-level program is refused. No keeper, price-authority or attestor transaction
signature is needed: the relayer pays only the network fee. The attestor key signs the certificate
off chain. When OracleConfig.required is true, the old priced instructions return
`DetachedPriceRequired`; unmatched rounds and deadline refunds retain their existing paths.

```powershell
node services/keeper/scripts/relay-price.ts 42 strike --keypair C:/path/to/devnet-payer.json
node services/keeper/scripts/relay-price.ts 42 exit --keypair C:/path/to/devnet-payer.json
```

`ATTEST_URL` optionally selects another endpoint; `DEVNET_RPC` selects the devnet RPC.
The relay verifies the signature locally before spending its fee.

The old authenticated `POST /v1/attest` route remains for pre-upgrade compatibility. Its 150 bps
mean tolerance and 60% keeper coverage do not apply to canonical certificates. Keeper
`LEGACY_PRICES=true` is only for the old program during a coordinated deployment; it cannot bypass
the upgraded program's requirement. Production must use false after upgrade.

This removes the keeper's sample selection and submission monopoly. It does not make mainnet
prices trustless: the devnet program cannot independently read mainnet, and the attestor and its
RPC providers remain trusted for observations and availability. Withholding a certificate leads
to the permissionless deadline refund and house forfeiture, rather than an operator-chosen price.
