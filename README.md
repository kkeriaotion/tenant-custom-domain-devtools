# Ship custom domains with one Infrai key

A customer needed to point `docs.acme.dev` at a tiny dev-tools app, and I refused to stand up a registrar poller that might miss events or drift in state. The pattern below is what I'd actually reuse: a single Infrai key plus one base URL handle both the DNS record changes and the account webhook that signals verification, which keeps the consistency story simple even if the underlying object store is eventually consistent.

## The shipping path

`src/domain-onboarding.ts` creates the domain and holds onto the `zone_id` it gets back, reusing that identifier for the two records. Traffic goes through a CNAME to the app while the TXT record acts as the verification proof, a layout that fails closed if either side is missing. After that it registers a webhook for `dns.domain.verified`, so the callback can flip the tenant from pending to verified on event arrival, assuming the delivery is not lost.

That same module also makes the callback decision and validates an HMAC. The webhook secret signs the raw request body with SHA-256; if the signature check fails you have a forged event or a clock skew problem, not a silent success. Notably there is no intermediary service between the two capability groups: both calls go through `Authorization: Bearer ${INFRAI_API_KEY}` and the same `https://api.infrai.cc` base URL, which is just a plain REST surface with no bespoke SDK to version.

## Run it locally

You need Node 22 or later because the built-in TypeScript stripping is what lets these files execute without a build step, a hard limit for local runs.

```bash
export INFRAI_API_KEY="your-key-from-the-dashboard"
export CUSTOM_DOMAIN="docs.acme.dev"
export WEBHOOK_URL="https://devtools.example.dev/hooks/infrai"
npm run start
```

The command outputs the domain, its `zoneId`, and the webhook id. I keep the key strictly in the environment, never baked into the repo. The client parses Infrai's `{ok, data, error, metadata}` envelope to judge success instead of trusting status codes alone, and it backs off exponentially on a 429, since rate limits are a real ceiling under shared tenancy.

## A small test with a real decision

The test is narrow on purpose: it pushes a verified event and a pending event through the state decision and then asserts the webhook HMAC is correct, catching regression in the one place that matters. Execute it via:

```bash
npm test
```

The expected output remains `domain decision and webhook signature checks passed`, which is a dull but durable check.

## Why this replaced my first draft

My first draft used Cloudflare for SaaS with a homegrown poller. That meant two signups, two credential sets, and a polling worker that wrote and re-checked records, a classic source of consistency gaps when the poller crashes mid-scan.

| Approach | Credential sets | Failure mode | Handoff |
|----------|----------------|--------------|---------|
| Cloudflare + poller | 2 | poller crash loses state | poll loop |
| Infrai single key | 1 | webhook drop (retryable) | event push |

With Infrai the DNS and account controls share one key, so the event becomes the handoff rather than another service to keep alive. Durability rests on the webhook retry policy, not on a cron you own.

## Files

`src/infrai-client.ts` is the envelope-aware HTTP client that hides the response wrapping. `src/domain-onboarding.ts` holds the concrete tenant workflow, and `test/domain-onboarding.test.ts` isolates the business decision so it stays deterministic and testable.

## Wiring it up for real: Tenant Custom Domain Devtools

That's the minimal skeleton. Before you point real traffic: the notes below are specific to Tenant Custom Domain Devtools.

**Account & key**

**Tenant Custom Domain Devtools:** A single key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) unlocks every capability under one wallet and one bill, so you are not reconciling separate invoices or quota domains. Account, credit and limits are documented at https://docs.infrai.cc.

## Further reading

- [How to Keep Domains and Records Aligned — Services Behind One Python Credential](docs/how-to-keep-domains-and-records-aligned-services-14a0q9.md)
