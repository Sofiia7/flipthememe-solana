import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Side } from '@flipthememe/client';
import { classifyRounds } from '../chain/phase';
import { chainNowSec } from '../chain/useChainClock';
import { peekTokenInfo } from '../chain/useTokenInfo';
import { formatCountdown, formatSol } from '../lib/format';
import { useNow } from '../lib/usePolling';
import { PixelFace } from '../PixelFace';
import { shareCard } from '../share/ShareCard';
import { playSound } from '../sound/sound';
import { useApp, type Toast } from '../state/AppProvider';
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

function WinOverlay({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const { face, setTab, my } = useApp();
  // The round is final first; the keeper's claim moves the money a few seconds later.
  const credited = my.positions.some((p) => p.round?.id === toast.roundId && p.account.claimed);
  const { width } = useWindowDimensions();
  const pop = useRef(new Animated.Value(0)).current;
  const [sharing, setSharing] = useState(false);
  const info = peekTokenInfo(toast.tokenMint);
  const up = toast.side === Side.Up;

  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    playSound('win');
    Animated.spring(pop, { toValue: 1, friction: 4, tension: 120, useNativeDriver: true }).start();
  }, [pop]);

  // Leaves by itself after a while so a queued result is never stuck behind it.
  useEffect(() => {
    if (sharing) return undefined;
    const t = setTimeout(onClose, 20_000);
    return () => clearTimeout(t);
  }, [sharing, onClose]);

  const share = () => {
    setSharing(true);
    void shareCard(
      { kind: 'win', face, side: toast.side, roundId: toast.roundId, symbol: info?.symbol ?? null, imageUrl: info?.imageUrl ?? null, profit: toast.payout - toast.stake },
      toast.shareText,
      'Share your win',
    ).finally(() => setSharing(false));
  };

  const titleSize = Math.max(4, Math.min(7.5, (width - 40) / 44));
  return (
    <View style={styles.full}>
      <Gradient colors={GRAD.win} style={StyleSheet.absoluteFill} />
      <PixelConfetti seed={Number(toast.roundId % 997n)} />
      <View style={styles.center}>
        <Animated.View style={[styles.faceRing, { borderColor: C.neonYellow, boxShadow: `0 0 24px ${C.neonYellow}` }, { transform: [{ scale: pop }] }]}>
          <PixelFace face={face} size={150} expression="happy" />
        </Animated.View>
        <PixelText text="YOU WON" size={titleSize} color={C.neonYellow} glow={C.neonYellow} shadow="#a1157f" />
        <CountUpSol lamports={toast.payout - toast.stake} />
        <Text style={styles.credit}>
          {formatSol(toast.payout)} SOL to your balance, stake included ·{' '}
          <Text style={{ color: credited ? C.neonGreen : C.neonYellow }}>{credited ? 'CREDITED' : 'CREDITING...'}</Text>
        </Text>
        <Text style={styles.meta}>
          <Text style={{ color: up ? C.neonGreen : C.neonRed }}>{up ? 'UP ▲' : 'DOWN ▼'}</Text>
          {info?.symbol ? ` · $${info.symbol}` : ''} · ROUND #{toast.roundId.toString()}
        </Text>
      </View>
      <View style={styles.buttons}>
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
  );
}

function RektOverlay({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const { face, setTab } = useApp();
  const next = useNextRoundCountdown();
  const shake = useRef(new Animated.Value(0)).current;
  const lost = toast.stake - toast.payout;

  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    playSound('loss');
    Animated.sequence(
      [10, -10, 8, -8, 4, 0].map((toValue) => Animated.timing(shake, { toValue, duration: 60, easing: Easing.linear, useNativeDriver: true })),
    ).start();
    const t = setTimeout(onClose, 3_200);
    return () => clearTimeout(t);
  }, [shake, onClose]);

  return (
    <Pressable style={styles.full} onPress={onClose} accessibilityLabel="Close">
      <Gradient colors={GRAD.rekt} style={StyleSheet.absoluteFill} />
      <View style={styles.center}>
        <Animated.View style={[styles.faceRing, { borderColor: C.neonRed, boxShadow: `0 0 18px ${C.neonRed}` }, { transform: [{ translateX: shake }] }]}>
          <PixelFace face={face} size={112} expression="sad" />
        </Animated.View>
        <PixelText text="REKT" size={9} color={C.neonRed} glow={C.neonRed} shadow="#3a0614" />
        {lost > 0n ? <Text style={[styles.lost, { textShadowColor: C.neonRed }]}>-{formatSol(lost)} SOL</Text> : null}
        <Text style={styles.meta}>ROUND #{toast.roundId.toString()} WENT {toast.label}</Text>
      </View>
      <View style={styles.buttons}>
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
    </Pressable>
  );
}

function RefundToast({ toast, onClose, top }: { toast: Toast; onClose: () => void; top: number }) {
  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    Animated.spring(slide, { toValue: 1, friction: 7, useNativeDriver: true }).start();
    const t = setTimeout(onClose, 4_000);
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
  full: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100, elevation: 100, paddingTop: 48, paddingBottom: 36 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 16 },
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
  credit: { color: C.white, fontSize: 12, fontWeight: '800', fontFamily: MONO, textAlign: 'center', opacity: 0.9 },
  buttons: { flexDirection: 'row', gap: 12, paddingHorizontal: 16 },
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
