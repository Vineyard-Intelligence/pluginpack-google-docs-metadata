# Google Docs Metadata

A Vineyard pluginpack (plugin `run.vineyard.plugins.google_docs_metadata`) that reads the public metadata of **link-shared Google Drive documents** and
writes it into an investigation graph.

Given only an anonymous document link, it recovers:

- the **owner** — display name, email address, and stable Google account id
- the **last modifier**, when different from the owner (a co-actor pivot)
- **created / modified** timestamps
- the **link-sharing role** (e.g. `anyoneWithLink:reader`)

## Desktop only

The endpoint the Drive web client itself uses **rejects any request that carries an `Origin`
header**, and a browser always attaches one to cross-origin requests, so this cannot work in a
browser. In a browser build the plugin says so plainly rather than half-working.

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
so the plugin throttles itself: concurrency 2, a 250 ms per-worker gap, bounded exponential backoff
with full jitter, a 200-document per-run budget, and a circuit breaker that stops the run on the
first outcome that will fail identically for every other id. There is no proxy or IP rotation —
that would be block evasion.

## Privacy

This plugin exists to attribute anonymously-shared documents, so it collects a real person's name
and email by design. It requests only the fields it writes, stores the profile photo as a URL
without ever fetching the image, and stamps every document node with `source`, `collected_at` and
`raw_sha256` so any name in the graph can be traced back to the response it came from. Nodes assert
*"this account was observed as owner of this artifact at this time"* — not that a named human
authored anything.

"Publicly available" is not an exemption under GDPR or Korean PIPA. The legitimate-interest
assessment belongs to the operator.

## Caveat

The technique depends on Google not tightening its origin validation. If the key is rotated or the
check hardened, every request will fail at once — the plugin reports that as endpoint breakage
rather than blaming the document.

## Credit and licence

This pack is a port of **[xeuledoc](https://github.com/Malfrats/xeuledoc)** by **Malfrats
Industries**, which originated this technique.

Licensed **GPL-3.0**, matching the original.

It is distributed as its own module and is *not* bundled into the Vineyard application — the app
fetches it at run time from a pinned commit. That separation is deliberate: linking a GPL-3.0 pack
into the app's own JavaScript would make the distributed application a combined work, and "mere
aggregation" does not cover code compiled into one chunk.

No source from the original project was copied. This is an independent implementation of the same
publicly-documented technique, written against Vineyard's plugin sandbox and graph model.
