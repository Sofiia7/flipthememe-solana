// Picture shares: a neon card is rendered off-screen, captured with react-native-view-shot
// and handed to the system share sheet by expo-sharing. Anything missing or failing falls back
// to a text share that carries the flipthememe://round/<id> deep link.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Image, Share, StyleSheet, Text, View } from 'react-native';
import { Side } from '@flipthememe/client';
import { type Face } from '../face/faceModel';
import { formatSol } from '../lib/format';
import { rnShareModule, sharingModule, viewShotModule } from '../lib/nativeOptional';
import { PixelFace } from '../PixelFace';
import { C, GRAD, MONO } from '../theme';
import { Gradient } from '../ui/Gradient';
import { PixelText } from '../ui/PixelText';

export type ShareCardData =
  | { kind: 'win'; face: Face; side: number; roundId: bigint; symbol: string | null; imageUrl: string | null; profit: bigint; name?: string | null }
  | { kind: 'challenge'; face: Face; side: number; roundId: bigint; symbol: string | null; imageUrl: string | null; name?: string | null };

export const CARD_W = 360;
export const CARD_H = 450;

function TokenMark({ symbol, imageUrl, onDone }: { symbol: string | null; imageUrl: string | null; onDone?: () => void }) {
  const [failed, setFailed] = useState(false);
  const letter = (symbol ?? '?').slice(0, 1).toUpperCase();
  if (imageUrl && !failed) {
    return (
      <Image
        source={{ uri: imageUrl }}
        style={styles.logo}
        onLoad={onDone}
        onError={() => {
          setFailed(true);
          onDone?.();
        }}
      />
    );
  }
  return (
    <View style={[styles.logo, styles.logoEmpty]}>
      <Text style={styles.logoLetter}>{letter}</Text>
    </View>
  );
}

/** The card itself (360 x 450 dp): face, headline, token, side, round and the brand line. */
export function ShareCard({ data, onImage }: { data: ShareCardData; onImage?: () => void }) {
  const up = data.side === Side.Up;
  const sideColor = up ? C.neonGreen : C.neonRed;
  const token = data.symbol ? `$${data.symbol}` : 'THE ARENA TOKEN';
  return (
    <Gradient colors={GRAD.card} style={styles.card}>
      <View style={[styles.frame, { borderColor: data.kind === 'win' ? C.neonYellow : sideColor }]} />
      <View style={styles.top}>
        <PixelText text="$FLIPTHEMEME" size={2} color={C.white} shadow={C.accent} />
        <Text style={styles.net}>DEVNET</Text>
      </View>
      <View style={styles.faceBox}>
        <View style={[styles.faceRing, { borderColor: data.kind === 'win' ? C.neonYellow : sideColor }]}>
          <PixelFace face={data.face} size={120} expression={data.kind === 'win' ? 'happy' : undefined} />
        </View>
        {data.name ? <Text style={styles.nick}>{data.name}</Text> : null}
      </View>
      {data.kind === 'win' ? (
        <View style={styles.center}>
          <PixelText text="I WON" size={6} color={C.neonYellow} glow={C.neonYellow} shadow="#a1157f" />
          <Text style={[styles.amount, { textShadowColor: C.neonGreen }]}>+{formatSol(data.profit)} SOL</Text>
          <View style={styles.tokenRow}>
            <Text style={styles.small}>CALLED</Text>
            <Text style={[styles.side, { color: sideColor }]}>{up ? 'UP ▲' : 'DOWN ▼'}</Text>
            <Text style={styles.small}>ON</Text>
            <TokenMark symbol={data.symbol} imageUrl={data.imageUrl} onDone={onImage} />
            <Text style={styles.token} numberOfLines={1}>
              {token}
            </Text>
          </View>
        </View>
      ) : (
        <View style={styles.center}>
          <PixelText text={up ? "I'M UP" : "I'M DOWN"} size={6} color={sideColor} glow={sideColor} shadow="#2a0b52" />
          <View style={styles.tokenRow}>
            <Text style={styles.small}>ON</Text>
            <TokenMark symbol={data.symbol} imageUrl={data.imageUrl} onDone={onImage} />
            <Text style={styles.token} numberOfLines={1}>
              {token}
            </Text>
          </View>
          <Text style={[styles.cta, { textShadowColor: C.neonPink }]}>TAKE THE OTHER SIDE</Text>
        </View>
      )}
      <View style={styles.bottom}>
        <Text style={styles.round}>ROUND #{data.roundId.toString()}</Text>
        <Text style={styles.brand}>FlipTheMeme · Solana devnet</Text>
      </View>
    </Gradient>
  );
}

// ---------------------------------------------------------------------------------------------
// Capture: one job at a time, rendered by <ShareCardHost /> (mounted once in the app shell).

type Job = { id: number; data: ShareCardData; resolve: (uri: string) => void; reject: (error: unknown) => void };
let job: Job | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

function finish(id: number, result: { uri: string } | { error: unknown }) {
  if (!job || job.id !== id) return;
  const done = job;
  job = null;
  emit();
  if ('uri' in result) done.resolve(result.uri);
  else done.reject(result.error);
}

function captureCard(data: ShareCardData): Promise<string> {
  return new Promise((resolve, reject) => {
    if (job) job.reject(new Error('replaced by a newer share'));
    const id = ++seq;
    job = { id, data, resolve, reject };
    emit();
    setTimeout(() => finish(id, { error: new Error('card capture timed out') }), 8_000);
  });
}

/** Renders the pending card off-screen and captures it once it (and the token logo) has drawn. */
export function ShareCardHost() {
  const current = useSyncExternalStore(subscribe, () => job);
  const ref = useRef<View>(null);
  // Readiness is kept per job id, so a layout event that lands before an effect can never be lost.
  const [laidOutId, setLaidOutId] = useState(0);
  const [imageDoneId, setImageDoneId] = useState(0);
  const id = current?.id ?? 0;
  const hasImage = !!current?.data.imageUrl;
  const ready = current !== null && laidOutId === id && (!hasImage || imageDoneId === id);

  useEffect(() => {
    if (!id || !hasImage) return undefined;
    // A slow logo never blocks the share: the card keeps its letter mark.
    const t = setTimeout(() => setImageDoneId(id), 1_500);
    return () => clearTimeout(t);
  }, [id, hasImage]);

  useEffect(() => {
    if (!ready || !current) return undefined;
    const shot = viewShotModule();
    if (!shot) {
      finish(current.id, { error: new Error('view-shot is not in this build') });
      return undefined;
    }
    // A short pause so the native views have drawn before the snapshot.
    const t = setTimeout(() => {
      shot
        .captureRef(ref, { format: 'png', result: 'tmpfile', fileName: `flipthememe-${current.data.roundId}` })
        .then((uri) => finish(current.id, { uri }))
        .catch((error: unknown) => finish(current.id, { error }));
    }, 150);
    return () => clearTimeout(t);
  }, [ready, current]);

  if (!current) return null;
  return (
    <View pointerEvents="none" style={styles.offscreen}>
      <View key={id} ref={ref} collapsable={false} style={{ width: CARD_W, height: CARD_H }} onLayout={() => setLaidOutId(id)}>
        <ShareCard data={current.data} onImage={() => setImageDoneId(id)} />
      </View>
    </View>
  );
}

let sharing = false;

/**
 * Shares the card as a PNG with `text` as its caption (messengers keep the round link that way).
 * Without the share module the image goes alone; on any failure `text` is shared instead.
 */
export async function shareCard(data: ShareCardData, text: string, dialogTitle: string): Promise<void> {
  if (sharing) return;
  sharing = true;
  const fallbackText = text;
  try {
    const rnShare = rnShareModule();
    const sharingApi = sharingModule();
    if ((!rnShare && !sharingApi) || !viewShotModule()) throw new Error('image sharing is not in this build');
    const uri = await captureCard(data);
    if (rnShare) {
      // failOnCancel off: closing the share sheet is not a failure, so no text share follows it.
      await rnShare.default.open({ url: uri, type: 'image/png', message: text, title: dialogTitle, failOnCancel: false });
    } else if (sharingApi) {
      await sharingApi.shareAsync(uri, { mimeType: 'image/png', dialogTitle });
    }
  } catch (error) {
    console.warn('[ftm] image share failed, sharing text', error);
    await Share.share({ message: fallbackText }).catch(() => undefined);
  } finally {
    sharing = false;
  }
}

const styles = StyleSheet.create({
  offscreen: { position: 'absolute', left: -10_000, top: 0, width: CARD_W, height: CARD_H },
  card: { width: CARD_W, height: CARD_H, padding: 18, justifyContent: 'space-between' },
  frame: { position: 'absolute', top: 8, left: 8, right: 8, bottom: 8, borderWidth: 3 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingTop: 4 },
  net: { color: C.neonYellow, fontSize: 11, fontWeight: '900', fontFamily: MONO, borderWidth: 1, borderColor: C.neonYellow, paddingHorizontal: 5 },
  faceBox: { alignItems: 'center', gap: 6 },
  nick: { color: C.accentText, fontSize: 14, fontWeight: '900', fontFamily: MONO, letterSpacing: 0.5 },
  faceRing: { borderWidth: 3, padding: 3, backgroundColor: '#1b1233' },
  center: { alignItems: 'center', gap: 8 },
  amount: {
    color: C.neonGreen,
    fontSize: 34,
    fontWeight: '900',
    fontFamily: MONO,
    textShadowRadius: 14,
    textShadowOffset: { width: 0, height: 0 },
  },
  tokenRow: { flexDirection: 'row', alignItems: 'center', gap: 7, maxWidth: CARD_W - 40 },
  small: { color: C.subtle, fontSize: 13, fontWeight: '900', fontFamily: MONO },
  side: { fontSize: 16, fontWeight: '900', fontFamily: MONO },
  logo: { width: 26, height: 26, borderWidth: 1, borderColor: C.border, backgroundColor: C.panel },
  logoEmpty: { alignItems: 'center', justifyContent: 'center' },
  logoLetter: { color: C.accentText, fontSize: 14, fontWeight: '900' },
  token: { color: C.white, fontSize: 20, fontWeight: '900', flexShrink: 1 },
  cta: {
    color: C.white,
    fontSize: 20,
    fontWeight: '900',
    fontFamily: MONO,
    letterSpacing: 1,
    textShadowRadius: 12,
    textShadowOffset: { width: 0, height: 0 },
  },
  bottom: { alignItems: 'center', gap: 3, paddingBottom: 4 },
  round: { color: C.white, fontSize: 15, fontWeight: '900', fontFamily: MONO, letterSpacing: 1 },
  brand: { color: C.accentText, fontSize: 12, fontWeight: '800' },
});
