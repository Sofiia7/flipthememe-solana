import { readFileSync } from 'node:fs';
import { replay, contribution, spotMoveEstimate } from '../src/economics.ts';
const [mode, file] = process.argv.slice(2);
if (!file || !['replay', 'business', 'attack'].includes(mode)) throw new Error('Usage: node services/keeper/scripts/research.ts replay|business|attack input.json[l]');
const raw = readFileSync(file, 'utf8');
const data = mode === 'replay' ? raw.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(raw);
const result = mode === 'replay' ? replay(data) : mode === 'business' ? data.map((s: any) => ({ name: s.name, ...contribution(s) })) : data.map((s: any) => ({ name: s.name, ...spotMoveEstimate(s.quoteReserve, s.relativeMove, s.swapFee) }));
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
