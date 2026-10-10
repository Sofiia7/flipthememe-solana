import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, BackHandler, Easing, Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Side, acceptedStake } from '@flipthememe/client';
import { classifyRounds } from '../chain/phase';
import { useRents } from '../chain/rent';
import { useMarketStatus } from '../chain/useMarketStatus';
import { canRepeatBet, holdsPosition, multiplierText } from '../chain/repeatBet';
import { chainNowSec } from '../chain/useChainClock';
import { useSkrNames } from '../chain/skr';
import { peekTokenInfo } from '../chain/useTokenInfo';
import { SESSION_RULES } from '../config';
import { deltaView, formatCountdown, formatSol } from '../lib/format';
import { useNow } from '../lib/usePolling';
import { PixelFace } from '../PixelFace';
import { shareCard } from '../share/ShareCard';
import { captionSuffix, pickCardCaption, type CaptionInput } from '../share/shareCaption';
import { playSound } from '../sound/sound';
import { useApp, type Toast } from '../state/AppProvider';
import { streakAsOf, streakLabel, type Streak } from '../state/history';
import { scoreLine } from '../state/rivalScore';
import { REFUND_MS, WIN_MS, rektCloseDelay } from '../state/resultTiming';
import { C, FONT_CAP, GRAD, MONO } from '../theme';
import { PixelConfetti } from './Confetti';
import { Gradient } from './Gradient';
import { NeonButton } from './NeonButton';
import { PixelText } from './PixelText';
import { useReduceMotion } from './ArenaClock';

/** The result of one of my rounds: a full-screen win, a short rekt, or a small refund toast. */
export function ResultLayer({ toast, onClose, top }: { toast: Toast; onClose: () => void; top: number }) {
  if (toast.kind === 'won') return <WinOverlay key={toast.id} toast={toast} onClose={onClose} />;
  if (toast.kind === 'lost') return <RektOverlay key={toast.id} toast={toast} onClose={onClose} />;
  return <RefundToast key={toast.id} toast={toast} onClose={onClose} top={top} />;
}

/** While a result is on screen the Android back button closes it instead of leaving the app. */
function useBackToClose(onClose: () => void) {
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);
}

/** The run as it stood when this result came in: rounds up to this one only, so a result queued behind another does not count the rounds after it. */
function useScreenReader(): boolean {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isScreenReaderEnabled().then(value => { if (alive) setEnabled(value); }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setEnabled);
    return () => { alive = false; subscription.remove(); };
  }, []);
  return enabled;
}

function useStreak(toast: Toast): Streak {
  const { history } = useApp();
  return useMemo(() => streakAsOf(history, toast.roundId), [history, toast.roundId]);
}

/** The run as a headline ("3 IN A ROW", "LOST 2 IN A ROW"); null under two or of the other kind. */
function runLabel(streak: Streak, kind: 'win' | 'loss'): string | null {
  return streak.kind === kind ? streakLabel(streak) : null;
}

/** The score against the friend whose challenge opened the app ("YOU 3 : 1 oxbla"), with the data the share card needs; null without one. */
function useRivalScore(): { score: { you: number; them: number } | null; name: string | null; line: string | null } {
  const { challenge, rivalScore } = useApp();
  const by = challenge?.by ?? null;
  // Their Seeker ID without the .skr, else the plain word RIVAL.
  const name = useSkrNames(by ? [by] : []).get(by ?? '')?.replace(/\.skr$/, '') ?? null;
  return { score: rivalScore, name, line: rivalScore ? scoreLine(rivalScore, name) : null };
}

/** "x1.96" from the win fee of the round (its own account, else the arena config); null when neither is known. */
function useMultiplier(roundId: bigint): string | null {
  const { my, arena } = useApp();
  const fee =
    my.positions.find((p) => p.round?.id === roundId)?.round?.account.feeWinBps ??
    arena.rounds.find((r) => r.id === roundId)?.account.feeWinBps ??
    arena.config?.feeWinBps;
  return fee === undefined ? null : multiplierText(fee);
}

/** Counts up to `target` lamports in `ms` (bigint all the way, the last frame is exact). */
function useCountUp(target: bigint, ms: number): bigint {
  const reduced = useReduceMotion();
  const [value, setValue] = useState(0n);
  useEffect(() => {
    if (reduced) { setValue(target); return; }
    let frame = 0;
    const start = Date.now();
    const step = () => {
      const p = Math.min(1, (Date.now() - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(p >= 1 ? target : (target * BigInt(Math.round(eased * 10_000))) / 10_000n);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms, reduced]);
  return value;
}

/** Seconds until the open round's entry closes (or the next one opens), for the "next round" call to action. */
function useNextRoundCountdown(): { secondsLeft: number; opens: boolean } | null {
  const { arena, offsetSec } = useApp();
  const nowMs = useNow(500);
  const nowSec = chainNowSec(offsetSec, nowMs);
  const groups = classifyRounds(arena.rounds, Math.floor(nowSec));
  if (groups.open) return { secondsLeft: Number(groups.open.account.cutoffAt) - nowSec, opens: false };
  if (groups.upcoming) return { secondsLeft: Number(groups.upcoming.account.opensAt) - nowSec, opens: true };
  return null;
}

/** "+0.0196 SOL" counting up; its own component so only this text re-renders every frame. */
function CountUpSol({ lamports }: { lamports: bigint }) {
  const shown = useCountUp(lamports, 1_100);
  return <Text style={[styles.amount, { textShadowColor: C.neonGreen }]}>+{formatSol(shown)} SOL</Text>;
}

function ResultReceipt({ toast }: { toast: Toast }) {
  const { my, history } = useApp();
  const position = my.positions.find(p => p.round?.id === toast.roundId);
  const round = position?.round?.account;
  const stored = history.find(e => e.kind === 'stored' && e.roundId === toast.roundId);
  const accepted = round ? acceptedStake(round.rawUp, round.rawDown, toast.side as Side, toast.stake) : stored?.kind === 'stored' ? stored.record.accepted : null;
  return <Text style={{ color: C.text, fontSize: 12, textAlign: 'center' }}>Stake {formatSol(toast.stake)} · matched {accepted === null ? 'checking' : formatSol(accepted)} · unmatched back {accepted === null ? 'checking' : formatSol(toast.stake - accepted)}{ '\n' }Total return {formatSol(toast.payout)} SOL · net {formatSol(toast.payout - toast.stake, { sign: true })} SOL. Account rent returns separately.</Text>;
}

/**
 * "SAME CALL" and "FLIP IT": the same stake on the round open now, from the result overlay. Shown only
 * while chain/repeatBet.ts finds the bet one the arena would accept too; a tap places it with the device
 * key and goes to the arena.
 */
function RepeatButtons({ toast, onClose, onOffer }: { toast: Toast; onClose: () => void; /** Told whenever the offer appears or goes away. */ onOffer?: (shown: boolean) => void }) {
  const { arena, my, myReady, wallet, betting, pending, offsetSec, rpc, setTab } = useApp();
  const rents = useRents(rpc);
  const market = useMarketStatus();
  const nowMs = useNow(500);
  const owner = wallet.owner;
  const phase = betting.bet.phase;
  // Without the real position rent the balance check cannot be made: no offer.
  const offer =
    rents && owner
      ? canRepeatBet({
          rounds: arena.rounds,
          nowSec: chainNowSec(offsetSec, nowMs),
          nowMs,
          arenaUpdatedAt: arena.updatedAt,
          paused: (arena.config?.paused ?? false) || market?.phase === 'paused',
          owner,
          myReady,
          session: my.session,
          available: my.vault?.available ?? 0n,
          positionRent: rents.position,
          keyLamports: my.keyLamports,
          gasPerBet: SESSION_RULES.gasPerBet,
          holds: (roundId) => holdsPosition(roundId, owner, my.positions, arena.positions.get(roundId) ?? []),
          working: phase === 'signing' || phase === 'sending' || phase === 'confirming',
          pendingRoundId: pending?.roundId ?? null,
          side: toast.side,
          stake: toast.stake,
        })
      : null;
  const shown = offer?.ok === true;
  useEffect(() => {
    onOffer?.(shown);
    return () => onOffer?.(false);
  }, [shown, onOffer]);
  if (!offer?.ok) return null;
  const arrow = (side: number) => (side === Side.Up ? '▲' : '▼');
  const call = (side: Side) => {
    void betting.place(offer.roundId, side, offer.amount);
    setTab('arena');
    onClose();
  };
  const target = arena.rounds.find(r => r.id === offer.roundId);
  const token = target ? peekTokenInfo(target.account.tokenMint)?.symbol : null;
  const amount = `${formatSol(offer.amount)} SOL · ${token ? '$' + token : 'TOKEN/SOL'} · #${offer.roundId}`;
  return (
    <View style={styles.row}>
      {offer.sameFits ? (
        <NeonButton
          title={`SAME CALL ${arrow(offer.same)}`}
          subtitle={amount}
          kind={offer.same === Side.Up ? 'up' : 'down'}
          onPress={() => call(offer.same)}
          style={styles.flex}
        />
      ) : null}
      {offer.flipFits ? (
        <NeonButton
          title={`FLIP IT ${arrow(offer.flip)}`}
          subtitle={amount}
          kind={offer.flip === Side.Up ? 'up' : 'down'}
          onPress={() => call(offer.flip)}
          style={styles.flex}
        />
      ) : null}
    </View>
  );
}

function WinOverlay({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const reading = useScreenReader();
  const { face, setTab, my, wallet } = useApp();
  const myName = useSkrNames(wallet.owner ? [wallet.owner] : []).get(wallet.owner ?? '') ?? null;
  // The round is final first; the keeper's claim moves the money a few seconds later.
  const credited = my.positions.some((p) => p.round?.id === toast.roundId && p.account.claimed);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  // A short phone gets a smaller face and tighter gaps so the two button rows still fit.
  const compact = height < 700;
  const pop = useRef(new Animated.Value(0)).current;
  const reduced = useReduceMotion();
  const [sharing, setSharing] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const info = peekTokenInfo(toast.tokenMint);
  const logo = info?.imageUrl && !logoFailed ? info.imageUrl : null;
  const up = toast.side === Side.Up;
  const run = useStreak(toast);
  const streak = runLabel(run, 'win');
  const duel = useRivalScore();
  const multiplier = useMultiplier(toast.roundId);
  // How far the price moved from the start price to the exit: the "why" of the win.
  const move = useMemo(() => deltaView(toast.strike, toast.exit), [toast.strike, toast.exit]);
  const moveColor = move?.tone === 'up' ? C.neonGreen : move?.tone === 'down' ? C.neonRed : C.neonYellow;
  useBackToClose(onClose);

  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    playSound('win');
  }, []);
  useEffect(() => {
    if (reduced) { pop.stopAnimation(); pop.setValue(1); return; }
    const animation = Animated.spring(pop, { toValue: 1, friction: 4, tension: 120, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [pop, reduced]);

  // Leaves by itself after a while so a queued result is never stuck behind it.
  useEffect(() => {
    if (sharing || reading) return undefined;
    const t = setTimeout(onClose, WIN_MS);
    return () => clearTimeout(t);
  }, [sharing, reading, onClose]);

  const share = () => {
    setSharing(true);
    // The run and the score against the friend, when there are any, ride on the card and in the message.
    const caption: CaptionInput = { winStreak: run.kind === 'win' ? run.current : 0, score: duel.score, rivalName: duel.name };
    void shareCard(
      {
        kind: 'win',
        face,
        side: toast.side,
        roundId: toast.roundId,
        symbol: info?.symbol ?? null,
        imageUrl: info?.imageUrl ?? null,
        profit: toast.payout - toast.stake,
        name: myName,
        caption: pickCardCaption(caption),
      },
      toast.shareText + captionSuffix(caption),
      'Share your win',
    ).finally(() => setSharing(false));
  };

  const titleSize = Math.max(4, Math.min(7.5, (width - 40) / 44));
  // The run headline is smaller than the title and shrinks to fit a long one ("12 IN A ROW").
  const streakSize = streak ? Math.max(2.5, Math.min(5.5, (width - 32) / (streak.length * 6 + 2))) : 0;
  const seed = Number(toast.roundId % 997n);
  return (
    <View style={[styles.full, { paddingTop: insets.top + 24, paddingBottom: Math.max(36, insets.bottom + 16) }]}>
      <Gradient colors={GRAD.win} style={StyleSheet.absoluteFill} />
      {!reduced ? <PixelConfetti count={90} seed={seed} /> : null}
      {!reduced ? <PixelConfetti count={50} delayMs={600} seed={seed + 1} /> : null}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}><View style={[styles.center, compact && styles.centerCompact]}>
        <Animated.View style={[styles.faceRing, { borderColor: C.neonYellow, boxShadow: `0 0 24px ${C.neonYellow}` }, { transform: [{ scale: pop }] }]}>
          <PixelFace face={face} size={compact ? 104 : 150} expression="happy" />
        </Animated.View>
        <PixelText text="YOU WON" size={titleSize} color={C.neonYellow} glow={C.neonYellow} shadow="#a1157f" />
        {streak ? <PixelText text={streak} size={streakSize} color={C.neonPink} glow={C.neonPink} shadow="#3b0a52" /> : null}
        <CountUpSol lamports={toast.payout - toast.stake} />
        <ResultReceipt toast={toast} />
        {move ? (
          <Text style={[styles.move, { color: moveColor, textShadowColor: moveColor }]} maxFontSizeMultiplier={FONT_CAP}>
            {move.text} {move.arrow}
          </Text>
        ) : null}
        <Text style={styles.credit}>
          +{formatSol(toast.payout)} SOL in your balance ·{' '}
          <Text style={{ color: credited ? C.neonGreen : C.neonYellow }}>{credited ? 'CREDITED' : 'CREDITING...'}</Text>
        </Text>
        {duel.line ? <Text style={styles.duel}>{duel.line}</Text> : null}
        <View style={styles.metaRow}>
          {logo ? <Image source={{ uri: logo }} style={styles.coinLogo} onError={() => setLogoFailed(true)} accessibilityIgnoresInvertColors /> : null}
          {multiplier ? <Text style={styles.badge}>{multiplier}</Text> : null}
          <Text style={styles.meta}>
            <Text style={{ color: up ? C.neonGreen : C.neonRed }}>{up ? 'UP ▲' : 'DOWN ▼'}</Text>
            {info?.symbol ? ` · $${info.symbol}` : ''} · ROUND #{toast.roundId.toString()}
          </Text>
        </View>
      </View>
      <View style={styles.buttons}>
        <RepeatButtons toast={toast} onClose={onClose} />
        <View style={styles.row}>
          <NeonButton title="SHARE" kind="purple" busy={sharing} onPress={share} style={styles.flex} big />
          <NeonButton
            title="NEXT ROUND"
            kind="up"
            onPress={() => {
              setTab('arena');
              onClose();
            }}
            style={styles.flex}
            big
          />
        </View>
      </View></ScrollView>
    </View>
  );
}

/** NEXT ROUND on a rekt, with the seconds left to bet; its own component so the half-second clock does not redraw the whole overlay. */
function NextRoundButton({ onPress }: { onPress: () => void }) {
  const next = useNextRoundCountdown();
  return (
    <NeonButton
      title="NEXT ROUND"
      subtitle={next ? `${next.opens ? 'opens in' : 'bet by'} ${formatCountdown(next.secondsLeft)}` : undefined}
      kind="gold"
      big
      onPress={onPress}
      style={styles.flex}
    />
  );
}

function RektOverlay({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const reading = useScreenReader();
  const { face, setTab, toasts } = useApp();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const compact = height < 700;
  const shake = useRef(new Animated.Value(0)).current;
  const reduced = useReduceMotion();
  const lost = toast.stake - toast.payout;
  // A calm line about the run, not a mocking one.
  const streak = runLabel(useStreak(toast), 'loss');
  const duel = useRivalScore();
  useBackToClose(onClose);

  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    playSound('loss');
  }, []);
  useEffect(() => {
    if (reduced) { shake.stopAnimation(); shake.setValue(0); return; }
    const animation = Animated.sequence(
      [10, -10, 8, -8, 4, 0].map((toValue) => Animated.timing(shake, { toValue, duration: 60, easing: Easing.linear, useNativeDriver: true })),
    );
    animation.start();
    return () => animation.stop();
  }, [shake, reduced]);

  // Long enough to read the amount and the run, and held for as long as SAME CALL / FLIP IT is on it (the
  // offer takes itself away before entry closes); a result waiting behind this one does not wait for an offer.
  const [offerShown, setOfferShown] = useState(false);
  const queued = toasts.length > 1;
  const shownAt = useRef(Date.now());
  useEffect(() => {
    if (reading) return;
    const t = setTimeout(onClose, rektCloseDelay({ elapsedMs: Date.now() - shownAt.current, offerShown, queued }));
    return () => clearTimeout(t);
  }, [offerShown, queued, reading, onClose]);

  const nextRound = () => {
    setTab('arena');
    onClose();
  };
  // Not a screen-wide tap target: a thumb next to SAME CALL must never close the offer. Close is the X, Back, or NEXT ROUND.
  return (
    <View style={[styles.full, { paddingTop: insets.top + 24, paddingBottom: Math.max(36, insets.bottom + 16) }]}>
      <Gradient colors={GRAD.rekt} style={StyleSheet.absoluteFill} />
      <Pressable
        onPress={onClose}
        hitSlop={8}
        style={[styles.closeX, { top: insets.top + 8 }]}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <Text style={styles.closeXText}>X</Text>
      </Pressable>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}><View style={[styles.center, compact && styles.centerCompact]}>
        <Animated.View style={[styles.faceRing, { borderColor: C.neonRed, boxShadow: `0 0 18px ${C.neonRed}` }, { transform: [{ translateX: shake }] }]}>
          <PixelFace face={face} size={compact ? 88 : 112} expression="sad" />
        </Animated.View>
        <PixelText text="REKT" size={9} color={C.neonRed} glow={C.neonRed} shadow="#3a0614" />
        {lost > 0n ? <Text style={[styles.lost, { textShadowColor: C.neonRed }]}>-{formatSol(lost)} SOL</Text> : null}
        <ResultReceipt toast={toast} />
        <Text style={styles.meta}>ROUND #{toast.roundId.toString()} WENT {toast.label}</Text>
        {streak ? <Text style={styles.calm}>{streak}</Text> : null}
        {duel.line ? <Text style={styles.duel}>{duel.line}</Text> : null}
      </View>
      <View style={styles.buttons}>
        <RepeatButtons toast={toast} onClose={onClose} onOffer={setOfferShown} />
        <View style={styles.row}>
          <NextRoundButton onPress={nextRound} />
        </View>
      </View></ScrollView>
    </View>
  );
}

function RefundToast({ toast, onClose, top }: { toast: Toast; onClose: () => void; top: number }) {
  const reading = useScreenReader();
  const slide = useRef(new Animated.Value(0)).current;
  const reduced = useReduceMotion();
  useBackToClose(onClose);
  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (reduced) slide.setValue(1);
    else Animated.spring(slide, { toValue: 1, friction: 7, useNativeDriver: true }).start();
    return () => slide.stopAnimation();
  }, [slide, reduced]);
  useEffect(() => {
    if (reading) return;
    const t = setTimeout(onClose, REFUND_MS);
    return () => clearTimeout(t);
  }, [reading, onClose]);
  const translateY = useMemo(() => slide.interpolate({ inputRange: [0, 1], outputRange: [-80, 0] }), [slide]);
  return (
    <Animated.View style={[styles.toastWrap, { top, transform: [{ translateY }] }]} pointerEvents="box-none">
      <Pressable onPress={onClose} style={styles.toast} accessibilityRole="button" accessibilityLabel={`${toast.title}. ${toast.body}. Dismiss result`}>
        <Text style={styles.toastTitle}>{toast.title}</Text>
        <Text style={styles.toastAmount}>{toast.body}</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // The top and bottom padding come from the safe area insets (set where the overlay renders).
  full: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100, elevation: 100 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 16 },
  centerCompact: { gap: 8 },
  faceRing: { borderWidth: 3, padding: 4, backgroundColor: '#1b1233' },
  amount: {
    color: C.neonGreen,
    fontSize: 42,
    fontWeight: '900',
    fontFamily: MONO,
    textShadowRadius: 16,
    textShadowOffset: { width: 0, height: 0 },
  },
  lost: {
    color: C.neonRed,
    fontSize: 30,
    fontWeight: '900',
    fontFamily: MONO,
    textShadowRadius: 12,
    textShadowOffset: { width: 0, height: 0 },
  },
  meta: { color: C.text, fontSize: 14, fontWeight: '900', fontFamily: MONO, textAlign: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8 },
  // The same look as the x1.96 badge on the UP and DOWN buttons.
  badge: {
    color: C.neonYellow,
    fontSize: 13,
    fontWeight: '900',
    fontFamily: MONO,
    backgroundColor: C.bg,
    borderWidth: 1,
    borderColor: C.neonYellow,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  calm: { color: C.subtle, fontSize: 13, fontWeight: '800', fontFamily: MONO, textAlign: 'center' },
  // How far the price moved against the start price, right under the amount.
  move: { fontSize: 24, fontWeight: '900', fontFamily: MONO, textShadowRadius: 10, textShadowOffset: { width: 0, height: 0 } },
  // The score against the friend of a challenge.
  duel: { color: C.neonPink, fontSize: 14, fontWeight: '900', fontFamily: MONO, textAlign: 'center' },
  coinLogo: { width: 40, height: 40, borderWidth: 1, borderColor: C.border, backgroundColor: C.panel },
  closeX: {
    position: 'absolute',
    right: 14,
    zIndex: 2,
    width: 48,
    height: 48,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(16,13,31,0.6)',
  },
  closeXText: { color: C.text, fontSize: 15, fontWeight: '900', fontFamily: MONO },
  credit: { color: C.white, fontSize: 12, fontWeight: '800', fontFamily: MONO, textAlign: 'center', opacity: 0.9 },
  buttons: { gap: 10, paddingHorizontal: 16 },
  row: { flexDirection: 'row', gap: 12 },
  flex: { flex: 1 },
  toastWrap: { position: 'absolute', left: 12, right: 12, zIndex: 100, elevation: 100 },
  toast: {
    backgroundColor: '#211a3a',
    borderWidth: 2,
    borderColor: C.neonYellow,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    boxShadow: `0 0 12px ${C.neonYellow}66`,
  },
  toastTitle: { color: C.neonYellow, fontSize: 14, fontWeight: '900', flexShrink: 1 },
  toastAmount: { color: C.white, fontSize: 13, fontWeight: '900', fontFamily: MONO },
});
