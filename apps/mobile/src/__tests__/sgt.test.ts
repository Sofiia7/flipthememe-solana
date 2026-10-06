// Node tests for the pure Seeker Genesis Token check (no React Native). The fixtures are trimmed
// copies of real mainnet jsonParsed answers (a Seeker owner's wallet, 6 Oct 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SGT_GROUP, TOKEN_2022_PROGRAM, firstSeekerGenesis, heldMints, seekerGenesisFromMint, seekerLabel } from '../chain/sgtCheck.ts';

const SGT_MINT = '3UkqyqCQ6p2sf9DLBJisL4dm1YrTkxuLTFskjvpk4ben';
const AUTHORITY = 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4';

const sgtAccount = {
  owner: TOKEN_2022_PROGRAM,
  data: {
    parsed: {
      info: {
        decimals: 0,
        extensions: [
          { extension: 'metadataPointer', state: { authority: AUTHORITY, metadataAddress: SGT_GROUP } },
          { extension: 'permanentDelegate', state: { delegate: AUTHORITY } },
          { extension: 'groupMemberPointer', state: { authority: AUTHORITY, memberAddress: SGT_MINT } },
          { extension: 'tokenGroupMember', state: { group: SGT_GROUP, memberNumber: 31988, mint: SGT_MINT } },
        ],
        isInitialized: true,
        mintAuthority: AUTHORITY,
      },
      type: 'mint',
    },
    program: 'spl-token-2022',
  },
};

const memeAccount = {
  owner: TOKEN_2022_PROGRAM,
  data: { parsed: { info: { decimals: 6, extensions: [{ extension: 'transferHook', state: {} }], isInitialized: true }, type: 'mint' }, program: 'spl-token-2022' },
};

const tokenRow = (mint: string, amount: string) => ({
  pubkey: 'x',
  account: { data: { program: 'spl-token-2022', parsed: { info: { mint, tokenAmount: { amount, decimals: 0 } }, type: 'account' } } },
});

test('the SGT mint of a Seeker owner is recognised with its member number', () => {
  const sgt = seekerGenesisFromMint(SGT_MINT, sgtAccount);
  assert.deepEqual(sgt, { mint: SGT_MINT, memberNumber: 31988 });
  assert.equal(seekerLabel(sgt!), 'SEEKER #31988');
});

test('a mint needs both extensions pointing at the SGT group', () => {
  const withoutMember = structuredClone(sgtAccount);
  withoutMember.data.parsed.info.extensions = withoutMember.data.parsed.info.extensions.filter((e) => e.extension !== 'tokenGroupMember');
  assert.equal(seekerGenesisFromMint(SGT_MINT, withoutMember), null);

  const otherPointer = structuredClone(sgtAccount);
  (otherPointer.data.parsed.info.extensions[0]!.state as { metadataAddress: string }).metadataAddress = AUTHORITY;
  assert.equal(seekerGenesisFromMint(SGT_MINT, otherPointer), null);

  const otherGroup = structuredClone(sgtAccount);
  (otherGroup.data.parsed.info.extensions[3]!.state as { group: string }).group = AUTHORITY;
  assert.equal(seekerGenesisFromMint(SGT_MINT, otherGroup), null);
});

test('only Token-2022 mints with decimals 0 can be an SGT', () => {
  assert.equal(seekerGenesisFromMint(SGT_MINT, { ...sgtAccount, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }), null);
  const decimals = structuredClone(sgtAccount);
  decimals.data.parsed.info.decimals = 6;
  assert.equal(seekerGenesisFromMint(SGT_MINT, decimals), null);
  assert.equal(seekerGenesisFromMint(SGT_MINT, memeAccount), null);
  assert.equal(seekerGenesisFromMint(SGT_MINT, null), null);
  assert.equal(seekerGenesisFromMint(SGT_MINT, 'garbage'), null);
});

test('an SGT without a member number still verifies and the label has no number', () => {
  const noNumber = structuredClone(sgtAccount);
  delete (noNumber.data.parsed.info.extensions[3]!.state as { memberNumber?: number }).memberNumber;
  const sgt = seekerGenesisFromMint(SGT_MINT, noNumber);
  assert.deepEqual(sgt, { mint: SGT_MINT, memberNumber: null });
  assert.equal(seekerLabel(sgt!), 'SEEKER');
});

test('heldMints skips empty accounts (a transferred SGT leaves one), duplicates and malformed rows', () => {
  const rows = [tokenRow('A', '1'), tokenRow('B', '0'), tokenRow('A', '5'), tokenRow('C', '2056264710'), { nonsense: true }, null, tokenRow('D', 'abc')];
  assert.deepEqual(heldMints(rows), ['A', 'C']);
  assert.deepEqual(heldMints(undefined), []);
  assert.deepEqual(heldMints('x'), []);
});

test('firstSeekerGenesis finds the SGT among other mints by position', () => {
  const mints = ['meme1', SGT_MINT, 'meme2'];
  assert.deepEqual(firstSeekerGenesis(mints, [memeAccount, sgtAccount, memeAccount]), { mint: SGT_MINT, memberNumber: 31988 });
  assert.equal(firstSeekerGenesis(mints, [memeAccount, null, memeAccount]), null);
  assert.equal(firstSeekerGenesis([], []), null);
});
