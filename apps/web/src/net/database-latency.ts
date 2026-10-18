/** A real authenticated REST read avoids the SDK's complete-listener cache. */
export async function measureDatabaseLatency(referenceUrl: string, idToken: string): Promise<number | null> {
  const url = new URL(referenceUrl);
  url.pathname += '.json';
  url.searchParams.set('auth', idToken);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  const started = performance.now();
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return null;
    await response.arrayBuffer();
    return performance.now() - started;
  } catch {
    return null;
  } finally { clearTimeout(timeout); }
}
