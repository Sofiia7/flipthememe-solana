import { useState } from 'react';
import { parseMarketStatus, type MarketStatus } from '../lib/marketStatus';
import { usePolling } from '../lib/usePolling';
export function useMarketStatus() {
  const [status, setStatus] = useState<MarketStatus | null>(null);
  usePolling(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch('https://sol.flipthememe.com/v1/arena', { signal: controller.signal });
      if (!response.ok) return;
      const parsed = parseMarketStatus(await response.json());
      if (parsed) setStatus(parsed);
    } finally { clearTimeout(timer); }
  }, 15_000);
  return status;
}
