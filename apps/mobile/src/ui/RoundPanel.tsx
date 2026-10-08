import { memo, useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Side, acceptedStake, isActivated, type PositionAccount } from '@flipthememe/client';
import type { PositionView, RoundView } from '../chain/fetch';
import type { InFlightStage } from '../chain/phase';
import { pulseText, roundPulse } from '../chain/roundPulse';
import { useSkrNames } from '../chain/skr';
import { faceFromBytes, type Expression } from '../face/faceModel';
import { formatCountdown, formatSol } from '../lib/format';
import { HouseFace, PixelFace } from '../PixelFace';
import { C, FONT_CAP, MONO } from '../theme';
import { PixelText } from './PixelText';

const MAX_CHIPS = 5;

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

/** The friend whose challenge link opened the app, on their face in the round panels (YOU wins on my own face). */
export function RivalTag() {
  return <Text style={[styles.youTag, { backgroundColor: C.neonPink }]}>RIVAL</Text>;
}

function sortPlayers(positions: readonly PositionView[], me: string | null, rival: string | null): PositionView[] {
  const rank = (p: PositionView) =>
    p.account.isHouse ? 2 : me !== null && p.account.authority === me ? 0 : rival !== null && p.account.authority === rival ? 1 : 3;
  return [...positions].sort((a, b) => rank(a) - rank(b) || (a.account.stake > b.account.stake ? -1 : a.account.stake < b.account.stake ? 1 : 0));
}

/**
 * One side of a round: total on top, then the players as pixel faces (mine first and bigger, then the
 * rival of a challenge, the house as HOUSE).
 */
export function SideColumn({
  side,
  total,
  positions,
  me,
  rival = null,
  myExpression,
  big = false,
}: {
  side: number;
  total: bigint;
  positions: readonly PositionView[];
  me: string | null;
  /** Wallet of the friend whose challenge is open: their face gets the RIVAL tag. */
  rival?: string | null;
  myExpression?: Expression;
  big?: boolean;
}) {
  const up = side === Side.Up;
  const color = up ? C.neonGreen : C.neonRed;
  const sorted = sortPlayers(positions, me, rival);
  const shown = sorted.slice(0, MAX_CHIPS);
  const more = sorted.length - shown.length;
  const hasMe = me !== null && positions.some((p) => p.account.authority === me && !p.account.isHouse);
  // Seeker ID names (.skr) of the players shown; a player without one stays a face.
  const names = useSkrNames(shown.filter((p) => !p.account.isHouse).map((p) => p.account.authority));
  return (
    <View style={[styles.column, hasMe && { borderColor: color, backgroundColor: up ? 'rgba(53,223,108,0.08)' : 'rgba(251,96,124,0.08)' }]}>
      <View style={styles.colHead}>
        <PixelText text={up ? 'UP' : 'DOWN'} size={1.8} color={color} />
        <Text style={styles.total}>
          {formatSol(total)}
          <Text style={styles.unit}> SOL</Text>
        </Text>
      </View>
      <View style={styles.chips}>
        {shown.length === 0 ? (
          <View style={[styles.ghost, big && styles.ghostBig]}>
            <Text style={styles.ghostText}>?</Text>
          </View>
        ) : null}
        {shown.map((p) => {
          const mine = me !== null && p.account.authority === me && !p.account.isHouse;
          const house = p.account.isHouse;
          return (
            <View key={p.address} style={styles.chip}>
              {house ? (
                <HouseFace size={big ? 34 : 28} />
              ) : (
                <View style={mine ? [styles.meRing, { borderColor: color, boxShadow: `0 0 10px ${color}` }] : null}>
                  <PixelFace face={faceFromBytes(p.account.face)} size={mine ? (big ? 52 : 40) : big ? 34 : 28} expression={mine ? myExpression : undefined} />
                </View>
              )}
              {mine ? (
                <Text style={[styles.youTag, { backgroundColor: color }]}>YOU</Text>
              ) : house ? (
                <Text style={styles.houseTag}>HOUSE</Text>
              ) : rival !== null && p.account.authority === rival ? (
                <RivalTag />
              ) : names.get(p.account.authority) ? (
                <Text style={styles.nickTag} numberOfLines={1}>
                  {names.get(p.account.authority)!.replace(/\.skr$/, '')}
                </Text>
              ) : null}
              <Text style={[styles.stake, { color }]}>{formatSol(p.account.stake)}</Text>
            </View>
          );
        })}
        {more > 0 ? (
          <View style={styles.moreChip}>
            <Text style={styles.moreText}>+{more}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const STAGE: Record<InFlightStage, { text: string; color: string }> = {
  fixing: { text: 'PREPARING', color: C.neonYellow },
  live: { text: 'LIVE', color: C.neonGreen },
  settling: { text: 'RESULT SOON', color: C.neonPurple },
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
  const a = round.account;
  // The arena window may not include this round's positions yet: my own one is always known.
  const all = positions.some((p) => p.address === position.address) ? positions : [...positions, position];
  const ups = all.filter((p) => p.account.side === Side.Up);
  const downs = all.filter((p) => p.account.side === Side.Down);
  const expression: Expression | undefined = standing === 'winning' ? 'happy' : standing === 'losing' ? 'sad' : undefined;
  const st = STAGE[stage];
  const glow = standing === 'winning' ? C.neonGreen : standing === 'losing' ? C.neonRed : C.neonPurple;
  return (
    <View style={[styles.panel, { borderColor: glow, boxShadow: `0 0 16px ${glow}66` }]}>
      <View style={styles.head}>
        <View style={styles.headLeft}>
          <Text style={styles.title}>YOUR ROUND #{round.id.toString()} ·</Text>
          <View style={styles.stage}>
            {stage === 'live' ? <Pulse color={st.color} size={7} /> : null}
            <Text style={[styles.stageText, { color: st.color }]}>{st.text}</Text>
          </View>
        </View>
        <StandingBadge stage={stage} standing={standing} />
      </View>
      <View style={styles.sides}>
        <SideColumn side={Side.Up} total={a.rawUp} positions={ups} me={me} rival={rival} myExpression={expression} big />
        <SideColumn side={Side.Down} total={a.rawDown} positions={downs} me={me} rival={rival} myExpression={expression} big />
      </View>
      {/* While the strike is being fixed the house may still fill the short side: wait until the book is final. */}
      {stage !== 'fixing' ? <MatchedLine rawUp={a.rawUp} rawDown={a.rawDown} minBank={a.minBank} side={position.account.side} stake={position.account.stake} /> : null}
    </View>
  );
});

/**
 * Once the house fill window is over the book is final: how much of my stake plays and how much comes back,
 * in one line ("0.02 playing · 0.08 back"). Nothing to say when all of it plays.
 */
function MatchedLine({ rawUp, rawDown, minBank, side, stake }: { rawUp: bigint; rawDown: bigint; minBank: bigint; side: number; stake: bigint }) {
  if (!isActivated(rawUp, rawDown, minBank)) {
    return <Text style={[styles.matchedLine, { color: C.neonYellow }]}>NO MATCH - stake back</Text>;
  }
  const accepted = acceptedStake(rawUp, rawDown, side as Side, stake);
  if (accepted === null || accepted >= stake) return null;
  return (
    <Text style={styles.matchedLine}>
      {formatSol(accepted)} playing · {formatSol(stake - accepted)} back
    </Text>
  );
}

/** Live: winning / losing right now against the strike. The strike countdown itself sits next to the big timer; RESULT SOON is in the header. */
function StandingBadge({ stage, standing }: { stage: InFlightStage; standing: 'winning' | 'losing' | 'tie' | null }) {
  if (stage === 'settling' || stage === 'fixing' || standing === null) return null;
  const bg = standing === 'winning' ? C.neonGreen : standing === 'losing' ? C.neonRed : C.neonYellow;
  const text = standing === 'winning' ? 'WINNING NOW ▲' : standing === 'losing' ? 'LOSING NOW ▼' : 'TIE NOW';
  return <Text style={[styles.badge, { backgroundColor: bg }]}>{text}</Text>;
}

/** Players of the open round with "N IN · X SOL" big on top, or an invitation when nobody has called it yet. */
export const OpenRoundPanel = memo(function OpenRoundPanel({
  round,
  positions,
  me,
  rival = null,
  upcoming,
}: {
  round: RoundView | null;
  positions: readonly PositionView[];
  me: string | null;
  rival?: string | null;
  upcoming: boolean;
}) {
  const ups = positions.filter((p) => p.account.side === Side.Up);
  const downs = positions.filter((p) => p.account.side === Side.Down);
  const pulse = round
    ? pulseText(roundPulse({ positions, positionCount: round.account.positionCount, rawUp: round.account.rawUp, rawDown: round.account.rawDown }), formatSol)
    : null;
  return (
    <View style={[styles.panel, styles.panelOpen]}>
      <View style={styles.head}>
        <View style={styles.headLeft}>
          <Text style={styles.title}>{round ? `ROUND #${round.id.toString()} ·` : 'NEXT ROUND ·'}</Text>
          <Text style={[styles.stageText, { color: upcoming ? C.subtle : C.neonYellow }]}>{upcoming || !round ? 'OPENS SOON' : 'OPEN'}</Text>
        </View>
        {pulse ? (
          <Text style={styles.pulse} numberOfLines={1} maxFontSizeMultiplier={FONT_CAP}>
            {pulse}
          </Text>
        ) : null}
      </View>
      {positions.length === 0 ? (
        <View style={styles.empty}>
          <View style={styles.ghost}>
            <Text style={[styles.ghostText, { color: C.neonGreen }]}>▲</Text>
          </View>
          <View style={styles.emptyMid}>
            <Text style={styles.emptyTitle}>BE THE FIRST{'\n'}TO CALL IT</Text>
            <Text style={styles.emptyArrow}>▼</Text>
          </View>
          <View style={styles.ghost}>
            <Text style={[styles.ghostText, { color: C.neonRed }]}>▼</Text>
          </View>
        </View>
      ) : (
        <View style={styles.sides}>
          <SideColumn side={Side.Up} total={round?.account.rawUp ?? 0n} positions={ups} me={me} rival={rival} />
          <SideColumn side={Side.Down} total={round?.account.rawDown ?? 0n} positions={downs} me={me} rival={rival} />
        </View>
      )}
    </View>
  );
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

/** "NEXT #102 · bet by 0:16": the round the bet buttons play, right above them while my round is in flight; `token` names it when it is another coin than the stage's. */
export function NextRoundBar({ roundId, secondsLeft, opens, token = null }: { roundId: bigint; secondsLeft: number; opens: boolean; token?: string | null }) {
  const urgent = !opens && secondsLeft <= 5;
  return (
    <View style={styles.next}>
      <Pulse color={urgent ? C.neonRed : C.neonYellow} size={6} />
      <Text style={styles.nextText}>
        NEXT #{roundId.toString()}
        {token ? <Text style={styles.nextToken}> ${token.toUpperCase()}</Text> : null} · {opens ? 'opens in' : 'entry closes in'}{' '}
        <Text style={[styles.nextClock, urgent && { color: C.neonRed }]}>{formatCountdown(secondsLeft)}</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  matchedLine: { color: C.subtle, fontSize: 11, fontWeight: '900', fontFamily: MONO, textAlign: 'center' },
  panel: { borderWidth: 2, backgroundColor: C.panelDeep, padding: 8, gap: 8 },
  panelOpen: { borderColor: '#5b4f78', borderWidth: 1 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, minHeight: 22 },
  headLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  title: { color: C.white, fontSize: 13, fontWeight: '900', fontFamily: MONO },
  stage: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stageText: { fontSize: 11, fontWeight: '900', fontFamily: MONO, letterSpacing: 0.5 },
  badge: { color: C.bg, fontSize: 12, fontWeight: '900', fontFamily: MONO, paddingHorizontal: 6, paddingVertical: 3 },
  // Social proof of the open round: big and warm, the one number a newcomer reads first.
  pulse: {
    color: C.neonYellow,
    fontSize: 16,
    fontWeight: '900',
    fontFamily: MONO,
    flexShrink: 0,
    textShadowColor: C.neonYellow,
    textShadowRadius: 8,
    textShadowOffset: { width: 0, height: 0 },
  },
  sides: { flexDirection: 'row', gap: 8 },
  column: { flex: 1, borderWidth: 1, borderColor: C.borderSoft, backgroundColor: C.panel, padding: 6, gap: 6, minHeight: 84 },
  colHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  sideName: { fontSize: 15, fontWeight: '900' },
  total: { color: C.white, fontFamily: MONO, fontWeight: '900', fontSize: 15 },
  unit: { color: C.subtle, fontSize: 9, fontWeight: '800' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'flex-end' },
  chip: { alignItems: 'center', gap: 2 },
  meRing: { borderWidth: 2, padding: 1 },
  youTag: { color: C.bg, fontSize: 9, fontWeight: '900', paddingHorizontal: 4, fontFamily: MONO },
  houseTag: { color: C.house, fontSize: 9, fontWeight: '900', fontFamily: MONO },
  nickTag: { color: C.accentText, fontSize: 9, fontWeight: '800', fontFamily: MONO, maxWidth: 60 },
  stake: { fontSize: 9, fontWeight: '800', fontFamily: MONO },
  ghost: {
    width: 34,
    height: 34,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#5b4f78',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostBig: { width: 44, height: 44 },
  ghostText: { color: C.dim, fontSize: 16, fontWeight: '900' },
  moreChip: { height: 28, minWidth: 28, paddingHorizontal: 4, borderWidth: 1, borderColor: C.borderSoft, alignItems: 'center', justifyContent: 'center' },
  moreText: { color: C.subtle, fontSize: 10, fontWeight: '900', fontFamily: MONO },
  empty: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, paddingHorizontal: 8 },
  emptyMid: { alignItems: 'center', gap: 2 },
  emptyTitle: {
    color: C.neonYellow,
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '900',
    textAlign: 'center',
    fontFamily: MONO,
    textShadowColor: C.neonYellow,
    textShadowRadius: 10,
    textShadowOffset: { width: 0, height: 0 },
  },
  emptyArrow: { color: C.neonYellow, fontSize: 12, fontWeight: '900' },
  extra: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 2 },
  extraId: { color: C.subtle, fontSize: 11, fontFamily: MONO, fontWeight: '800' },
  extraSide: { fontSize: 11, fontFamily: MONO, fontWeight: '900' },
  extraState: { fontSize: 11, fontFamily: MONO, fontWeight: '900', flexShrink: 1, marginLeft: 'auto' },
  next: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 2 },
  nextText: { color: C.text, fontSize: 12, fontWeight: '800', fontFamily: MONO },
  nextToken: { color: C.neonYellow, fontWeight: '900' },
  nextClock: { color: C.neonYellow, fontWeight: '900' },
});
