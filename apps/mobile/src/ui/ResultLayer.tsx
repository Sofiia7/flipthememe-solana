import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, BackHandler, Easing, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Side } from '@flipthememe/client';
import { classifyRounds } from '../chain/phase';
import { useRents } from '../chain/rent';
import { canRepeatBet, holdsPosition, multiplierText } from '../chain/repeatBet';
import { chainNowSec } from '../chain/useChainClock';
import { useSkrNames } from '../chain/skr';
import { peekTokenInfo } from '../chain/useTokenInfo';
import { SESSION_RULES } from '../config';
import { formatCountdown, formatSol } from '../lib/format';
import { useNow } from '../lib/usePolling';
import { PixelFace } from '../PixelFace';
import { shareCard } from '../share/ShareCard';
import { playSound } from '../sound/sound';
import { useApp, type Toast } from '../state/AppProvider';
import { streakAsOf, streakLabel } from '../state/history';
import { C, GRAD, MONO } from '../theme';
import { PixelConfetti } from './Confetti';
import { Gradient } from './Gradient';
import { NeonButton } from './NeonButton';
import { PixelText } from './PixelText';

/** The result of one of my rounds: a full-screen win, a short rekt, or a small refund toast. */
export function ResultLayer({ toast, onClose, top }: { toast: Toast; onClose: () => void; top: number }) {
  if (toast.kind === 'won') return <WinOverlay key={toast.id} toast={toast} onClose={onClose} />;
  if (toast.kind === 'lost') return <RektOverlay key={toast.id} toast={toast} onClose={onClose} />;
  return <RefundToast key={toast.id} toast={toast} onClose={onClose} top={top} />;
}

/** A win stays up to 20 s (a queued result is never stuck behind it); a rekt long enough to read the amount and the run. */
const WIN_MS = 20_000;
const REKT_MS = 6_000;
const REFUND_MS = 4_000;

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

/** The run this result belongs to as a headline ("3 IN A ROW", "LOST 2 IN A ROW"); null under two or of the other kind. */
function useStreakLabel(toast: Toast, kind: 'win' | 'loss'): string | null {
  const { history } = useApp();
  return useMemo(() => {
    // Rounds up to this one only: a result queued behind another must not count the rounds after it.
    const streak = streakAsOf(history, toast.roundId);
    return streak.kind === kind ? streakLabel(streak) : null;
  }, [history, toast.roundId, kind]);
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
  const [value, setValue] = useState(0n);
  useEffect(() => {
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
  }, [target, ms]);
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

/**
 * "SAME CALL" and "FLIP IT": the same stake on the round open now, from the result overlay. Shown only
 * while chain/repeatBet.ts finds the bet one the arena would accept too; a tap places it with the device
 * key and goes to the arena.
 */
function RepeatButtons({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const { arena, my, myReady, wallet, betting, pending, offsetSec, rpc, setTab } = useApp();
  const rents = useRents(rpc);
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
          paused: arena.config?.paused ?? false,
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
  if (!offer?.ok) return null;
  const arrow = (side: number) => (side === Side.Up ? '▲' : '▼');
  const call = (side: Side) => {
    void betting.place(offer.roundId, side, offer.amount);
    setTab('arena');
    onClose();
  };
  const amount = `${formatSol(offer.amount)} SOL`;
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
  const { face, setTab, my, wallet } = useApp();
  const myName = useSkrNames(wallet.owner ? [wallet.owner] : []).get(wallet.owner ?? '') ?? null;
  // The round is final first; the keeper's claim moves the money a few seconds later.
  const credited = my.positions.some((p) => p.round?.id === toast.roundId && p.account.claimed);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  // A short phone gets a smaller face and tighter gaps so the two button rows still fit.
  const compact = height < 700;
  const pop = useRef(new Animated.Value(0)).current;
  const [sharing, setSharing] = useState(false);
  const info = peekTokenInfo(toast.tokenMint);
  const up = toast.side === Side.Up;
  const streak = useStreakLabel(toast, 'win');
  const multiplier = useMultiplier(toast.roundId);
  useBackToClose(onClose);

  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    playSound('win');
    Animated.spring(pop, { toValue: 1, friction: 4, tension: 120, useNativeDriver: true }).start();
  }, [pop]);

  // Leaves by itself after a while so a queued result is never stuck behind it.
  useEffect(() => {
    if (sharing) return undefined;
    const t = setTimeout(onClose, WIN_MS);
    return () => clearTimeout(t);
  }, [sharing, onClose]);

  const share = () => {
    setSharing(true);
    void shareCard(
      { kind: 'win', face, side: toast.side, roundId: toast.roundId, symbol: info?.symbol ?? null, imageUrl: info?.imageUrl ?? null, profit: toast.payout - toast.stake, name: myName },
      toast.shareText,
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
      <PixelConfetti count={90} seed={seed} />
      <PixelConfetti count={50} delayMs={600} seed={seed + 1} />
      <View style={[styles.center, compact && styles.centerCompact]}>
        <Animated.View style={[styles.faceRing, { borderColor: C.neonYellow, boxShadow: `0 0 24px ${C.neonYellow}` }, { transform: [{ scale: pop }] }]}>
          <PixelFace face={face} size={compact ? 104 : 150} expression="happy" />
        </Animated.View>
        <PixelText text="YOU WON" size={titleSize} color={C.neonYellow} glow={C.neonYellow} shadow="#a1157f" />
        {streak ? <PixelText text={streak} size={streakSize} color={C.neonPink} glow={C.neonPink} shadow="#3b0a52" /> : null}
        <CountUpSol lamports={toast.payout - toast.stake} />
        <Text style={styles.credit}>
          {formatSol(toast.payout)} SOL to your balance, stake included ·{' '}
          <Text style={{ color: credited ? C.neonGreen : C.neonYellow }}>{credited ? 'CREDITED' : 'CREDITING...'}</Text>
        </Text>
        <View style={styles.metaRow}>
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
      </View>
    </View>
  );
}

function RektOverlay({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const { face, setTab } = useApp();
  const next = useNextRoundCountdown();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const compact = height < 700;
  const shake = useRef(new Animated.Value(0)).current;
  const lost = toast.stake - toast.payout;
  // A calm line about the run, not a mocking one.
  const streak = useStreakLabel(toast, 'loss');
  useBackToClose(onClose);

  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    playSound('loss');
    Animated.sequence(
      [10, -10, 8, -8, 4, 0].map((toValue) => Animated.timing(shake, { toValue, duration: 60, easing: Easing.linear, useNativeDriver: true })),
    ).start();
  }, [shake]);

  // Long enough to read the amount and the run; a tap closes it sooner.
  useEffect(() => {
    const t = setTimeout(onClose, REKT_MS);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <Pressable
      style={[styles.full, { paddingTop: insets.top + 24, paddingBottom: Math.max(36, insets.bottom + 16) }]}
      onPress={onClose}
      accessibilityLabel="Close"
    >
      <Gradient colors={GRAD.rekt} style={StyleSheet.absoluteFill} />
      <View style={[styles.center, compact && styles.centerCompact]}>
        <Animated.View style={[styles.faceRing, { borderColor: C.neonRed, boxShadow: `0 0 18px ${C.neonRed}` }, { transform: [{ translateX: shake }] }]}>
          <PixelFace face={face} size={compact ? 88 : 112} expression="sad" />
        </Animated.View>
        <PixelText text="REKT" size={9} color={C.neonRed} glow={C.neonRed} shadow="#3a0614" />
        {lost > 0n ? <Text style={[styles.lost, { textShadowColor: C.neonRed }]}>-{formatSol(lost)} SOL</Text> : null}
        <Text style={styles.meta}>ROUND #{toast.roundId.toString()} WENT {toast.label}</Text>
        {streak ? <Text style={styles.calm}>{streak}</Text> : null}
      </View>
      <View style={styles.buttons}>
        <RepeatButtons toast={toast} onClose={onClose} />
        <View style={styles.row}>
          <NeonButton
            title="NEXT ROUND"
            subtitle={next ? `${next.opens ? 'opens in' : 'entry closes in'} ${formatCountdown(next.secondsLeft)}` : undefined}
            kind="gold"
            big
            onPress={() => {
              setTab('arena');
              onClose();
            }}
            style={styles.flex}
          />
        </View>
      </View>
    </Pressable>
  );
}

function RefundToast({ toast, onClose, top }: { toast: Toast; onClose: () => void; top: number }) {
  const slide = useRef(new Animated.Value(0)).current;
  useBackToClose(onClose);
  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    Animated.spring(slide, { toValue: 1, friction: 7, useNativeDriver: true }).start();
    const t = setTimeout(onClose, REFUND_MS);
    return () => clearTimeout(t);
  }, [slide, onClose]);
  const translateY = useMemo(() => slide.interpolate({ inputRange: [0, 1], outputRange: [-80, 0] }), [slide]);
  return (
    <Animated.View style={[styles.toastWrap, { top, transform: [{ translateY }] }]} pointerEvents="box-none">
      <Pressable onPress={onClose} style={styles.toast} accessibilityRole="button">
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
