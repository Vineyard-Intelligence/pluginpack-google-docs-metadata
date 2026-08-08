# Xeuledoc

A Vineyard pluginpack that reads the public metadata of **link-shared Google Drive documents** and
writes it into an investigation graph.

Given only an anonymous document link, it recovers:

- the **owner** — display name, email address, and stable Google account id
- the **last modifier**, when different from the owner (a co-actor pivot)
- **created / modified** timestamps
- the **link-sharing role** (e.g. `anyoneWithLink:reader`)

## Desktop only — and not merely because "CORS is annoying"

The endpoint the Drive web client itself uses authorises callers by an `X-Origin` header and
**rejects any request that carries an `Origin` header at all**. A browser force-attaches its real
`Origin` to cross-origin requests, and `Origin` is a [forbidden header
name](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name) that JavaScript
cannot remove or overwrite. The request is therefore not difficult in a browser — it is
structurally impossible.

Measured against the live endpoint:

| Request | Result |
| --- | --- |
| `X-Origin` only | `404 File not found` for a bogus id — **request accepted** |
| no `X-Origin` | `403 Requests from referer <empty> are blocked` |
| `X-Origin` **and** `Origin` | `400 Bad request: Origin doesn't match Host for XD3` |

The Vineyard desktop shell performs the request from the Electron main process, which has no
browsing context and so attaches no `Origin`. In a browser build the plugin says so plainly rather
than half-working.

## What it writes

| Node | Type | De-duplicates on |
| --- | --- | --- |
| The document | `web.url` | a canonical URL built from the file id and Google's own `mimeType` — so `?usp=sharing`, `/view` vs `/edit` and `/u/0/` variants all collapse to one node |
| Owner / last modifier | `identity.account` | `username` = `<permissionId>` (Google's stable account id, not the display name), `platform` = `google` |
| Their email | `identity.email_address` | the lowercased address |
| Owner as a person | `identity.person` | **off by default** — this type de-duplicates on full name, which would merge two unrelated owners who share a display name |

Edges: `owns document`, `last modified document`, `account email`, and `document metadata for`
linking the node you selected to the canonical document node.

## Being a good citizen

The endpoint is reached with a Google **public web key** shared by the whole Drive web population,
and the desktop shell applies no per-host rate limiting — so this plugin is the only throttle that
exists. It uses concurrency 2, a 250 ms per-worker gap, bounded exponential backoff with full
jitter, a 200-document per-run budget, and a circuit breaker that stops the run on the first
outcome that will fail identically for every other id. There is no proxy or IP rotation: that would
turn rate-limit handling into block evasion, which is indefensible for a tool whose output may end
up in a report.

## Privacy

This plugin exists to attribute anonymously-shared documents, so it collects a real person's name
and email by design. It requests only the fields it writes, stores the profile photo as a URL
without ever fetching the image, and stamps every document node with `source`, `collected_at` and
`raw_sha256` so any name in the graph can be traced back to the response it came from. Nodes assert
*"this account was observed as owner of this artifact at this time"* — not that a named human
authored anything.

"Publicly available" is not an exemption under GDPR or Korean PIPA. The legitimate-interest
assessment belongs to the operator; the plugin's job is to make what it collected auditable enough
to defend.

## Caveat

The technique depends on Google not tightening its origin validation. If the key is rotated or the
check hardened, every request will fail at once — the plugin reports that as endpoint breakage
rather than blaming the document.

## Credit and licence

This pack is a port of **[xeuledoc](https://github.com/Malfrats/xeuledoc)** by **Malfrats
Industries**, which originated this technique. The name is kept so the credit travels with the
tool rather than living only in a README.

Licensed **GPL-3.0**, matching the original.

It is distributed as its own module and is *not* bundled into the Vineyard application — the app
fetches it at run time from a pinned commit. That separation is deliberate: linking a GPL-3.0 pack
into the app's own JavaScript would make the distributed application a combined work, and "mere
aggregation" does not cover code compiled into one chunk.

No source from the original project was copied. This is an independent implementation of the same
publicly-documented technique, written against Vineyard's plugin sandbox and graph model.
