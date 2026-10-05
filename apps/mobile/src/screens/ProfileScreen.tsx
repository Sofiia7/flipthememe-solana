import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { RoundStatus } from '@flipthememe/client';
import {
  ACCESSORY_NAMES,
  EYE_NAMES,
  FACE_OPTIONS,
  HAIR_COLOR_NAMES,
  HAIR_STYLE_NAMES,
  MOUTH_NAMES,
  SKIN_NAMES,
  randomFace,
  type Face,
  type FaceField,
} from '../face/faceModel';
import { positionResult } from '../chain/phase';
import { chainNowSec } from '../chain/useChainClock';
import { formatSol, shortAddress } from '../lib/format';
import { chatterOn, soundMuted, useBoolStore } from '../lib/prefs';
import { PixelFace } from '../PixelFace';
import { useSkrNames } from '../chain/skr';
import { playSound } from '../sound/sound';
import { useApp } from '../state/AppProvider';
import { C, MONO, T } from '../theme';
import { Btn, KV } from '../ui/common';

const FIELDS: { field: FaceField; title: string; names: readonly string[] }[] = [
  { field: 'skin', title: 'SKIN', names: SKIN_NAMES },
  { field: 'hairStyle', title: 'HAIR', names: HAIR_STYLE_NAMES },
  { field: 'hairColor', title: 'HAIR COLOUR', names: HAIR_COLOR_NAMES },
  { field: 'eyes', title: 'EYES', names: EYE_NAMES },
  { field: 'mouth', title: 'MOUTH', names: MOUTH_NAMES },
  { field: 'accessory', title: 'ACCESSORY', names: ACCESSORY_NAMES },
];

function Toggle({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.toggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
    >
      <Text style={styles.toggleLabel}>{label}</Text>
      <Text style={[styles.togglePill, on ? styles.toggleOn : styles.toggleOff]}>{on ? 'ON' : 'OFF'}</Text>
    </Pressable>
  );
}

export function ProfileScreen() {
  const { face, setFace, wallet, my, myReady, offsetSec } = useApp();
  const myName = useSkrNames(wallet.owner ? [wallet.owner] : []).get(wallet.owner ?? '') ?? null;
  const muted = useBoolStore(soundMuted);
  const chatter = useBoolStore(chatterOn);
  const stats = useMemo(() => {
    const now = chainNowSec(offsetSec);
    let wins = 0;
    let losses = 0;
    let refunds = 0;
    let open = 0;
    let staked = 0n;
    let returned = 0n;
    for (const p of my.positions) {
      if (!p.round) continue;
      if (p.round.account.status !== RoundStatus.Final) {
        open++;
        continue;
      }
      const r = positionResult(p.account, p.round.account, now);
      if (r.kind === 'won') wins++;
      else if (r.kind === 'lost') losses++;
      else refunds++;
      staked += p.account.stake;
      returned += r.payout ?? 0n;
    }
    return { rounds: my.positions.length, wins, losses, refunds, open, net: returned - staked };
  }, [my.positions, offsetSec]);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={T.h1}>Profile</Text>
      <View style={styles.hero}>
        <PixelFace face={face} size={112} />
        <View style={styles.heroText}>
          <Text style={styles.name}>{wallet.owner ? (myName ?? shortAddress(wallet.owner)) : 'Not connected'}</Text>
          {myName && wallet.owner ? <Text style={styles.bytes}>{shortAddress(wallet.owner)} · Seeker ID</Text> : null}
          <Text style={T.subtle}>Your face and Seeker ID name show next to every bet you make.</Text>
          <Btn small kind="ghost" title="RANDOMIZE" onPress={() => setFace(randomFace())} />
        </View>
      </View>

      <View style={styles.toggles}>
        <Toggle
          label="SOUND"
          on={!muted.value}
          onPress={() => {
            soundMuted.toggle();
            if (!soundMuted.get()) playSound('bet');
          }}
        />
        <Toggle label="LIVE CHATTER FROM X" on={chatter.value} onPress={() => chatterOn.toggle()} />
      </View>

      {FIELDS.map(({ field, title, names }) => (
        <View key={field} style={styles.field}>
          <Text style={T.label}>
            {title} • {names[face[field]] ?? ''}
          </Text>
          <View style={styles.options}>
            {Array.from({ length: FACE_OPTIONS[field] }, (_, value) => {
              const option: Face = { ...face, [field]: value };
              const selected = face[field] === value;
              return (
                <Pressable
                  key={value}
                  accessibilityLabel={`${title} ${names[value] ?? value}`}
                  onPress={() => setFace(option)}
                  style={[styles.option, selected && styles.optionSelected]}
                >
                  <PixelFace face={option} size={40} />
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      <Text style={T.dim}>Saved on this phone. Heads only, crisp pixels; the same face shows in the arena and in your results.</Text>

      <View style={T.panel}>
        <Text style={T.label}>STATS (DEVNET)</Text>
        {wallet.owner ? (
          myReady ? (
            <>
              <KV k="Rounds played" v={`${stats.rounds}${stats.open ? ` (${stats.open} in play)` : ''}`} />
              <KV k="Wins" v={`${stats.wins}`} tone="up" />
              <KV k="Losses" v={`${stats.losses}`} tone="down" />
              <KV k="Refunds" v={`${stats.refunds}`} tone="gold" />
              <KV k="Net (finished rounds)" v={`${formatSol(stats.net, { sign: true })} SOL`} tone={stats.net >= 0n ? 'up' : 'down'} />
            </>
          ) : (
            <Text style={T.subtle}>Loading...</Text>
          )
        ) : (
          <Text style={T.subtle}>Connect a wallet to see your rounds, wins and net SOL.</Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14, paddingBottom: 28 },
  hero: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  heroText: { flex: 1, gap: 6 },
  name: { color: C.white, fontFamily: MONO, fontWeight: '900', fontSize: 15 },
  bytes: { color: C.dim, fontFamily: MONO, fontSize: 10 },
  field: { gap: 6 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  option: { borderWidth: 2, borderColor: 'transparent', padding: 1 },
  optionSelected: { borderColor: C.accent },
  toggles: { gap: 8 },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.panel,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  toggleLabel: { color: C.white, fontSize: 13, fontWeight: '900', fontFamily: MONO },
  togglePill: { fontSize: 12, fontWeight: '900', fontFamily: MONO, paddingHorizontal: 10, paddingVertical: 3, borderWidth: 2, minWidth: 54, textAlign: 'center' },
  toggleOn: { color: C.bg, backgroundColor: C.neonGreen, borderColor: C.neonGreen },
  toggleOff: { color: C.subtle, borderColor: C.border },
});
