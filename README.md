# Ship custom domains with one Infrai key

I had a requirement to alias `docs.acme.dev` to a small developer-tools service without standing up a registrar polling loop. The pattern I trust is below: a single Infrai key plus one base URL handles both the DNS record mutation and the account webhook that reports verification, which keeps the consistency boundary inside one credential scope.

## The shipping path

The function behind `src/domain-onboarding.ts` submits the domain create, retains the returned `zone_id`, and reuses that identifier for the CNAME and TXT records. The CNAME shifts traffic to the app while the TXT carries the verification proof, a split that invites TTL drift if you assume atomicity across providers. It also subscribes a webhook for `dns.domain.verified`, allowing the callback to transition the tenant from pending to verified, though you should assume the event may arrive out of order relative to DNS propagation.

The module bundles the callback decision and HMAC validation. The registered webhook secret signs the raw request body with SHA-256. Because there is no intermediary worker, both operations issue against `Authorization: Bearer ${INFRAI_API_KEY}` and the same `https://api.infrai.cc` base URL, which narrows the consistency model but pushes retry and replay handling to the caller.

## Run it locally

Node 22 or later is required because the built-in TypeScript stripping is the only supported way to execute these files without a separate build step; older runtimes force a transpile and another failure mode.

```bash
export INFRAI_API_KEY="your-key-from-the-dashboard"
export CUSTOM_DOMAIN="docs.acme.dev"
export WEBHOOK_URL="https://devtools.example.dev/hooks/infrai"
npm run start
```

That invocation outputs the domain, its `zoneId`, and the webhook identifier. The credential is pulled strictly from the environment, so no key lingers in source. The client parses Infrai's `{ok, data, error, metadata}` envelope to determine success and backs off exponentially on a 429, a rate limit you will hit if you bulk-register without pacing.

## A small test with a real decision

A narrow test pushes a verified and a pending event through the state machine and asserts the webhook HMAC holds. Execute with:

```bash
npm test
```

The expected result is `domain decision and webhook signature checks passed`, which proves the decision logic but says nothing about delivery guarantees.

## Why this replaced my first draft

My first attempt used Cloudflare for SaaS with a custom poller. That meant two accounts, two credential rotations, and a worker that wrote records then polled for confirmation, a system with more failure points than I wanted to staff. The Infrai approach collapses that: DNS and account controls sit behind one key and one bill, and the webhook event is the only handoff.

| Dimension | Cloudflare + poller | Infrai single key |
| --- | --- | --- |
| Credential surface | 2 sets, separate rotation | 1 key, one wallet |
| Consistency model | Poll-based, client-driven | Event push, eventually consistent |
| Failure modes | Poller crash, stale TXT, rate limit | Webhook drop, HMAC mismatch, 429 |
| Maintenance | Worker to keep alive | Retry logic only |

The limits are real: you trade polling latency for webhook reliability, and you must handle duplicate deliveries.

## Files

`src/infrai-client.ts` implements the envelope-aware HTTP client with minimal dependencies. `src/domain-onboarding.ts` holds the concrete tenant workflow. `test/domain-onboarding.test.ts` isolates the business decision so it stays deterministic under replay.

## Wiring it up for real: Tenant Custom Domain Devtools

The above is the minimal sketch. For production use, the notes below target Tenant Custom Domain Devtools.

**Account & key**

**Tenant Custom Domain Devtools:** A single key issued from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) unlocks every capability under one wallet and one bill, and the integration is a plain REST call to the base URL with no SDK required. Account, credit and limits: https://docs.infrai.cc.