// A friend's challenge or invite from a shared link, on the Arena until OK: who called what in which
// round, how that round went, and where to meet now. Text only: no bet button and no side picked for the
// reader, the bet buttons below stay the only way to play.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { RoundView } from '../chain/fetch';
import { useSkrNames } from '../chain/skr';
import { useRoundById } from '../chain/useRoundById';
import { useApp } from '../state/AppProvider';
import {
  challengeHeadline,
  challengeRoundState,
  inviterPosition,
  isInvite,
  meetLine,
  roundStateLine,
  type Challenge,
  type ChallengeRoundState,
} from '../state/challenge';
import { scoreLine } from '../state/rivalScore';
import { C } from '../theme';
import { RivalTag } from './RoundPanel';

function stateColor(state: ChallengeRoundState): string {
  if (state.kind === 'open') return C.neonYellow;
  if (state.kind !== 'final') return C.text;
  return state.label === 'UP' ? C.neonGreen : state.label === 'DOWN' ? C.neonRed : C.neonYellow;
}

export function ChallengeCard({
  challenge: link,
  open,
  nowSec,
  onClose,
}: {
  challenge: Challenge;
  /** The round open for entry now. */
  open: RoundView | null;
  nowSec: number;
  onClose: () => void;
}) {
  const { rpc, arena, rivalScore, wallet, myReady } = useApp();
  // The name in a link is whatever its sender typed, so the card shows the inviter's real Seeker ID
  // (looked up for `by`), else their short address; a link without `by` stays A FRIEND.
  const verified = useSkrNames(link.by ? [link.by] : []).get(link.by ?? '') ?? null;
  const challenge: Challenge = { ...link, name: link.by ? verified : null };
  const read = useRoundById(rpc, challenge.round);
  // While the round is in the arena window the arena's read is the fresher one (every 2 s).
  const round = arena.rounds.find((r) => r.id === challenge.round) ?? read?.round ?? null;
  const state = challengeRoundState(round?.account ?? null, nowSec);
  // An invite's round is only the one open when it was sent: nothing to say about how it went.
  const stateText = isInvite(challenge) ? null : roundStateLine(challenge, state);
  // The meeting point: the inviter's own call in the round open now, from the players the arena already reads.
  const met = open ? inviterPosition(arena.positions.get(open.id) ?? [], challenge.by) : null;
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        {challenge.by ? <RivalTag /> : null}
        <Text style={styles.headline}>{challengeHeadline(challenge)}</Text>
        <Pressable onPress={onClose} style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }} hitSlop={8} accessibilityRole="button" accessibilityLabel="Dismiss the challenge">
          <Text style={styles.ok}>OK</Text>
        </Pressable>
      </View>
      {stateText ? <Text style={[styles.line, { color: stateColor(state) }]}>{stateText}</Text> : null}
      <Text style={[styles.line, { color: met ? C.accentText : C.subtle }]}>{meetLine(challenge, open?.id ?? null, met?.account.side ?? null)}</Text>
      <Text style={[styles.line, { color: C.white }]}>YOU: {wallet.owner && myReady ? 'wallet connected' : 'prepare your wallet'} · FRIEND: {met ? 'bet confirmed in this round' : 'not yet confirmed in this round'}</Text>
      {!met ? <Text style={[styles.line, { color: C.subtle }]}>Shared meetup: {new Date((Math.floor(nowSec / 300) + 1) * 300_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Keep this invite; entry opens only when market checks pass.</Text> : null}
      {/* The personal score against this friend: rounds where we called opposite sides, since the app opened. */}
      {rivalScore && challenge.by ? <Text style={[styles.line, styles.duel]}>{scoreLine(rivalScore, verified?.replace(/\.skr$/, '') ?? null)}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: C.neonPink, backgroundColor: C.panelDeep, padding: 8, gap: 4 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headline: { flex: 1, color: C.white, fontSize: 12, fontWeight: '900', lineHeight: 16 },
  ok: { color: C.neonPink, fontSize: 11, fontWeight: '900', textDecorationLine: 'underline' },
  line: { fontSize: 11, fontWeight: '700', lineHeight: 15 },
  duel: { color: C.neonPink, fontSize: 13, fontWeight: '900', lineHeight: 17 },
});
