import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verificationDecision, verifyWebhookSignature } from "../src/domain-onboarding.ts";
import { InfraiClient } from "../src/infrai-client.ts";

assert.equal(verificationDecision({ event: "dns.domain.verified", domain: "docs.acme.dev" }), "verified");
assert.equal(verificationDecision({ event: "dns.domain.pending", domain: "docs.acme.dev" }), "ignored");
const body = JSON.stringify({ event: "dns.domain.verified", domain: "docs.acme.dev" });
const signature = createHmac("sha256", "test-secret").update(body).digest("hex");
assert.equal(verifyWebhookSignature(body, signature, "test-secret"), true);
const originalFetch = globalThis.fetch;
let calls = 0;
try {
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify(calls === 1
      ? { ok: false, error: { code: "RATE_LIMITED" } }
      : { ok: true, data: { id: "retried" } }), {
      status: calls === 1 ? 429 : 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  assert.deepEqual(await new InfraiClient("test-key").request("/test", "GET"), { id: "retried" });
  assert.equal(calls, 2);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("domain decision and webhook signature checks passed");
