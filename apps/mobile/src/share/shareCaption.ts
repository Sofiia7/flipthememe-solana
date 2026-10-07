// What the share card and its text say besides the amount: the run ("3 IN A ROW") and the score against
// the friend ("YOU 3 : 1 oxbla"), when there is data for them. Pure TypeScript (no React Native
// imports) for node:test.
import { scoreLine, type DuelScore } from '../state/rivalScore.ts';
import { streakLabel } from '../state/history.ts';

export type CaptionInput = {
  /** Wins in a row as of the shared round (0 or 1 when there is no run worth showing). */
  winStreak: number;
  /** Score against the rival of a challenge, null without data. */
  score: DuelScore | null;
  rivalName: string | null;
};

export type CardCaption = {
  /** The big line under the amount: the run, else the score, else nothing. */
  headline: string | null;
  /** The small line under it: the score, when the run took the headline. */
  sub: string | null;
};

/** The lines the card shows. Without a score only the run; without either, nothing extra. */
export function pickCardCaption(input: CaptionInput): CardCaption {
  const run = streakLabel({ current: input.winStreak, kind: 'win', best: input.winStreak });
  const score = input.score && input.score.you + input.score.them > 0 ? scoreLine(input.score, input.rivalName) : null;
  if (run) return { headline: run, sub: score };
  return { headline: score, sub: null };
}

/** The same facts for the message that travels with the picture: " 3 wins in a row. Score vs oxbla 3 : 1." */
export function captionSuffix(input: CaptionInput): string {
  const parts: string[] = [];
  if (input.winStreak >= 2) parts.push(`${input.winStreak} wins in a row.`);
  if (input.score && input.score.you + input.score.them > 0) {
    parts.push(`Score vs ${input.rivalName && input.rivalName.length > 0 ? input.rivalName : 'my rival'}: ${input.score.you} : ${input.score.them}.`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}
