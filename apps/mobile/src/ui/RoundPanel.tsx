import { memo, useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Side, type PositionAccount } from '@flipthememe/client';
import type { PositionView, RoundView } from '../chain/fetch';
import type { InFlightStage } from '../chain/phase';
import { faceFromBytes, type Face } from '../face/faceModel';
import { formatSol } from '../lib/format';
import { HouseFace, PixelFace } from '../PixelFace';
import { C, MONO } from '../theme';

const MAX_CHIPS = 2;

/** A blinking dot for live states. */
export function Pulse({ color, size = 8 }: { color: string; size?: number }) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.25, duration: 550, useNativeDriver: true }),
        Animated.timing(v, { toValue: 1, duration: 550, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return <Animated.View style={{ width: size, height: size, backgroundColor: color, opacity: v }} />;
}


/** One stable row of players for the single-screen Arena. Full player cards remain available elsewhere. */
function CompactRoundPanel({ round, positions, me, rival, previewFace, stage, position, standing }: { round: RoundView; positions: readonly PositionView[]; me: string | null; rival: string | null; previewFace?: Face; stage: string; position?: PositionView; standing?: string | null }) {
  const count = Math.max(positions.length, round.account.positionCount);
  return <View style={[styles.panel, styles.panelOpen, { padding: 4, gap: 2, height: 78 }]}>
    <View style={[styles.head, { minHeight: 24 }]}>
      <Text numberOfLines={1} style={styles.title}>#{String(round.id)} - {stage}</Text>
      {!position && previewFace && count > 0 ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}><PixelFace face={previewFace} size={16} /><Text style={styles.houseTag}>YOU</Text></View> : null}
      <Text style={[styles.stageText, { color: standing === 'winning' ? C.neonGreen : standing === 'losing' ? C.neonRed : C.neonYellow }]}>{standing ? standing.toUpperCase() + ' NOW' : position ? sideText(position.account.side) + ' ' + formatSol(position.account.stake) + ' SOL' : count + ' IN'}</Text>
    </View>
    {!position && previewFace && count === 0 ? <View style={styles.previewPlayer}><PixelFace face={previewFace} size={32} /><Text style={styles.previewLabel}>YOU · CHOOSE UP OR DOWN</Text></View> : null}
    {count > 0 || !previewFace ? <View style={styles.sides}>{[Side.Up, Side.Down].map(side => {
      const players = sortPlayers(positions.filter(p => p.account.side === side), me, rival);
      const color = side === Side.Up ? C.neonGreen : C.neonRed;
      return <View key={side} style={[styles.compactSide, { borderColor: color }]}>
        <Text numberOfLines={1} style={[styles.stageText, { color }]}>{sideText(side)} {formatSol(side === Side.Up ? round.account.rawUp : round.account.rawDown)}</Text>
        <View style={styles.compactPlayers}>{players.slice(0, MAX_CHIPS).map(player => {
          const mine = !player.account.isHouse && player.account.authority === me;
          const isRival = !mine && !player.account.isHouse && player.account.authority === rival;
          return <View key={player.address} style={styles.compactPlayer}>
            {player.account.isHouse ? <HouseFace size={32} /> : <PixelFace face={faceFromBytes(player.account.face)} size={32} expression={mine ? standing === 'winning' ? 'happy' : standing === 'losing' ? 'sad' : undefined : undefined} />}
            <Text numberOfLines={1} style={[styles.houseTag, { fontSize: 8, lineHeight: 8, color: mine ? color : isRival ? C.neonPink : C.subtle }]}>{mine ? 'YOU' : player.account.isHouse ? 'HOUSE' : isRival ? 'RIVAL' : 'PLAYER'}</Text>
          </View>;
        })}{players.length === 0 ? <Text style={styles.houseTag}>{(side === Side.Up ? round.account.rawUp : round.account.rawDown) > 0n ? 'READING...' : 'NO CALLS YET'}</Text> : players.length > MAX_CHIPS ? <Text style={styles.houseTag}>+{players.length - MAX_CHIPS}</Text> : null}</View>
      </View>;
    })}</View> : null}
  </View>;
}
const sideText = (side: number) => side === Side.Up ? 'UP' : 'DOWN';

/** The friend whose challenge link opened the app, on their face in the round panels (YOU wins on my own face). */
export function RivalTag() {
  return <Text style={[styles.youTag, { backgroundColor: C.neonPink }]}>RIVAL</Text>;
}

function sortPlayers(positions: readonly PositionView[], me: string | null, rival: string | null): PositionView[] {
  const rank = (p: PositionView) =>
    p.account.isHouse ? 2 : me !== null && p.account.authority === me ? 0 : rival !== null && p.account.authority === rival ? 1 : 3;
  return [...positions].sort((a, b) => rank(a) - rank(b) || (a.account.stake > b.account.stake ? -1 : a.account.stake < b.account.stake ? 1 : 0));
}

const STAGE: Record<InFlightStage, string> = {
  fixing: 'START PRICE SOON',
  live: 'LIVE',
  settling: 'RESULT SOON',
};

/** The round I am waiting for: both sides with faces, me highlighted, and whether I am winning right now. */
export const MyRoundPanel = memo(function MyRoundPanel({
  round,
  position,
  positions,
  stage,
  standing,
  me,
  rival = null,
}: {
  round: RoundView;
  position: PositionView;
  positions: readonly PositionView[];
  stage: InFlightStage;
  standing: 'winning' | 'losing' | 'tie' | null;
  me: string;
  rival?: string | null;
}) {
  // The arena window may not include this round's positions yet: my own one is always known.
  const all = positions.some((p) => p.address === position.address) ? positions : [...positions, position];
  return <CompactRoundPanel round={round} positions={all} me={me} rival={rival} stage={STAGE[stage]} position={position} standing={standing} />;
});

/** The round open for entry (or the one opening next): both sides with their faces, or an invitation when nobody has called it yet. */
export const OpenRoundPanel = memo(function OpenRoundPanel({
  round,
  positions,
  me,
  rival = null,
  upcoming,
  previewFace,
}: {
  previewFace?: Face;
  round: RoundView;
  positions: readonly PositionView[];
  me: string | null;
  rival?: string | null;
  upcoming: boolean;
}) {
  const mine = positions.find((p) => p.account.authority === me && !p.account.isHouse);
  return <CompactRoundPanel round={round} positions={positions} me={me} rival={rival} previewFace={previewFace} stage={upcoming ? 'OPENS SOON' : mine ? 'SAVED' : 'OPEN'} position={mine} />;
});

/** A compact line for another round of mine still in flight. */
export function ExtraRoundLine({
  round,
  position,
  standing,
  late,
}: {
  round: RoundView;
  position: PositionAccount;
  standing: 'winning' | 'losing' | 'tie' | null;
  late: string | null;
}) {
  const up = position.side === Side.Up;
  const color = late ? C.warn : standing === 'winning' ? C.neonGreen : standing === 'losing' ? C.neonRed : C.subtle;
  return (
    <View style={styles.extra}>
      <Text style={styles.extraId}>#{round.id.toString()}</Text>
      <Text style={[styles.extraSide, { color: up ? C.neonGreen : C.neonRed }]}>
        {up ? 'UP ▲' : 'DOWN ▼'} {formatSol(position.stake)}
      </Text>
      <Text style={[styles.extraState, { color }]} numberOfLines={1}>
        {late ?? (standing === 'winning' ? 'WINNING' : standing === 'losing' ? 'LOSING' : standing === 'tie' ? 'TIE' : 'IN PLAY')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  compactSide: { flex: 1, minWidth: 0, height: 42, flexDirection: 'row', alignItems: 'center', borderWidth: 1, paddingHorizontal: 2, gap: 4 },
  compactPlayers: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, flex: 1 },
  compactPlayer: { alignItems: 'center', gap: 1 },
  previewPlayer: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 34 },
  previewLabel: { color: C.subtle, fontFamily: MONO, fontSize: 10, fontWeight: '900' },
  panel: { borderWidth: 2, backgroundColor: C.panelDeep, padding: 6, gap: 4 },
  panelOpen: { borderColor: '#5b4f78', borderWidth: 1 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, minHeight: 22 },
  title: { color: C.white, fontSize: 13, fontWeight: '900', fontFamily: MONO },
  stageText: { fontSize: 11, fontWeight: '900', fontFamily: MONO, letterSpacing: 0.5 },
  sides: { flexDirection: 'row', gap: 8 },
  youTag: { color: C.bg, fontSize: 9, fontWeight: '900', paddingHorizontal: 4, fontFamily: MONO },
  houseTag: { color: C.house, fontSize: 9, fontWeight: '900', fontFamily: MONO },
  extra: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 2 },
  extraId: { color: C.subtle, fontSize: 11, fontFamily: MONO, fontWeight: '800' },
  extraSide: { fontSize: 11, fontFamily: MONO, fontWeight: '900' },
  extraState: { fontSize: 11, fontFamily: MONO, fontWeight: '900', flexShrink: 1, marginLeft: 'auto' },
});
