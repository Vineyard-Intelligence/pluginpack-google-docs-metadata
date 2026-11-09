// @vineyard/plugin-sdk (in-app runtime copy).
// Canonical spec: registry/SPEC.md (gitignored, local-only).
//
// A plugin is `export default definePlugin({ manifest, run })`. It only ever touches the
// host through `ctx` (the HostContext) — never fetch/DOM/token directly. A ctx member is
// ABSENT unless its scope was granted.

export type GraphScope =
    | 'node:read'
    | 'node:create'
    | 'node:update'
    | 'node:delete'
    | 'edge:read'
    | 'edge:create'
    | 'edge:update'
    | 'edge:delete';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface NetworkScope {
    endpoint: string;
    methods: HttpMethod[];
    purpose?: string;
}
/**
 * Anonymous probing of arbitrary public hosts — the capability behind `ctx.net.probe`.
 *
 * Distinct from `network` on purpose. `network` is an allowlist: the plugin names the few
 * endpoints it will call and the host permits only those. `web_probe` is the opposite shape — the
 * plugin cannot know in advance which of hundreds of sites it will hit (account-discovery is the
 * canonical case), so instead of an endpoint list it declares the *manner* of access, which the
 * host then constrains: no cookies, no credentials, no redirects, and no private/loopback targets.
 * It only functions inside the desktop shell, where a main-process fetch can reach a cross-origin
 * host a browser cannot; in the web build `ctx.net.probe` is simply absent.
 */
export interface WebProbeScope {
    purpose?: string;
}
export interface ConfigValue {
    key: string;
    label?: string;
    type: 'string' | 'number' | 'boolean' | 'url' | 'enum';
    enum?: string[];
    secret?: boolean;
    scope?: 'plugin' | 'project' | 'user';
    optional?: boolean;
}
export interface ManifestScopes {
    graph?: GraphScope[];
    network?: NetworkScope[];
    /** Desktop-only anonymous probe of arbitrary public hosts. Backs `ctx.net.probe`. */
    web_probe?: WebProbeScope;
    /**
     * Vineyard-operated services this pack calls BY NAME — `["rdap"]`, `["telegram"]`. Backs
     * `ctx.service`.
     *
     * Names, not URLs, and that is the security property rather than a nicety. `net.fetch` takes a
     * destination FROM THE PLUGIN, so a bridge that attached the analyst's credential to it would
     * hand that credential to whatever host a manifest named — the confused-deputy shape. Here the
     * destination comes from a table in the host and the plugin cannot influence it, so there is no
     * "is this really ours?" check to write and none to forget.
     *
     * It also reads better at the install gate: "Uses Vineyard's RDAP service" instead of a URL the
     * analyst has to recognise.
     */
    services?: string[];
    config?: ConfigValue[];
}

export type ExecutionPlatform = 'web' | 'desktop';
export interface PluginManifest {
    identifier: string; // run.vineyard.plugins.<name>
    content_type: 'vineyard:plugin';
    name: string;
    version: string;
    description: string;
    author?: { name?: string; url?: string; contact?: string };
    license?: string;
    icon?: string;
    platforms: {
        primary?: ExecutionPlatform;
        web?: { runtime: 'sandbox-js' | 'web-proxy'; entry: string; proxy_endpoint?: string; fallback?: string };
        desktop?: {
            runtime: 'sandbox-js' | 'native' | 'subprocess';
            entry: string;
            min_app_version?: string;
            fallback?: string;
        };
    };
    io: { consumes: TypeRef[]; produces: TypeRef[] };
    params?: Record<string, any>; // JSON-Schema for the pre-run form
    scopes: ManifestScopes;
    lifecycle?: {
        long_running?: boolean;
        /**
         * Wall-clock budget for ONE run, in ms. When it elapses the host terminates the sandbox
         * and fails the task — the backstop for a plugin that stops yielding to its event loop and
         * so can never see ctx.signal. Clamped to the host's ceiling, and defaulted when omitted
         * (see worker-host), so a manifest can raise the budget but not opt out of one.
         */
        timeout_ms?: number;
        controls?: Array<'pause' | 'resume' | 'cancel' | 'retry' | 'progress'>;
        progress?: 'none' | 'determinate' | 'indeterminate';
        persistence?: 'ephemeral' | 'opt-in' | 'always';
    };
    distribution?: Record<string, any>;
}
export interface TypeRef {
    typepack: string;
    category: string;
    name: string;
    as?: string;
}

export interface GraphNode {
    id: string;
    type: string;
    data: Record<string, unknown>;
}
export interface GraphEdge {
    id: string;
    from_node_id: string;
    to_node_id: string;
    label: string;
    /** Whatever the edge carries — `label_source`, `confidence`, `confidence_source`, pack keys. */
    data?: Record<string, unknown>;
}

export interface EntityDraft {
    type: string;
    data: Record<string, unknown>;
    key?: string;
}
export interface EdgeDraft {
    from: string;
    to: string;
    /**
     * NO `type`. An edge states its relationship in `label`, in prose — "resolved to this address
     * on 2026-02-01" rather than a qualified `edge_types[]` key. The column that would have held
     * the key is gone (core migration 0024) and packs' `edge_types[]` declarations are read by
     * nothing, which is a product decision rather than a gap to fill in.
     */
    label: string;
    /**
     * Optional free-form keys for the edge's `data` blob, MERGED rather than replacing it.
     *
     * `confidence`, `confidence_source` and `label_source` are REFUSED here, not ignored: the grade
     * is derived from evidence by the host (edge-confidence.ts) and the two sources are stamped at
     * commit from the run's own identity. A writer that could set them could grade its own work and
     * sign it as the analyst.
     */
    data?: Record<string, unknown>;
}

// ---- net (web-proxy) ------------------------------------------------------------------------
// A plugin with a `network` scope reaches exactly its declared endpoint(s) through ctx.net —
// never global fetch (which is stripped in the sandbox). The host bridge enforces the allowlist
// (web ⇒ the single proxy_endpoint) and forces credentials:"omit", so the analyst's cookie jar
// never rides along. It does NOT strip Authorization: a worker has no storage to read a credential
// out of, so that header can only ever carry something the pack already had, and stripping it
// pushed packs onto custom headers that survive a cross-origin redirect when Authorization does
// not. See the note above `net` in host-bridge.ts for the measurements.
export interface SafeRequestInit {
    method?: HttpMethod;
    headers?: Record<string, string>; // Cookie is a forbidden header name; the bridge omits credentials
    body?: string; // serialized request body
}
export interface SafeResponse {
    ok: boolean;
    status: number;
    headers: Record<string, string>; // sanitized subset
    text(): Promise<string>;
    json(): Promise<unknown>;
}

// ---- probe (desktop-only) -------------------------------------------------------------------
// `ctx.net.probe` performs ONE anonymous request against an arbitrary host through the Electron
// main process. Unlike `net.fetch` it does not follow redirects — the caller sees the true status
// of the URL it asked for, which is what presence-detection (a 302-to-login means "no account")
// depends on. Present only when scopes.web_probe is granted AND running in the desktop shell.
export interface SafeProbeInit {
    method?: 'GET' | 'HEAD' | 'POST';
    headers?: Record<string, string>; // cookie/authorization/host are dropped by the host
    body?: string; // only meaningful for POST
    maxBytes?: number; // cap on the returned body; the shell clamps it to a ceiling
    timeoutMs?: number; // per-request timeout; the shell clamps it to a ceiling
    bodyEncoding?: 'base64'; // return the body base64-encoded (binary content); desktop 0.4.15+
    headerNames?: boolean; // HTTP/1.1, and return the header names as sent (order, case, repeats); body not read; desktop 0.4.15+
}
export interface SafeProbeResponse {
    /** The real HTTP status, including 3xx. 0 when the request was blocked or errored. */
    status: number;
    headers: Record<string, string>; // lowercased, minus set-cookie
    body: string; // up to maxBytes; empty for HEAD/redirects/cap-0
    truncated: boolean;
    redirectUrl?: string; // Location of a 3xx (not followed)
    error?: string; // set on guard rejection or transport error; status is 0 then
    bodyEncoding?: 'base64'; // present when the body is base64-encoded
    headerNames?: string[]; // when requested: header names as sent
}

export interface HostContext {
    readonly run: {
        runId: string;
        projectId: string;
        pluginId: string;
        grantedScopes: ManifestScopes;
        platform: ExecutionPlatform;
    };
    /** Trigger context: ids the user had selected when launching. */
    readonly input: { selection: string[] };
    readonly params?: Readonly<Record<string, unknown>>;
    readonly config?: Readonly<Record<string, string | number | boolean>>;

    graph?: {
        get?(nodeId: string): Promise<GraphNode | null>;
        list?(opts?: { type?: string }): Promise<{ nodes: GraphNode[] }>;
        edges?(): Promise<GraphEdge[]>;
        neighbors?(nodeId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
        createNode?(draft: EntityDraft): Promise<GraphNode>;
        updateNode?(nodeId: string, data: Record<string, unknown>): Promise<void>;
        deleteNode?(nodeId: string): Promise<void>;
        deleteNodes?(nodeIds: string[]): Promise<{ deleted: number }>;
        createEdge?(edge: EdgeDraft): Promise<void>;
        /**
         * Amend an edge that already exists, BY ITS OWN ID.
         *
         * `createEdge` against a pair that is already linked also amends it — that is the relabel
         * path and it stays — but the two are not interchangeable and this is not a convenience
         * alias for it. Two reasons, and the second is the load-bearing one:
         *
         *  1. ADDRESSING. `edges()`/`neighbors()` hand back edge ids and `deleteEdge` takes one, so
         *     a caller holding an edge id could read it and delete it but not amend it — it had to
         *     resolve back to two node ids first.
         *  2. RE-GRADING. Commit discards the stored grade whenever the label is restated, on the
         *     stated grounds that the old grade was about wording that no longer exists. A writer
         *     that only wants to record a field would have been forced to restate the label to get
         *     there, and would have triggered that discard as a side effect of having no other
         *     route. Omit `label` here and the grade stands.
         *
         * Same refusals on `data` as `createEdge`, and the same merge.
         */
        updateEdge?(edgeId: string, patch: { label?: string; data?: Record<string, unknown> }): Promise<void>;
        deleteEdge?(edgeId: string): Promise<void>;
        deleteEdges?(edgeIds: string[]): Promise<{ deleted: number }>;
    };

    /**
     * net — present iff a network or web_probe scope was granted.
     *   - `fetch` is limited to manifest.scopes.network endpoints (absent without `network`).
     *   - `probe` is the desktop-only anonymous cross-origin probe (absent without `web_probe`,
     *     and absent in the web build even with it — check for it before calling).
     */
    net?: {
        fetch?(input: string, init?: SafeRequestInit): Promise<SafeResponse>;
        probe?(input: string, init?: SafeProbeInit): Promise<SafeProbeResponse>;
    };

    /**
     * Call a Vineyard-operated service by NAME. Present iff `scopes.services` granted at least one.
     *
     *     const res = await ctx.service('rdap', '8.8.8.8');
     *     const who = await ctx.service('telegram', 'resolve', { method: 'POST', body: '{"target":"durov"}' });
     *
     * `path` is appended to whatever base URL the host holds for that name — the plugin never sees
     * it and cannot change it. The host attaches the analyst's credential; the request headers a
     * plugin passes here cannot override `Authorization`, which is the one difference from
     * `net.fetch` that matters.
     *
     * A name the pack did not declare, or one this pack is not permitted to use, throws.
     */
    service?(name: string, path: string, init?: SafeRequestInit): Promise<SafeResponse>;

    progress?: {
        set?(p: { percent?: number; message?: string; phase?: string }): void;
        log?(line: string): void;
        status?(s: 'running' | 'waiting'): void;
    };

    readonly signal?: AbortSignal;
    onCancel?(handler: () => void | Promise<void>): void;
}

export interface RunResult {
    summary?: string;
    counts?: Record<string, number>;
}
export interface VineyardPlugin {
    manifest: PluginManifest;
    run(ctx: HostContext): Promise<RunResult | void>;
}

export function definePlugin(p: VineyardPlugin): VineyardPlugin {
    return p;
}

// ---- Plugin packs: ONE file / bundle may contain MANY plugins (like a typepack's types) ---
export interface VineyardPluginPack {
    identifier: string; // run.vineyard.pluginpacks.<pack>
    content_type?: 'vineyard:pluginpack';
    name: string;
    version: string;
    summary?: string;
    description?: string;
    plugins: VineyardPlugin[];
}
export function definePluginPack(pack: VineyardPluginPack): VineyardPluginPack {
    return pack;
}

/** A bundle's default export may be a single plugin, an array, or a pack. */
export type PluginEntry = VineyardPlugin | VineyardPlugin[] | VineyardPluginPack;

export function isPluginPack(e: PluginEntry): e is VineyardPluginPack {
    return !!e && !Array.isArray(e) && Array.isArray((e as VineyardPluginPack).plugins);
}

/** Normalize any mix of plugins / arrays / packs into a flat list of runnable plugins. */
export function flattenPlugins(entries: PluginEntry[]): VineyardPlugin[] {
    const out: VineyardPlugin[] = [];
    for (const e of entries) {
        if (Array.isArray(e)) out.push(...e);
        else if (isPluginPack(e)) out.push(...e.plugins);
        else out.push(e);
    }
    return out;
}

// ---- Local-dev test harness (no app, no server) ----------------------------
export interface MockContextOptions {
    nodes?: GraphNode[];
    edges?: GraphEdge[];
    params?: Record<string, unknown>;
    /**
     * Values the ANALYST configured, as `ctx.config` sees them.
     *
     * Missing here until a pack needed to prove it sends an API key only when one is set. Four
     * shipped packs read ctx.config (github, shodan, virustotal, otx) and none of them could test
     * that path through this harness: without it every mock run looks like an unconfigured install,
     * so "the key header is attached" and "the key header is never invented" were both unreachable.
     * Mock values only — a real secret never comes near this file.
     */
    config?: Record<string, string | number | boolean>;
    selection?: string[];
    grantedScopes?: ManifestScopes;
    projectId?: string;
    pluginId?: string;
    signal?: AbortSignal;
    /** Simulate ctx.net.fetch — return a raw {status, body, headers}; present only if provided. */
    netHandler?: (
        input: string,
        init?: SafeRequestInit,
    ) => Promise<{ status: number; body: string; headers?: Record<string, string> }>;
    /** Simulate ctx.net.probe — return a raw SafeProbeResponse; present only if provided. */
    probeHandler?: (input: string, init?: SafeProbeInit) => Promise<SafeProbeResponse>;
}

/** Wrap a raw {status, body, headers} payload as a SafeResponse (text()/json() resolve locally). */
export function makeSafeResponse(r: { status: number; body: string; headers?: Record<string, string> }): SafeResponse {
    return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: r.headers ?? {},
        text: async () => r.body,
        json: async () => JSON.parse(r.body),
    };
}
export interface MockContext extends HostContext {
    mock: {
        nodes: GraphNode[];
        edges: GraphEdge[];
        deletedNodeIds: string[];
        deletedEdgeIds: string[];
        createdNodes: GraphNode[];
        createdEdges: EdgeDraft[];
        updatedNodes: Array<{ id: string; data: Record<string, unknown> }>;
        progress: Array<{ percent?: number; message?: string; phase?: string }>;
    };
}

const has = (scopes: ManifestScopes | undefined, s: GraphScope) => !!scopes?.graph?.includes(s);

/** Builds a HostContext over an in-memory graph; members exist only for granted scopes. */
export function createMockContext(opts: MockContextOptions = {}): MockContext {
    const nodes = [...(opts.nodes ?? [])];
    const edges = [...(opts.edges ?? [])];
    const scopes = opts.grantedScopes ?? {};
    const mock: MockContext['mock'] = {
        nodes,
        edges,
        deletedNodeIds: [],
        deletedEdgeIds: [],
        createdNodes: [],
        createdEdges: [],
        updatedNodes: [],
        progress: [],
    };

    const graphAny =
        scopes.graph && scopes.graph.length
            ? {
                  get: async (id: string) => nodes.find((n) => n.id === id) ?? null,
                  list: async () => ({ nodes: [...nodes] }),
                  edges: async () => [...edges],
                  neighbors: async (id: string) => {
                      const inc = edges.filter((e) => e.from_node_id === id || e.to_node_id === id);
                      const nb = new Set<string>();
                      inc.forEach((e) => {
                          nb.add(e.from_node_id === id ? e.to_node_id : e.from_node_id);
                      });
                      return { nodes: nodes.filter((n) => nb.has(n.id)), edges: inc };
                  },
                  ...(has(scopes, 'node:create')
                      ? {
                            createNode: async (d: EntityDraft) => {
                                const n: GraphNode = { id: `mock_${nodes.length + 1}`, type: d.type, data: d.data };
                                nodes.push(n);
                                mock.createdNodes.push(n);
                                return n;
                            },
                        }
                      : {}),
                  ...(has(scopes, 'node:update')
                      ? {
                            updateNode: async (id: string, data: Record<string, unknown>) => {
                                const n = nodes.find((x) => x.id === id);
                                // A plugin passes a DELTA, which the host fill-merges onto whatever
                                // is live at commit. The mock replaced instead, so a pack that
                                // wrongly passed `{...node.data, ...patch}` looked identical here
                                // to one that passed the patch alone — and only differed in
                                // production, by rolling back another run's fields.
                                if (n) n.data = { ...n.data, ...data };
                                mock.updatedNodes.push({ id, data });
                            },
                        }
                      : {}),
                  ...(has(scopes, 'edge:create')
                      ? {
                            createEdge: async (e: EdgeDraft) => {
                                const edge: GraphEdge = {
                                    id: `mock_e_${edges.length + 1}`,
                                    from_node_id: e.from,
                                    to_node_id: e.to,
                                    label: e.label,
                                };
                                edges.push(edge);
                                mock.createdEdges.push(e);
                            },
                        }
                      : {}),
                  ...(has(scopes, 'node:delete')
                      ? {
                            deleteNode: async (id: string) => {
                                removeNode(id);
                            },
                            deleteNodes: async (ids: string[]) => {
                                ids.forEach(removeNode);
                                return { deleted: ids.length };
                            },
                        }
                      : {}),
                  ...(has(scopes, 'edge:delete')
                      ? {
                            deleteEdge: async (id: string) => {
                                removeEdge(id);
                            },
                            deleteEdges: async (ids: string[]) => {
                                ids.forEach(removeEdge);
                                return { deleted: ids.length };
                            },
                        }
                      : {}),
              }
            : undefined;

    function removeNode(id: string) {
        const i = nodes.findIndex((n) => n.id === id);
        if (i >= 0) {
            nodes.splice(i, 1);
            mock.deletedNodeIds.push(id);
        }
    }
    function removeEdge(id: string) {
        const i = edges.findIndex((e) => e.id === id);
        if (i >= 0) {
            edges.splice(i, 1);
            mock.deletedEdgeIds.push(id);
        }
    }

    return {
        run: {
            runId: 'mock-run',
            projectId: opts.projectId ?? 'mock-project',
            pluginId: opts.pluginId ?? 'run.vineyard.plugins.mock',
            grantedScopes: scopes,
            platform: 'web',
        },
        input: { selection: opts.selection ?? [] },
        params: opts.params ?? {},
        config: opts.config ?? {},
        graph: graphAny as HostContext['graph'],
        net:
            opts.netHandler || opts.probeHandler
                ? {
                      ...(opts.netHandler
                          ? {
                                fetch: async (input: string, init?: SafeRequestInit) =>
                                    makeSafeResponse(await opts.netHandler!(input, init)),
                            }
                          : {}),
                      ...(opts.probeHandler
                          ? {
                                probe: async (input: string, init?: SafeProbeInit) => opts.probeHandler!(input, init),
                            }
                          : {}),
                  }
                : undefined,
        progress: {
            set: (p) => mock.progress.push(p),
            log: () => {},
            status: () => {},
        },
        signal: opts.signal,
        onCancel: () => {},
        mock,
    };
}
