const MIN_INTERVAL_MS = 450;
let _lastRequestTime = 0;

/**
 * Enforces a minimum interval between Freshservice API calls.
 * Call before any fsClient.post/postFile to stay within 140 req/min.
 */
export async function throttle() {
  const now = Date.now();
  const wait = MIN_INTERVAL_MS - (now - _lastRequestTime);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastRequestTime = Date.now();
}

/**
 * Rate-limited POST with automatic 429 retry.
 * Enforces a minimum interval between requests to stay within Freshservice's
 * API rate limit (typically 140 req/min). On 429, respects the Retry-After
 * header and retries up to maxRetries times.
 */
export async function throttledPost(
  fsClient,
  path,
  body,
  { tag = 'api', maxRetries = 3 } = {}
) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await throttle();

    try {
      return await fsClient.post(path, body);
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt <= maxRetries) {
        const retryAfter = parseInt(
          err.response?.headers?.['retry-after'] ?? '30',
          10
        );
        console.warn(
          `[${tag}] 429 rate limited — retrying in ${retryAfter}s (attempt ${attempt}/${maxRetries})`
        );
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw err;
    }
  }
}
