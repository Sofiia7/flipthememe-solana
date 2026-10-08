import { RoundStatus, Side, type RoundAccount } from '@flipthememe/client';
import { formatCountdown } from '../lib/format.ts';

export function roundProgress(a: Pick<RoundAccount, 'cutoffAt' | 'strikeStart' | 'strikeEnd' | 'exitStart' | 'exitEnd' | 'strikePrice' | 'status'>, side: number, now: number) {
  const up = side === Side.Up;
  const base = {
    side: up ? 'UP' : 'DOWN',
    rule: `${up ? 'UP' : 'DOWN'} wins if the final average price is ${up ? 'above' : 'below'} the reference price. Equal prices mean a refund.`,
  };
  if (a.status === RoundStatus.Final) return { ...base, title: 'ROUND FINISHED', detail: 'The result is in History. This chart may already show a different round.' };
  if (now < Number(a.cutoffAt)) return { ...base, title: 'BET ACCEPTED', detail: `Entry closes in ${formatCountdown(Number(a.cutoffAt) - now)}. Your bet is saved; the reference price is measured after entry closes.` };
  if (now >= Number(a.exitEnd)) return { ...base, title: 'CONFIRMING RESULT', detail: 'Price measurement is over. Waiting for the result on Solana; later chart movements do not change it.' };
  if (a.strikePrice <= 0n || a.status === RoundStatus.Open) {
    if (now < Number(a.strikeStart)) return { ...base, title: 'WAITING TO START', detail: `Your bet is saved. In ${formatCountdown(Number(a.strikeStart) - now)} we begin measuring the reference price: the line your ${base.side} bet must beat.` };
    if (now < Number(a.strikeEnd)) return { ...base, title: 'MEASURING REFERENCE', detail: `Averaging the starting price for ${formatCountdown(Number(a.strikeEnd) - now)} more. The yellow chart band marks this measurement.` };
    return { ...base, title: 'CONFIRMING REFERENCE', detail: 'The starting price has been measured. Waiting for its reference line to appear on Solana.' };
  }
  if (now >= Number(a.exitStart)) return { ...base, title: 'MEASURING FINAL PRICE', detail: `Averaging the final price for ${formatCountdown(Number(a.exitEnd) - now)} more. This average decides the winner, not the last chart dot.` };
  return { ...base, title: 'YOUR ROUND IS LIVE', detail: `The yellow line is your reference price. Final price measurement starts in ${formatCountdown(Number(a.exitStart) - now)}. The lead can still change.` };
}
