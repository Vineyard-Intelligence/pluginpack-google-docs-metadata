// Google Docs Metadata — read the public metadata of a link-shared Google Drive document.
//
// A PORT OF xeuledoc by Malfrats Industries (https://github.com/Malfrats/xeuledoc), which
// originated this technique. The credit travels in the pack description, README and LICENSE.
// Nothing here is copied from that project's source; this is an independent implementation of the
// same public technique, adapted to Vineyard's plugin sandbox and graph model.
//
// A document shared "anyone with the link" still exposes its OWNER (display name, email address,
// stable Google account id), its last modifier, its creation/modification times, and the sharing
// role — through the endpoint drive.google.com's own web client calls. For an investigator holding
// only an anonymous document link, that is the pivot from artifact to account.
//
// WHY THIS IS A DESKTOP PLUGIN — and why it is not merely "CORS is annoying".
// The endpoint authorises callers by the `X-Origin` header and *rejects* any request that carries
// an `Origin` header at all. A browser force-attaches its real `Origin` to cross-origin requests
// and `Origin` is a forbidden header name, so JS cannot remove or overwrite it. The request is
// therefore not hard in a browser, it is structurally impossible. Measured against the live
// endpoint from the Electron main process:
//
//   X-Origin only        -> 404 "File not found"                          (request ACCEPTED)
//   no X-Origin          -> 403 "Requests from referer <empty> are blocked"
//   X-Origin + Origin    -> 400 "Bad request: Origin doesn't match Host for XD3"
//
// `ctx.net.probe` performs the request from the main process, which has no browsing context and
// so attaches no `Origin`. That is the whole reason this plugin can exist. An earlier version of
// this technique lived in a Cloudflare Worker purely to escape the browser; the desktop shell
// removes the need for that hop, and with it a public endpoint that had to be defended.
import { definePlugin, definePluginPack } from './sdk';
import type { HostContext, RunResult, SafeProbeResponse } from './sdk';

// Google's own public web-client key, shipped in drive.google.com's JS bundle. It is not a secret,
// not a user credential, and has no billing attached — but it is also not authorisation: it works
// only alongside X-Origin, and Google can rotate it at any time. See RISK note at the bottom.
const GOOGLE_PUBLIC_WEB_KEY = 'AIzaSyC1eQ1xj69IdTMeii5r7brs3R90eck-m7k';

// Minimised field mask — only what the graph model below actually writes. The original Worker
// requested 18 field groups and used 4; asking Google for more of a stranger's data than we store
// is needless collection.
const FIELDS = [
    'id',
    'title',
    'mimeType',
    'fileSize',
    'createdDate',
    'modifiedDate',
    'shared',
    'owners(permissionId,displayName,emailAddress,picture/url)',
    'lastModifyingUser(permissionId,displayName,emailAddress,picture/url)',
    'permissions(id,type,role,additionalRoles,withLink)',
].join(',');

// Metadata responses are a few KB. Cap well below the shell's ceiling.
const BODY_CAP_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

// Concurrency 2 — NOT the 24 used by WhatsMyName. That plugin fans out over ~700 different hosts;
// this one repeatedly hits a single Google endpoint using a key shared with the entire Drive web
// population, and the shell's probe applies no per-host rate limiting. This plugin is the only
// throttle that exists, so it is a polite one.
const CONCURRENCY = 2;
const MIN_GAP_MS = 250; // per worker => ~8 req/s ceiling overall

// A select-all on a large project must not burn the shared quota.
const MAX_DOCS_PER_RUN = 200;

// Bounded retry. The Worker this replaces looped 100 times with no delay on rateLimitExceeded,
// which is a self-inflicted DoS against a key everyone shares.
const MAX_ATTEMPTS = 4; // 1 initial + 3 retries
const BASE_BACKOFF_MS = 600;
const MAX_BACKOFF_MS = 8_000;
const RUN_RETRY_BUDGET_MS = 45_000; // whole-run ceiling on time spent sleeping

const GOOGLE_API_HOST = 'https://clients6.google.com';

/** A Drive file id: base64url alphabet. Real ids are 33 or 44; the wider band tolerates legacy
 *  ids without accepting arbitrary path junk. */
const ID_RE = /^[A-Za-z0-9_-]{25,64}$/;

type SkipReason = 'published-artifact' | 'folder' | 'shortlink' | 'not-google' | 'no-id';

/** Only these hosts may yield a document id. Without this check an id-shaped path segment or
 *  `?id=` value on ANY site becomes a "document id": a crawl-derived
 *  `https://tracker.example/click?id=<uuid>` matches the base64url class, fires a real request at
 *  the shared Google key, comes back 404 — and gets reported as "not public", telling the
 *  investigator that a private Google document exists when none was ever involved. Wasting quota
 *  is the minor half; fabricating that conclusion is the reason this is a hard gate. */
const GOOGLE_HOSTS = new Set(['docs.google.com', 'drive.google.com', 'sites.google.com']);

export interface ExtractResult {
    id?: string;
    reason?: SkipReason;
}

/** Pull a Drive file id out of any Google Docs/Drive URL, or accept a bare id.
 *
 *  Stricter than the Worker's version in three ways that matter: the id must match the character
 *  class on EVERY path (the Worker's fallback did not check, so a path segment containing `&key=`
 *  could be spliced into the request URL); matching is whole-segment, so an over-long id is
 *  rejected rather than silently truncated into a different valid-looking id; and `?id=` forms are
 *  recovered instead of being destroyed by `split('?')[0]`. */
export function extractDocId(raw: string): ExtractResult {
    const input = String(raw ?? '')
        .trim()
        .slice(0, 2048); // bound the work; no unbounded regex over pasted junk
    if (!input) return { reason: 'no-id' };

    // A bare id pasted with no URL structure.
    if (!input.includes('/') && !input.includes('?')) {
        return ID_RE.test(input) ? { id: input } : { reason: 'no-id' };
    }

    let u: URL | null = null;
    try {
        u = new URL(input.includes('://') ? input : `https://${input}`);
    } catch {
        u = null;
    }
    if (!u) return { reason: 'no-id' };

    const host = u.hostname.toLowerCase();
    // The probe deliberately does not follow redirects, so a shortlink cannot be expanded here.
    if (host === 'goo.gl' || host === 'forms.gle' || host === 'bit.ly') return { reason: 'shortlink' };
    // Everything below extracts an id by SHAPE, and plenty of non-Google URLs are id-shaped.
    if (!GOOGLE_HOSTS.has(host)) return { reason: 'not-google' };

    const segs = u.pathname.split('/').filter(Boolean);

    // Published artifact: /d/e/<pubid>. That id is NOT a file id and will always 404 — naming it
    // is far more useful than querying it.
    const dIdx = segs.indexOf('d');
    if (dIdx >= 0 && segs[dIdx + 1] === 'e') return { reason: 'published-artifact' };

    // /drive/folders/<id> — a folder, not a document.
    if (segs.indexOf('folders') >= 0) return { reason: 'folder' };

    // Canonical /d/<id>. Whole-segment match: the separator is the boundary.
    if (dIdx >= 0 && segs[dIdx + 1] && ID_RE.test(segs[dIdx + 1])) return { id: segs[dIdx + 1] };

    // ?id=<id> forms: /open?id=, /uc?export=download&id=
    const q = u.searchParams.get('id');
    if (q && ID_RE.test(q)) return { id: q };

    // Last resort: a segment that is exactly id-shaped AND a real id length.
    const seg = segs.find((s) => (s.length === 33 || s.length === 44) && ID_RE.test(s));
    if (seg) return { id: seg };

    return { reason: 'no-id' };
}

const PRODUCT: Record<string, string> = {
    'application/vnd.google-apps.document': 'document',
    'application/vnd.google-apps.spreadsheet': 'spreadsheets',
    'application/vnd.google-apps.presentation': 'presentation',
    'application/vnd.google-apps.drawing': 'drawings',
    'application/vnd.google-apps.form': 'forms',
};

/** The node's dedup key. Built from the doc id and Google's own mimeType — never from the URL the
 *  analyst pasted, which carries `?usp=sharing`, `#gid=0`, `/u/0/`, `/edit` vs `/view` and would
 *  fragment one document into six nodes. */
export function canonicalUrl(docId: string, mime?: string): string {
    const p = (mime && PRODUCT[mime]) || 'file';
    return p === 'file'
        ? `https://drive.google.com/file/d/${docId}/view`
        : `https://docs.google.com/${p}/d/${docId}/edit`;
}

const apiUrl = (docId: string): string =>
    `${GOOGLE_API_HOST}/drive/v2beta/files/${encodeURIComponent(docId)}` +
    `?fields=${encodeURIComponent(FIELDS)}&supportsTeamDrives=true&key=${GOOGLE_PUBLIC_WEB_KEY}`;

interface GUser {
    permissionId?: string;
    displayName?: string;
    emailAddress?: string;
    picture?: { url?: string };
}
interface GPermission {
    id?: string;
    type?: string;
    role?: string;
    additionalRoles?: string[];
    withLink?: boolean;
}
interface GFile {
    id?: string;
    title?: string;
    mimeType?: string;
    fileSize?: string;
    createdDate?: string;
    modifiedDate?: string;
    shared?: boolean;
    owners?: GUser[];
    lastModifyingUser?: GUser;
    permissions?: GPermission[];
}

type Outcome = 'ok' | 'not-found' | 'forbidden' | 'rate-limited' | 'bad-request' | 'auth-wall' | 'network' | 'parse';

interface DocResult {
    outcome: Outcome;
    file?: GFile;
    detail?: string;
    /** True when the failure will recur identically for every other id, so the run should stop. */
    fatal?: boolean;
}

/** Google's error envelope. Decisions are made on `reason`, never on substring-matching prose —
 *  error messages are localised and reworded, reason codes are stable. */
function errorReason(body: string): string {
    try {
        const j = JSON.parse(body) as { error?: { errors?: Array<{ reason?: string }>; message?: string } };
        return j.error?.errors?.[0]?.reason ?? '';
    } catch {
        return '';
    }
}

const RETRYABLE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError']);

function classify(res: SafeProbeResponse): DocResult {
    if (res.error || res.status === 0) return { outcome: 'network', detail: res.error || 'no response' };

    const reason = res.status >= 400 ? errorReason(res.body) : '';

    if (res.status === 200) {
        if (res.truncated) return { outcome: 'parse', detail: 'response exceeded the size cap' };
        try {
            return { outcome: 'ok', file: JSON.parse(res.body) as GFile };
        } catch {
            return { outcome: 'parse', detail: 'response was not JSON (interstitial?)' };
        }
    }
    if (res.status === 404 || reason === 'notFound') {
        return { outcome: 'not-found', detail: 'not public, deleted, or never existed' };
    }
    if (res.status === 429 || RETRYABLE_REASONS.has(reason)) {
        return { outcome: 'rate-limited', detail: reason || `HTTP ${res.status}` };
    }
    if (reason === 'dailyLimitExceededUnreg') {
        // Never retried: the daily quota on the shared key is gone until it resets.
        return { outcome: 'rate-limited', detail: 'daily quota exhausted', fatal: true };
    }
    if (res.status === 401) return { outcome: 'auth-wall', detail: 'requires sign-in' };
    if (res.status >= 300 && res.status < 400) {
        return { outcome: 'auth-wall', detail: `redirected to ${res.redirectUrl ?? 'sign-in'}` };
    }
    if (res.status === 403) {
        // Not a rate limit — the origin check itself refused us. It will refuse every other id
        // identically, so grinding through the batch would only earn a block.
        return { outcome: 'forbidden', detail: reason || 'refused', fatal: true };
    }
    if (res.status === 400) return { outcome: 'bad-request', detail: reason || 'malformed', fatal: true };
    if (res.status >= 500) return { outcome: 'rate-limited', detail: `HTTP ${res.status}` };
    return { outcome: 'network', detail: `HTTP ${res.status}` };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        // An ALREADY-aborted signal never fires `abort` again, so without this check a cancelled
        // run would still sit out its pending backoff before the workers unwind. `ctx.net.probe`
        // has no signal of its own, so a cancel always lands while a probe is in flight and the
        // very next thing the worker does is sleep.
        if (ms <= 0 || signal?.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(t);
                resolve();
            },
            { once: true },
        );
    });
}

/** One document, with bounded exponential backoff on the outcomes that can succeed later. */
async function fetchDoc(ctx: HostContext, docId: string, budget: { left: number }): Promise<DocResult> {
    let last: DocResult = { outcome: 'network', detail: 'not attempted' };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (ctx.signal?.aborted) return { outcome: 'network', detail: 'cancelled' };

        const res = await ctx.net!.probe!(apiUrl(docId), {
            method: 'GET',
            // The single load-bearing header. Verified on the wire: omit it and Google answers
            // 403 "Requests from referer <empty> are blocked".
            headers: { 'X-Origin': 'https://drive.google.com' },
            maxBytes: BODY_CAP_BYTES,
            timeoutMs: TIMEOUT_MS,
        });

        last = classify(res);
        if (last.outcome !== 'rate-limited' || last.fatal) return last;
        if (attempt === MAX_ATTEMPTS - 1) break;

        // Honour Retry-After when Google sends one; otherwise exponential backoff with FULL
        // jitter (random in [0, backoff), not backoff+random). Every worker hits the limit at the
        // same instant, and synchronised retries are what turn a soft limit into a hard block.
        const retryAfterMs = Number(res.headers['retry-after']) * 1000;
        const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
        const wait = Math.min(
            Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : Math.random() * backoff,
            budget.left,
        );
        if (wait <= 0) break; // run-wide sleep budget spent
        budget.left -= wait;
        await sleep(wait, ctx.signal);
    }
    return last;
}

/** Summarise the link-sharing state. Absent `permissions[]` is normal for an anonymous caller, so
 *  the fact that we read the file at all is itself evidence it is link-shared. */
function sharingSummary(f: GFile): string {
    const pub = (f.permissions ?? []).filter(
        (p) => p.id === 'anyoneWithLink' || p.id === 'anyone' || p.type === 'anyone',
    );
    if (pub.length) {
        return pub
            .map((p) => `${p.id ?? 'anyone'}:${[p.role, ...(p.additionalRoles ?? [])].filter(Boolean).join('+')}`)
            .join(', ');
    }
    return 'link-shared (role not disclosed)';
}

/** Provenance: the exact bytes this node was derived from. Best-effort — crypto.subtle exists in
 *  the sandbox worker's secure context, but a missing digest must never fail the run. */
async function sha256(text: string): Promise<string> {
    try {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(buf))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
    } catch {
        return '';
    }
}

const googleDocsMetadata = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.google_docs_metadata',
        content_type: 'vineyard:plugin',
        name: 'Google Docs Metadata',
        version: '2.1.1',
        description:
            'Reads the public metadata of link-shared Google Docs/Drive files from selected URL nodes or from links/IDs entered in the Run dialog. Creates a URL node per document (title, MIME type, size, created/modified times, sharing role), linked "document metadata for" from the selected node, and an Account (Google account id, display name) with its Email Address for the owner and the last modifier, linked "owns document" / "last modified document" and "account email"; with create_person on, each Account also gets a Person linked "account". Up to 200 documents per run; folders, shortlinks and published (/d/e/) links are skipped. Desktop only.',
        icon: 'file-search',
        author: { name: 'VINEYARD', url: 'https://vineyard.run' },
        license: 'GPL-3.0',
        platforms: {
            primary: 'desktop',
            // The runner always executes the `web` sandbox-js entry; the desktop-only part is
            // `ctx.net.probe`, which the shell provides and the browser does not.
            web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
            desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
        },
        io: {
            consumes: [{ typepack: 'run.vineyard.typepacks.infrastructure', category: 'web', name: 'url' }],
            produces: [
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'web', name: 'url' },
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'account' },
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'email_address' },
                // Only when the create_person param is on, but declared unconditionally: the
                // manifest is what the user is shown at install time, and a type that can appear
                // must be listed there.
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'person' },
            ],
        },
        params: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    title: 'Document URL or ID',
                    description:
                        'Google Docs/Drive links or file IDs, separated by newlines or commas, read along with any selected URL nodes (up to 200 documents per run). Leave empty to use only the selection.',
                },
                create_person: {
                    type: 'boolean',
                    title: 'Create Person nodes',
                    default: false,
                    description:
                        'Links a Person named after the display name to each owner and last-modifier Account that has one; Persons with the same name merge into one node. Off by default.',
                },
            },
        },
        scopes: {
            graph: ['node:read', 'node:create', 'edge:create'],
            // No `network` scope: every request goes through web_probe. `ctx.net.fetch` cannot be
            // used here at all — clients6.google.com sends no CORS headers AND rejects any request
            // carrying an Origin, which a browser fetch cannot avoid sending.
            web_probe: {
                purpose: "Look up each document's metadata on Google Drive.",
            },
        },
        lifecycle: { persistence: 'opt-in', controls: ['progress', 'cancel'], progress: 'determinate' },
    },

    async run(ctx): Promise<RunResult> {
        // Checked before anything else: a browser cannot make this request at all, and returning
        // zero results would read as "nothing found" rather than "wrong application".
        if (!ctx.net?.probe) {
            return {
                summary:
                    'Google Docs Metadata reads Drive metadata directly from Google and needs the Vineyard desktop app — a browser cannot make this cross-origin request. Open this project in the desktop app and run it again.',
                counts: { documents: 0 },
            };
        }
        if (!ctx.graph?.createNode) {
            return { summary: 'Graph write capability not granted to this plugin', counts: { documents: 0 } };
        }

        // ---- 1. Collect candidate ids from the selection and the free-text param ----
        // `seed` is carried alongside each raw string so the node the analyst selected can be
        // linked to the document node afterwards. Without that link the selected node (whose URL
        // still carries `?usp=sharing`) and the canonical document node are two unconnected nodes
        // for one document — the analyst clicks the thing they selected and sees no findings.
        const raws: Array<{ text: string; seed?: string }> = [];
        for (const id of ctx.input.selection) {
            const n = await ctx.graph.get?.(id);
            if (!n) continue;
            const d = n.data as Record<string, unknown>;
            const cand = d.url ?? d.final_url ?? d.file_path ?? d.file_name ?? d.page_title;
            if (typeof cand === 'string' && cand) raws.push({ text: cand, seed: String(n.id) });
        }
        const param = typeof ctx.params?.url === 'string' ? ctx.params.url : '';
        for (const piece of param.split(/[\n,]/)) {
            const s = piece.trim();
            if (s) raws.push({ text: s });
        }
        if (!raws.length) {
            return {
                summary: 'Select a URL node holding a Google Docs link, or paste one into the Document URL field',
                counts: { documents: 0 },
            };
        }

        // ---- 2. Extract + dedupe ids, recording why anything was skipped ----
        const ids: string[] = [];
        const seenId = new Set<string>();
        const skipped: Record<SkipReason, number> = {
            'published-artifact': 0,
            folder: 0,
            shortlink: 0,
            'not-google': 0,
            'no-id': 0,
        };
        const seedsFor = new Map<string, Set<string>>(); // docId -> selected node ids
        for (const raw of raws) {
            const r = extractDocId(raw.text);
            if (r.id) {
                if (!seenId.has(r.id)) {
                    seenId.add(r.id);
                    ids.push(r.id);
                }
                if (raw.seed) {
                    const set = seedsFor.get(r.id) ?? new Set<string>();
                    set.add(raw.seed);
                    seedsFor.set(r.id, set);
                }
            } else if (r.reason) {
                skipped[r.reason]++;
            }
        }
        const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
        if (!ids.length) {
            return {
                summary: `No Google Drive document id found in ${raws.length} input(s)${describeSkips(skipped)}`,
                counts: { documents: 0, skipped: skippedTotal },
            };
        }

        let overBudget = 0;
        if (ids.length > MAX_DOCS_PER_RUN) {
            overBudget = ids.length - MAX_DOCS_PER_RUN;
            ids.length = MAX_DOCS_PER_RUN;
        }

        // ---- 3. Fetch, with bounded concurrency and a circuit breaker ----
        const total = ids.length;
        const budget = { left: RUN_RETRY_BUDGET_MS };
        const results = new Map<string, DocResult>();
        let done = 0;
        let consecutiveRateLimited = 0;
        let abortRun: string | null = null;

        const report = () =>
            ctx.progress?.set?.({
                percent: Math.min(100, Math.round((done / total) * 100)),
                message: `${countOk(results)} read · ${done}/${total}`,
            });

        let cursor = 0;
        const worker = async () => {
            while (cursor < total) {
                if (ctx.signal?.aborted || abortRun) return;
                const docId = ids[cursor++];
                const startedAt = Date.now();

                const r = await fetchDoc(ctx, docId, budget);
                results.set(docId, r);

                if (r.fatal) {
                    // 403/400/daily-quota fail identically for every id — stop rather than grind.
                    abortRun =
                        r.outcome === 'forbidden'
                            ? `Google refused the request (403 ${r.detail}). The endpoint's origin check may have changed — this plugin is likely broken until updated.`
                            : r.outcome === 'bad-request'
                            ? `Google rejected the request as malformed (400 ${r.detail}) — likely an endpoint change.`
                            : "Google's daily quota for the shared web key is exhausted; nothing more will succeed today.";
                    return;
                }
                if (r.outcome === 'rate-limited') {
                    if (++consecutiveRateLimited >= 3) {
                        abortRun =
                            'Google rate-limited this run repeatedly. Wait a few minutes and re-run; documents already read are in the graph.';
                        return;
                    }
                } else {
                    consecutiveRateLimited = 0;
                }
                if (r.outcome !== 'ok') ctx.progress?.log?.(`${docId}: ${r.outcome} — ${r.detail ?? ''}`);

                done++;
                report();

                // Politeness pacing, measured from the request start so a slow response does not
                // add to the gap.
                const gap = MIN_GAP_MS - (Date.now() - startedAt);
                if (gap > 0) await sleep(gap, ctx.signal);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
        report();

        // ---- 4. Write the graph ----
        const createPerson = ctx.params?.create_person === true;
        let documents = 0;
        let owners = 0;
        let emails = 0;
        const accountNodes = new Map<string, string>(); // permissionId -> node id

        /** One Google account -> an account node (+ its email, + optionally a person). */
        const upsertAccount = async (u: GUser | undefined): Promise<string | null> => {
            if (!u?.permissionId) return null;
            const cached = accountNodes.get(u.permissionId);
            if (cached) return cached;

            const acct = await ctx.graph!.createNode!({
                type: 'identity.account',
                data: {
                    // `permissionId` is Google's stable per-account id, so two owners cannot
                    // collide and a rename does not split it. It used to carry a ` · Google`
                    // suffix so a bare numeric id could not collide with another site's id;
                    // identity.account now declares identity_properties (username, platform) with
                    // platform REQUIRED, so the platform half does that and the suffix would only
                    // make the stored username wrong for every consumer that reads it.
                    username: u.permissionId,
                    platform: 'google',
                    display_name: u.displayName ?? '',
                    user_id: u.permissionId,
                    // The photo URL only; the image binary is never fetched.
                    profile_url: u.picture?.url ?? '',
                },
            });
            accountNodes.set(u.permissionId, String(acct.id));
            owners++;

            if (u.emailAddress) {
                const addr = u.emailAddress.trim().toLowerCase();
                const mail = await ctx.graph!.createNode!({
                    type: 'identity.email_address',
                    data: {
                        email: addr, // dedup key
                        display_name: u.displayName ?? '',
                        domain: addr.split('@')[1] ?? '',
                    },
                });
                emails++;
                if (String(mail.id) !== String(acct.id)) {
                    await ctx.graph!.createEdge!({
                        from: String(acct.id),
                        to: String(mail.id),
                        label: 'account email',
                    });
                }
            }

            if (createPerson && u.displayName) {
                const person = await ctx.graph!.createNode!({
                    type: 'identity.person',
                    data: { full_name: u.displayName },
                });
                if (String(person.id) !== String(acct.id)) {
                    await ctx.graph!.createEdge!({ from: String(person.id), to: String(acct.id), label: 'account' });
                }
            }
            return String(acct.id);
        };

        for (const [docId, r] of results) {
            if (ctx.signal?.aborted) break;
            if (r.outcome !== 'ok' || !r.file) continue;
            const f = r.file;

            const doc = await ctx.graph.createNode({
                type: 'web.url',
                data: {
                    url: canonicalUrl(docId, f.mimeType), // dedup key, derived from Google's answer
                    domain: f.mimeType && PRODUCT[f.mimeType] ? 'docs.google.com' : 'drive.google.com',
                    page_title: f.title || `Google Drive file ${docId}`,
                    http_status: 200,
                    // Undeclared extras: the typepack has no cloud-document type, no datetime
                    // property and no ACL type. The frontend ignores typepack validators, so these
                    // persist — but they are conventions here, not schema-enforced fields.
                    doc_id: docId,
                    mime_type: f.mimeType ?? '',
                    size_bytes: f.fileSize ? Number(f.fileSize) : '',
                    // Raw RFC3339 UTC, not reformatted: reformatting is lossy and unparseable
                    // downstream, and `new Date(undefined)` throws rather than yielding a blank.
                    created_date: f.createdDate ?? '',
                    modified_date: f.modifiedDate ?? '',
                    sharing_access: sharingSummary(f),
                    source: 'clients6.google.com/drive/v2beta',
                    collected_at: new Date().toISOString(),
                    raw_sha256: await sha256(JSON.stringify(f)),
                },
            });
            documents++;

            // Tie the analyst's selected node to the canonical document node. They are usually
            // different nodes: the selection holds whatever URL was pasted (`?usp=sharing`,
            // `/view`, `/u/0/`), the document node holds the canonical form.
            for (const seedId of seedsFor.get(docId) ?? []) {
                if (seedId !== String(doc.id)) {
                    await ctx.graph.createEdge!({ from: seedId, to: String(doc.id), label: 'document metadata for' });
                }
            }

            const ownerId = await upsertAccount(f.owners?.[0]);
            if (ownerId && ownerId !== String(doc.id)) {
                await ctx.graph.createEdge!({ from: ownerId, to: String(doc.id), label: 'owns document' });
            }
            const lm = f.lastModifyingUser;
            if (lm?.permissionId && lm.permissionId !== f.owners?.[0]?.permissionId) {
                const lmId = await upsertAccount(lm);
                if (lmId && lmId !== String(doc.id)) {
                    await ctx.graph.createEdge!({ from: lmId, to: String(doc.id), label: 'last modified document' });
                }
            }
        }

        // ---- 5. Summarise, without hiding anything ----
        const ok = countOk(results);
        const notFound = [...results.values()].filter((r) => r.outcome === 'not-found').length;
        const failed = results.size - ok - notFound;

        let summary = `${ok} of ${total} document(s) read · ${owners} account(s) · ${emails} email(s)`;
        if (notFound) summary += ` · ${notFound} not public`;
        if (failed) summary += ` · ${failed} failed`;
        if (skippedTotal) summary += describeSkips(skipped);
        if (overBudget)
            summary += ` · ${overBudget} beyond the ${MAX_DOCS_PER_RUN}-per-run budget (re-run for the rest)`;
        if (abortRun) summary += ` — stopped: ${abortRun}`;

        return {
            summary,
            counts: { documents, accounts: owners, emails, notFound, failed, skipped: skippedTotal },
        };
    },
});

function countOk(results: Map<string, DocResult>): number {
    let n = 0;
    for (const r of results.values()) if (r.outcome === 'ok') n++;
    return n;
}

function describeSkips(s: Record<SkipReason, number>): string {
    const parts: string[] = [];
    if (s['published-artifact']) parts.push(`${s['published-artifact']} published-page link(s) (need the /d/<id> URL)`);
    if (s.folder) parts.push(`${s.folder} Drive folder(s)`);
    if (s.shortlink) parts.push(`${s.shortlink} shortened link(s) (resolve in a browser first)`);
    if (s['not-google']) parts.push(`${s['not-google']} non-Google URL(s)`);
    if (s['no-id']) parts.push(`${s['no-id']} with no document id`);
    return parts.length ? ` · skipped: ${parts.join(', ')}` : '';
}

export default definePluginPack({
    identifier: 'run.vineyard.pluginpacks.google_docs_metadata',
    content_type: 'vineyard:pluginpack',
    name: 'Google Docs Metadata',
    version: '2.1.1',
    description:
        'Reads the public metadata of link-shared Google Docs/Drive files: owner, email, timestamps and sharing role. Desktop only. A port of xeuledoc by Malfrats Industries (https://github.com/Malfrats/xeuledoc), licensed GPL-3.0.',
    plugins: [googleDocsMetadata],
});
