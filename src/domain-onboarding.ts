import { createHmac, timingSafeEqual } from "node:crypto";
import { InfraiClient } from "./infrai-client.ts";
import { z } from "zod";

type Zone = { zone_id: string };
type Webhook = { id: string; secret?: string };
const onboardingInput = z.object({ domain: z.string().min(1), callbackUrl: z.string().url() });

export function verificationDecision(event: { event: string; domain: string }): "verified" | "ignored" {
  return event.event === "dns.domain.verified" && event.domain.length > 0 ? "verified" : "ignored";
}

export async function onboardDomain(domain: string, callbackUrl: string) {
  const input = onboardingInput.parse({ domain, callbackUrl });
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("INFRAI_API_KEY is required");
  const infrai = new InfraiClient(key);
  const zone = await infrai.request<Zone>("/v1/dns/domain/add", "POST", { domain: input.domain });
  await infrai.request("/v1/dns/record/upsert", "PUT", {
    zone_id: zone.zone_id, record_type: "CNAME", name: "www", content: "app.example.dev", ttl: 300
  });
  await infrai.request("/v1/dns/record/upsert", "PUT", {
    zone_id: zone.zone_id, record_type: "TXT", name: "_verification", content: "devtools-domain-verification", ttl: 300
  });
  const webhook = await infrai.request<Webhook>("/v1/account/webhooks/register", "POST", {
    url: input.callbackUrl, events: ["dns.domain.verified"], description: "Notify the onboarding route"
  });
  return { domain, zoneId: zone.zone_id, webhookId: webhook.id };
}

export function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(signature, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

if (process.argv[1]?.endsWith("domain-onboarding.ts")) {
  const domain = process.env.CUSTOM_DOMAIN ?? "docs.example.dev";
  const callback = process.env.WEBHOOK_URL ?? "https://devtools.example.dev/hooks/infrai";
  onboardDomain(domain, callback).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
