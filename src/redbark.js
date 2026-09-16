// Every Redbark API call lives in this file. The REST API is in beta, so when
// a shape or an endpoint changes this is the only file that needs editing.
//
// Verified against the live API on 2026-09-16, release 2026-10-01.wattle:
//   - base url is https://api.redbark.com/v2
//   - Redbark-Version is required on every request, a missing one is 400
//   - transactions take `account` only, never connectionId (that was v1)
//   - pending rows need include_pending=true, they are excluded by default
//   - amounts are integer minor units: { amount: -15970, currency: "aud" }
//   - lists page with an opaque token in next_page_url, not limit/offset
//   - omitting `from` silently limits the read to the last 30 days
//   - history reaches about 7 years, older gives 400 from_too_old
//   - a single read is capped at 5000 rows, flagged by X-Redbark-Truncated

const DEFAULT_BASE_URL = 'https://api.redbark.com/v2';
const DEFAULT_VERSION = '2026-10-01.wattle';

// The transactions endpoint is the "heavy" tier: 30 requests a minute. We stay
// under it deliberately rather than relying on catching 429s.
const DEFAULT_REQUESTS_PER_MINUTE = 25;
const DEFAULT_MAX_ATTEMPTS = 5;

export class RedbarkError extends Error {
  constructor(message, { status, code, type, requestId, retryable = false, cause } = {}) {
    super(message);
    this.name = 'RedbarkError';
    this.status = status;
    this.code = code;
    this.type = type;
    this.requestId = requestId;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Turns an HTTP response into an error with a message that says what to do
// about it. The api key is never part of any message.
function describeFailure(status, body, requestId) {
  const code = body?.error?.code;
  const type = body?.error?.type;
  const detail = body?.error?.message || '';
  const base = { status, code, type, requestId };

  switch (status) {
    case 400:
      if (code === 'version_required') {
        return new RedbarkError(
          `Redbark rejected the request: the Redbark-Version header is required. Set REDBARK_API_VERSION. ${detail}`,
          base,
        );
      }
      if (code === 'from_too_old') {
        return new RedbarkError(
          `Redbark will not serve history that far back, about 7 years is the limit. ${detail}`,
          base,
        );
      }
      return new RedbarkError(`Redbark rejected the request (${code || 'invalid_request'}): ${detail}`, base);
    case 401:
      return new RedbarkError(
        'Redbark rejected the API key (401). It is missing, revoked or expired. Check REDBARK_API_KEY.',
        base,
      );
    case 403:
      return new RedbarkError(
        `Redbark refused the request (403). The key is missing a scope, or the plan does not cover it. This app needs connections:read and data:read. ${detail}`,
        base,
      );
    case 404:
      return new RedbarkError(`Redbark has no such resource (404): ${detail}`, base);
    case 410:
      // v1 returned this when a transactions call omitted the account id. On v2
      // it should not happen, but name it clearly if the API changes again.
      return new RedbarkError(
        `Redbark says this endpoint is gone (410, ${code || 'gone'}). The API shape has changed, check src/redbark.js against the docs. ${detail}`,
        base,
      );
    case 429:
      return new RedbarkError(`Redbark rate limit hit (429). ${detail}`, { ...base, retryable: true });
    case 424:
      return new RedbarkError(
        `The bank failed definitively via Redbark (424). Retrying now will not help. ${detail}`,
        base,
      );
    case 503:
      return new RedbarkError(`Redbark or the bank is unavailable (503). ${detail}`, { ...base, retryable: true });
    default:
      if (status >= 500) {
        return new RedbarkError(`Redbark server error (${status}). ${detail}`, { ...base, retryable: true });
      }
      return new RedbarkError(`Redbark returned ${status}. ${detail}`, base);
  }
}

export function createClient(options = {}) {
  const apiKey = options.apiKey ?? process.env.REDBARK_API_KEY;
  const apiVersion = options.apiVersion ?? process.env.REDBARK_API_VERSION ?? DEFAULT_VERSION;
  const baseUrl = options.baseUrl ?? process.env.REDBARK_API_URL ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? sleepReal;
  const now = options.now ?? (() => Date.now());
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const requestsPerMinute = options.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;

  if (!apiKey) {
    throw new Error('REDBARK_API_KEY is not set. Copy .env.example to .env and fill it in.');
  }

  // Sliding window throttle. Requests are issued one at a time by the sync, so
  // tracking recent timestamps is enough and needs no locking.
  const recent = [];
  async function throttle() {
    for (;;) {
      const cutoff = now() - 60_000;
      while (recent.length && recent[0] <= cutoff) recent.shift();
      if (recent.length < requestsPerMinute) {
        recent.push(now());
        return;
      }
      await sleep(Math.max(250, recent[0] + 60_000 - now()));
    }
  }

  async function request(path, { searchParams, absoluteUrl } = {}) {
    let url;
    if (absoluteUrl) {
      url = absoluteUrl;
    } else {
      const built = new URL(baseUrl + path);
      for (const [key, value] of searchParams ?? []) {
        if (value !== undefined && value !== null) built.searchParams.append(key, String(value));
      }
      url = built.toString();
    }

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await throttle();

      let response;
      try {
        response = await fetchImpl(url, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Redbark-Version': apiVersion,
            Accept: 'application/json',
          },
        });
      } catch (cause) {
        // A network level failure is worth one more go.
        lastError = new RedbarkError(`Could not reach Redbark: ${cause.message}`, { retryable: true, cause });
        if (attempt === maxAttempts) throw lastError;
        await sleep(backoffMs(attempt, null));
        continue;
      }

      const requestId = response.headers.get('request-id') ?? undefined;
      const truncated = response.headers.get('x-redbark-truncated') === 'true';

      if (response.ok) {
        return { body: await response.json(), truncated, requestId };
      }

      let body;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }

      const error = describeFailure(response.status, body, requestId);
      lastError = error;
      if (!error.retryable || attempt === maxAttempts) throw error;

      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(backoffMs(attempt, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null));
    }
    throw lastError;
  }

  function backoffMs(attempt, retryAfterSeconds) {
    if (retryAfterSeconds) return retryAfterSeconds * 1000;
    // 1s, 2s, 4s, 8s with a little jitter so repeated runs do not sync up.
    return Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
  }

  // Walks every page of a list endpoint and returns the rows.
  async function listAll(path, searchParams) {
    const rows = [];
    let result = await request(path, { searchParams });
    let truncated = result.truncated;
    rows.push(...(result.body.data ?? []));

    let nextUrl = result.body.next_page_url;
    while (nextUrl) {
      result = await request(null, { absoluteUrl: nextUrl });
      truncated = truncated || result.truncated;
      rows.push(...(result.body.data ?? []));
      nextUrl = result.body.next_page_url;
    }
    return { rows, truncated };
  }

  return {
    apiVersion,
    baseUrl,

    async getAccountInfo() {
      const { body } = await request('/me');
      return body;
    },

    async listConnections() {
      const { rows } = await listAll('/connections', [['limit', 100]]);
      return rows;
    },

    async listAccounts() {
      const { rows } = await listAll('/accounts', [['limit', 100]]);
      return rows;
    },

    // One non paginated call covers up to 100 accounts. Each balance carries
    // its own freshness, so one stale account never blocks the others.
    async listBalances(accountIds) {
      if (!accountIds.length) return [];
      const params = accountIds.map((id) => ['account', id]);
      const { body } = await request('/balances', { searchParams: params });
      return body.data ?? [];
    },

    // Reads one account over one window, following every page.
    // `from` is always sent: omitting it would quietly cap us at 30 days.
    async listTransactions({ accountId, from, to, includePending = true }) {
      if (!accountId) throw new Error('listTransactions needs an accountId');
      if (!from) throw new Error('listTransactions needs an explicit from date');
      return listAll('/transactions', [
        ['account', accountId],
        ['from', from],
        ['to', to],
        ['include_pending', includePending ? 'true' : 'false'],
        ['limit', 100],
      ]);
    },
  };
}
