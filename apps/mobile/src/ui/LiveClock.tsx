// The parts of the arena that tick twice a second, each in its own small component: the big timer with its
// move against the strike, and the countdown ticks of the last five seconds. The arena screen itself
// re-renders once a second (and on data), so the chart and the panels no longer redraw every half second.
import { useEffect } from 'react';
import * as Haptics from 'expo-haptics';
import { entryTick, type TimerView } from '../chain/phase';
import { chainNowSec } from '../chain/useChainClock';
import { useNow } from '../lib/usePolling';
import { playSound } from '../sound/sound';
import { ArenaClock, type ClockSide } from './ArenaClock';

/** What the big clock shows at one moment: its timer and the move readout next to it. */
export type ClockView = { timer: TimerView; side: ClockSide };

/** The arena's one big timer. `at` computes the view for a local time; it is called twice a second, here only. */
export function LiveClock({ at }: { at: (nowMs: number) => ClockView }) {
  const nowMs = useNow(500);
  const { timer, side } = at(nowMs);
  return <ArenaClock timer={timer} side={side} />;
}

/**
 * Sound and a light haptic tick on each of the last five seconds before the open round's entry closes.
 * Renders nothing; `active` is false for a visitor, while betting is paused, and when no round is open.
 */
export function EntryTicker({ cutoffAt, offsetSec, active, roundId }: { cutoffAt: bigint | null; offsetSec: number; active: boolean; roundId: bigint | null }) {
  const nowMs = useNow(500);
  const tick = active && cutoffAt !== null ? entryTick(Number(cutoffAt) - chainNowSec(offsetSec, nowMs)) : null;
  useEffect(() => {
    if (tick === null) return;
    playSound('tick');
    void Haptics.selectionAsync().catch(() => undefined);
  }, [tick, roundId]);
  return null;
}
