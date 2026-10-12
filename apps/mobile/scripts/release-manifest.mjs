import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
const [apk, output] = process.argv.slice(2);
if (!apk || !output || !process.env.GITHUB_SHA || !process.env.GITHUB_RUN_NUMBER) throw new Error('APK path, output and exact CI commit/build number are required');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
const sourcePaths = [...walk('programs/flip-the-meme'), 'Cargo.toml', 'Cargo.lock', 'Anchor.toml'].filter(p => !p.includes('/target/')).sort();
const programSourceFiles = Object.fromEntries(sourcePaths.map(p => [p, hash(p)]));
writeFileSync(output, JSON.stringify({ schema: 1, commit: process.env.GITHUB_SHA, versionCode: Number(process.env.GITHUB_RUN_NUMBER), apkSha256: hash(apk), sizeBytes: statSync(apk).size, package: 'com.flipthememe.app', network: 'solana:devnet', program: '5kUCKYAYxZyaSz18xEajhSDNwdXvVLp2AvBp4LDxWuCz', lockfileSha256: hash('pnpm-lock.yaml'), programSourceFiles, programSourceManifestSha256: createHash('sha256').update(JSON.stringify(programSourceFiles)).digest('hex'), deployedProgramVerification: 'Compare the verified program-build artifact with deployed bytes separately; APK build does not verify the current chain deployment.', priceProtocol: 'detached-canonical', physicalDeviceAcceptance: 'not attested by build workflow', buildUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` }, null, 2) + '\n');
