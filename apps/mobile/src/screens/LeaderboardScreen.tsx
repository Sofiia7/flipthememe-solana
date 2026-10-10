import { PixelFace } from '../PixelFace';
import { faceFromBytes } from '../face/faceModel';
import { leaderboardFaceBytes } from '../lib/leaderboardFace';
import { useEffect, useState } from 'react';
import { ScrollView, Text, View, RefreshControl, StyleSheet } from 'react-native';
import { useApp } from '../state/AppProvider';
import { useSkrNames } from '../chain/skr';
import { C, T } from '../theme';
import { ScreenTitle } from '../ui/common';
import { formatSol, shortAddress } from '../lib/format';

type Player = { rank: number; owner: string; wins: number; losses: number; refunds: number; net: string; accuracy: number | null; face?: string };
type Board = { updatedAt: string; indexedAt?: string | null; coverageSince: string; period: string; directions?: { up: number; down: number; windowMinutes: number } | null; players: Player[] };
export function LeaderboardScreen() {
  const { wallet, face } = useApp();
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const names = useSkrNames(board?.players.map((p) => p.owner) ?? []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const load = async () => {
      setLoading(true);
      const timeout = setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await fetch('https://sol.flipthememe.com/v1/leaderboard', { signal: controller.signal });
        if (!response.ok) throw new Error('Leaderboard is temporarily unavailable. Pull to retry.');
        const data = await response.json() as Board;
        if (!Array.isArray(data.players)) throw new Error('Leaderboard is temporarily unavailable.');
        if (active) { setBoard(data); setError(''); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : 'Could not load leaderboard.'); }
      finally { clearTimeout(timeout); if (active) setLoading(false); }
    };
    void load();
    const interval = setInterval(() => setRefresh((n) => n + 1), 60_000);
    return () => { active = false; controller.abort(); clearInterval(interval); };
  }, [refresh]);
  const indexed = board?.indexedAt ? Date.parse(board.indexedAt) : NaN;
  const stale = board && (!Number.isFinite(indexed) || indexed > Date.now() + 30_000 || Date.now() - indexed > 10 * 60_000);
  return <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => setRefresh((n) => n + 1)} tintColor={C.accent} />}>
    <ScreenTitle text="LEADERBOARD" />
    <Text style={T.label}>LAST 7 DAYS · NET TEST SOL</Text>
    <Text style={T.subtle}>Players only. Ranked by returns minus stakes, after game fees. Network fees and account rent are excluded.</Text>
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {stale ? <Text style={styles.error}>Updates are delayed. Showing the last recorded results.</Text> : null}
    {board ? <Text style={T.dim}>Indexed {Number.isFinite(indexed) ? new Date(indexed).toLocaleTimeString() : 'not confirmed'} · tracking since {new Date(board.coverageSince).toLocaleDateString()}. Earlier closed bets may be missing.</Text> : null}
    {board?.directions ? <Text style={T.subtle}>Market sample, last {board.directions.windowMinutes} min: {board.directions.up} UP · {board.directions.down} DOWN. Outcomes are not guaranteed to be 50/50.</Text> : null}
    {board?.players.length === 0 ? <Text style={T.subtle}>No settled player bets yet.</Text> : null}
    {board?.players.map((p) => <View key={p.owner} style={[styles.row, p.owner === wallet.owner && styles.mine]}>
      <Text style={styles.rank}>#{p.rank}</Text>
      {p.owner === wallet.owner ? <PixelFace face={face} size={36} /> : leaderboardFaceBytes(p.face) ? <PixelFace face={faceFromBytes(leaderboardFaceBytes(p.face)!)} size={36} /> : <View style={styles.unknownFace}><Text style={styles.name}>?</Text></View>}
      <View style={styles.player}>
        <Text style={styles.name}>{names.get(p.owner) ?? shortAddress(p.owner)}{p.owner === wallet.owner ? ' · YOU' : ''}</Text>
        <Text style={T.subtle}>{p.wins} W · {p.losses} L · {p.refunds} refunds{p.accuracy === null ? '' : ` · ${p.accuracy}%`}</Text>
      </View><Text style={[styles.net, { color: BigInt(p.net) >= 0n ? C.up : C.down }]}>{formatSol(BigInt(p.net), { sign: true })}</Text>
    </View>)}
  </ScrollView>;
}
const styles = StyleSheet.create({
  content: { padding: 14, gap: 12, paddingBottom: 30 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border },
  mine: { borderColor: C.accent }, rank: { color: C.accent, fontWeight: '900', width: 34 },
  unknownFace: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  player: { flex: 1 }, name: { color: C.white, fontWeight: '800' }, net: { fontWeight: '900', fontSize: 13 }, error: { color: C.down },
});
