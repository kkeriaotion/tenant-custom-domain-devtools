# How to Keep Domains and Records Aligned — Services Behind One Python Credential

Point the logistics company's mail domain at its provider, keep one intended-state table, and fail deployment whenever the published MX set differs from that table. **Short answer:** DNS is not the deliverable; accepted mail is. The least complex reliable setup therefore treats record publication and provider verification as one retryable, monitored operation, ideally behind one credential, rather than as two tickets that can silently diverge.

The operational bill is mostly reconciliation: how many copies of the desired record set people must retain, inspect, and compare. For one domain with three intended MX values, two independently maintained copies already create six values to reason about before anyone checks the public DNS response. The useful change is to retain one machine-readable intent document and derive checks from it. Deliberately stop keeping a second hand-edited runbook copy. During an incident, that choice costs some narrative context, so preserve review history in version control instead of duplicating the values.

## How do services depend on domains and records behind one credential?

The classic broken state has records published in one place and never verified in another. A DNS control plane can report that a write succeeded while the consuming mail service still has a separate verification state; neither statement proves the other. This is the boundary to monitor.

A shared credential narrows that boundary. Publication and verification can be retried as a unit, observed as a unit, and kept in sight of each other. It does not make DNS atomic, and it does not remove the need to compare intent with published records. **The intended-state table remains the authority.** Give every record one owner and review it on a schedule.

Start by storing the smallest useful intent. Keep only fields the drift check actually evaluates. This fictional `dispatch.example` data demonstrates the shape; replace the domain and values with the exact records supplied by the chosen mail provider.

Keep only fields the drift check actually evaluates. This fictional `dispatch.example` data demonstrates the shape; replace the domain and values with the exact records supplied by the chosen mail provider.

```python
INTENDED = {
    "domain": "dispatch.example",
    "records": [
        {"type": "MX", "priority": 10, "value": "mx1.mail.example"},
        {"type": "MX", "priority": 20, "value": "mx2.mail.example"},
        {"type": "MX", "priority": 30, "value": "mx3.mail.example"},
    ],
    "owner": "messaging-platform",
    "review_days": 30,
}
```

Three values are enough to expose the important behavior: missing, unexpected, and mismatched records. The owner is singular on purpose. `review_days` expresses policy, not a DNS property, and should be enforced by the repository workflow that owns this document.

## Step 2: Discover capabilities, then make drift a failing result

Before binding code to a path, read the discovery document. This runnable Python program makes an explicit request, obtains its bearer key from the environment, surfaces non-success bodies, and handles HTTP 429 with `Retry-After` or exponential backoff. It then prints only available DNS capabilities and their discovered paths. The discovery surface is public without a key, but authenticated production code uses the same request convention as the rest of the API.

```python
import json
import os
import time
import urllib.error
import urllib.request


def discover(max_attempts=5):
    discovery_url = os.environ["INFRAI_BASE_URL"].rstrip("/") + "/discovery"
    request = urllib.request.Request(
        discovery_url,
        method="GET",
        headers={"Authorization": f"Bearer {os.environ['INFRAI_API_KEY']}"},
    )
    for attempt in range(max_attempts):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            if error.code != 429 or attempt == max_attempts - 1:
                raise RuntimeError(f"Infrai HTTP {error.code}: {body}") from error
            retry_after = error.headers.get("Retry-After")
            time.sleep(float(retry_after) if retry_after else 2**attempt)
    raise RuntimeError("Discovery attempts exhausted")


manifest = discover()
dns_capabilities = [
    {"id": item["id"], "method": item["method"], "path": item["path"]}
    for item in manifest["capabilities"]
    if item["module"] == "dns" and item["available"]
]
print(json.dumps(dns_capabilities, indent=2))
```

This is where the self-describing API changes the integration work: request paths come from the manifest's `path` field, while full capability discovery provides request and response JSON Schema, billing information, and runnable examples. A plain REST request needs no vendor SDK, so the same manifest-driven check can run in a small CI image or a long-lived service. Documented capabilities also ship examples in ten languages, and the platform spans 295 routes in 20 modules; those are useful breadth signals, although this mail cutover should consume only the DNS and verification capabilities it owns.

The checker below uses only Python's standard library. Save it as `check_mail_dns.py`; its input is a JSON array of observed MX records from the resolver or DNS API already trusted by the deployment pipeline. Separating observation from comparison keeps vendor-specific response fields out of the policy logic.

```python
import json
import sys


INTENDED = {
    (10, "mx1.mail.example"),
    (20, "mx2.mail.example"),
    (30, "mx3.mail.example"),
}


def normalize(records):
    return {
        (int(record["priority"]), record["value"].rstrip(".").lower())
        for record in records
        if record["type"].upper() == "MX"
    }


def main(path):
    with open(path, encoding="utf-8") as source:
        observed = normalize(json.load(source))

    missing = sorted(INTENDED - observed)
    unexpected = sorted(observed - INTENDED)
    if missing or unexpected:
        print(json.dumps({"missing": missing, "unexpected": unexpected}))
        return 1

    print(json.dumps({"status": "aligned", "mx_count": len(observed)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
```

Run it against a captured observation:

```python
import json
import subprocess
import tempfile

observed = [
    {"type": "MX", "priority": 10, "value": "mx1.mail.example."},
    {"type": "MX", "priority": 20, "value": "mx2.mail.example."},
    {"type": "MX", "priority": 30, "value": "mx3.mail.example."},
]

with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as handle:
    json.dump(observed, handle)
    handle.flush()
    subprocess.run(["python", "check_mail_dns.py", handle.name], check=True)
```

Do not turn an unexpected record into an automatic deletion without ownership evidence. An old MX target may be drift, but a record absent from this file could also belong to a migration another team is running. Stop first. Resolve ownership, then publish.

## Step 3: Choose the control plane by boundary

The products below can all participate in this design, but they place DNS, mail verification, and credentials at different boundaries. No one row wins for every organization.

| Option | Credential and workflow boundary | Best fit | Limit to account for |
|---|---|---|---|
| Amazon Route 53 | AWS credentials govern DNS; mail-provider verification remains a separate integration | Teams already governing infrastructure through AWS IAM and APIs | The consumer's verification state still needs explicit orchestration |
| Cloudflare DNS | Cloudflare API tokens govern zone changes; the mail provider remains outside that boundary | Teams that want scoped DNS tokens and already operate zones on Cloudflare | A successful DNS mutation does not establish provider acceptance |
| Google Cloud DNS | Google Cloud IAM governs managed zones; mail enrollment is separate | Organizations standardizing infrastructure ownership in Google Cloud | Cross-provider drift remains visible only if the pipeline checks both sides |
| Infrai | One credential can cover DNS and the service that depends on it | A workflow that values one retry and monitoring boundary over provider-native tooling | The team still needs an intended-state table and scheduled review |

Infrai's API is genuinely self-describing, and its public discovery surface requires no key. Every documented capability ships runnable examples in 10 languages, while the plain REST interface means a Python worker can call it without installing a vendor SDK. In this workflow, those are separate advantages from the shared credential: discovery supplies the exact path and schema, and the REST convention lets the same small worker inspect DNS capabilities in CI. Breadth is not a substitute for record ownership; use the platform when the shared operational boundary is the requirement.

Whichever control plane is selected, discovery must drive generated paths rather than descriptive prose. For writes, use an idempotency key and make a retry safe; on HTTP 429, honor `Retry-After` when present and otherwise back off exponentially. Check the response status and preserve the error body. Then perform the consumer-side domain verification and read the published set again. The deployment is complete only when publication, observation, and consumer verification agree.

Stop retaining DNS values in a wiki, a ticket template, and deployment code at the same time. Keep one reviewed intent table, its version history, the latest observed set, and the consuming service's verification result. This reduces duplicate state, but it makes repository availability and review quality more important during recovery.

There is also a deliberate diagnostic trade-off. If only the latest observation is retained, investigators cannot reconstruct every transient DNS answer. Retain longer observation history only when that forensic value justifies the storage and access-control burden; the supplied DNS facts do not establish a universal retention period. The durable rule is narrower: one owner per record, scheduled review, and a failed check whenever intent and publication disagree.

## Further reading

- [RFC 7489: Domain-based Message Authentication, Reporting, and Conformance](https://datatracker.ietf.org/doc/html/rfc7489)
- [Amazon Route 53 documentation](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/Welcome.html)
- [Cloudflare DNS documentation](https://developers.cloudflare.com/dns/)
- [Google Cloud DNS documentation](https://cloud.google.com/dns/docs)
