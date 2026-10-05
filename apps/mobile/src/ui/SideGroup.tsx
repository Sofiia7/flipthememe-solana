import { StyleSheet, Text, View } from 'react-native';
import { Side } from '@flipthememe/client';
import type { PositionView } from '../chain/fetch';
import { faceFromBytes } from '../face/faceModel';
import { HouseFace, PixelFace } from '../PixelFace';
import { formatSol, shortAddress } from '../lib/format';
import { C, MONO } from '../theme';

const MAX_ROWS = 4;

/** One side of the open round: total and players as rows (face + short address + amount). */
export function SideGroup({
  side,
  total,
  positions,
  me,
  highlight,
}: {
  side: number;
  total: bigint;
  positions: readonly PositionView[];
  me: string | null;
  highlight: boolean;
}) {
  const up = side === Side.Up;
  // Mine first, then by stake (already sorted by stake).
  const sorted = [...positions].sort((a, b) => Number(b.account.authority === me) - Number(a.account.authority === me));
  const shown = sorted.slice(0, MAX_ROWS);
  const more = sorted.length - shown.length;
  return (
    <View style={[styles.box, highlight && (up ? styles.boxUp : styles.boxDown)]}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: up ? C.up : C.down }]}>{up ? 'UP' : 'DOWN'}</Text>
        <Text style={styles.total}>{formatSol(total)} SOL</Text>
      </View>
      {shown.length === 0 ? <Text style={styles.empty}>No players yet</Text> : null}
      {shown.map((p) => {
        const mine = me !== null && p.account.authority === me;
        const house = p.account.isHouse;
        return (
          <View key={p.address} style={[styles.player, mine && styles.mine]}>
            {house ? <HouseFace size={24} /> : <PixelFace face={faceFromBytes(p.account.face)} size={24} />}
            <Text style={[styles.name, house && styles.house, mine && styles.me]} numberOfLines={1}>
              {house ? 'HOUSE' : mine ? 'YOU' : shortAddress(p.account.authority, 4)}
            </Text>
            <Text style={[styles.amount, { color: up ? C.up : C.down }]}>{formatSol(p.account.stake)}</Text>
          </View>
        );
      })}
      {more > 0 ? <Text style={styles.more}>+{more} more</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, borderWidth: 1, borderColor: C.border, backgroundColor: C.panel, padding: 8, gap: 6, minHeight: 92 },
  boxUp: { borderColor: C.up },
  boxDown: { borderColor: C.down },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  title: { fontSize: 16, fontWeight: '900' },
  total: { color: C.white, fontFamily: MONO, fontWeight: '800', fontSize: 12 },
  empty: { color: C.dim, fontSize: 10 },
  player: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mine: { backgroundColor: C.panelMine, marginHorizontal: -4, paddingHorizontal: 4, paddingVertical: 1 },
  name: { color: C.text, fontSize: 10, flex: 1, fontFamily: MONO },
  me: { color: C.white, fontWeight: '900' },
  house: { color: C.house, fontWeight: '900' },
  amount: { fontFamily: MONO, fontSize: 10, fontWeight: '800' },
  more: { color: C.subtle, fontSize: 10 },
});
