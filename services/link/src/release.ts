export type ReleaseMetadata = { version: string; publishedAt: string; sizeBytes: number; sha256: string | null; releaseUrl: string; apkUrl: string; manifestUrl: string | null };
/** Verified, publicly downloadable release; kept as an immutable fallback for GitHub API outages. */
export const PUBLISHED_RELEASE: ReleaseMetadata = {
  version: 'build-29', publishedAt: '2026-10-11T06:51:33Z', sizeBytes: 47_307_816,
  sha256: '3e421cb91393433e75c0b106a3e1a1336b4d4f0b42b8c8404d615664dcb6ce0a',
  releaseUrl: 'https://github.com/Sofiia7/flipthememe-apk/releases/tag/build-29',
  apkUrl: 'https://github.com/Sofiia7/flipthememe-apk/releases/download/build-29/FlipTheMeme.apk',
  manifestUrl: 'https://github.com/Sofiia7/flipthememe-apk/releases/download/build-29/release-manifest.json',
};
let cached: { until: number; body: ReleaseMetadata } | null = null;
/** Public metadata always describes the APK actually served by GitHub's latest release. */
export async function releaseInfo(fetcher: typeof fetch = fetch, fallback: ReleaseMetadata | null = null): Promise<Response> {
  if (fetcher === fetch && cached && cached.until > Date.now()) return Response.json(cached.body, { headers: { 'cache-control': 'public, max-age=300' } });
  try {
    const response = await fetcher('https://api.github.com/repos/Sofiia7/flipthememe-apk/releases/latest', { headers: { 'user-agent': 'FlipTheMeme-install', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error('unavailable');
    const release = await response.json() as { tag_name: string; published_at: string; html_url: string; assets: { name: string; size: number; digest?: string; browser_download_url: string }[] };
    const apk = release.assets.find(a => a.name === 'FlipTheMeme.apk');
    if (!apk) throw new Error('no apk');
    const download = (url: unknown): url is string => typeof url === 'string' && url.startsWith('https://github.com/Sofiia7/flipthememe-apk/releases/download/');
    if (typeof release.tag_name !== 'string' || !release.tag_name || release.tag_name.length > 100 || !Number.isFinite(Date.parse(release.published_at)) || !Number.isSafeInteger(apk.size) || apk.size <= 0 || apk.size > 1_000_000_000 || !download(apk.browser_download_url) || !release.html_url.startsWith('https://github.com/Sofiia7/flipthememe-apk/releases/tag/')) throw new Error('invalid metadata');
    const manifest = release.assets.find(a => a.name === 'release-manifest.json')?.browser_download_url;
    const body: ReleaseMetadata = { version: release.tag_name, publishedAt: release.published_at, sizeBytes: apk.size, sha256: /^sha256:[0-9a-f]{64}$/.test(apk.digest ?? '') ? apk.digest!.slice(7) : null, releaseUrl: release.html_url, apkUrl: apk.browser_download_url, manifestUrl: download(manifest) ? manifest : null };
    if (fetcher === fetch) cached = { until: Date.now() + 300_000, body };
    return Response.json(body, { headers: { 'cache-control': 'public, max-age=300' } });
  } catch {
    if (fallback) return Response.json(fallback, { headers: { 'cache-control': 'public, max-age=60' } });
    return Response.json({ error: 'release_metadata_unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
