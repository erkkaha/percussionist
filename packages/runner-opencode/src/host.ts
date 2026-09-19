// host.ts — one embedded OpenCode 2 host per run pod, exposed through the
// session/transcript/event operations the v1 HTTP facade in index.ts needs.

import { OpenCode } from '@opencode/sdk';
import { type PermissionMode, percussionistPlugin } from './plugin.js';
import {
  type MessageInfo,
  type ProviderListing,
  providerListing,
  type TranscriptMessage,
  translateMessage,
  translateMessages,
  type V2Message,
  type V2ModelEntry,
  type V2Provider,
} from './translate.js';

export type ApiCredential = { providerID: string; key: string };

export type HostOptions = {
  workspace: string;
  /** JSON document for OpenCode.create({ config: { content } }). */
  configContent: string;
  /**
   * API-key credentials to register through the SDK's integration API. v2 keeps
   * credentials in its database (in-memory here), not in config, so a key in
   * the config document alone does not connect a catalog provider.
   */
  credentials: ApiCredential[];
  permissionMode: PermissionMode;
  /** Log every SDK event type (noisy; for bring-up). */
  logEvents: boolean;
  log: (msg: string) => void;
  warn: (msg: string) => void;
};

export type SessionSummary = { id: string; title: string };

type SdkHost = Awaited<ReturnType<typeof OpenCode.create>>;

type SdkEvent = {
  type?: string;
  data?: {
    sessionID?: string;
    assistantMessageID?: string;
    messageID?: string;
    error?: unknown;
  } & Record<string, unknown>;
};

/** SSE payloads in v1 spelling. The dispatcher acts on exactly these three. */
export type V1Event =
  | { type: 'server.connected' }
  | { type: 'message.updated'; properties: { info: MessageInfo } }
  | { type: 'session.idle'; properties: { sessionID: string; agent?: string } }
  | { type: 'permission.updated'; properties: Record<string, unknown> };

type Subscriber = (event: V1Event) => void;

const TERMINAL_EVENTS = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.idle',
]);
/** Events after which the newest assistant message carries fresh usage. */
const USAGE_EVENTS = new Set(['session.step.ended', 'session.step.failed']);

export class RunnerHost {
  private sessions = new Map<string, SessionSummary & { agent?: string }>();
  private subscribers = new Set<Subscriber>();
  private abort = new AbortController();
  private closed = false;
  /** Resolves once credentials are connected and providers refreshed (or timed out). */
  private ready: Promise<void> = Promise.resolve();

  private constructor(
    private readonly sdk: SdkHost,
    private readonly opts: HostOptions,
  ) {}

  static async start(opts: HostOptions): Promise<RunnerHost> {
    const sdk = await OpenCode.create({
      config: { content: opts.configContent },
      plugins: [
        percussionistPlugin({
          permissionMode: opts.permissionMode,
          log: opts.log,
          onToolCall: (tool, sessionID) => opts.log(`tool ${tool} (${sessionID})`),
        }),
      ],
      log: {
        level: 'warn',
        emit: (entry: { message: string; attributes?: unknown; cause?: unknown }) => {
          // Config normalization diagnostics fire once per unknown v1 model
          // flag and are informational.
          if (/normalization/.test(entry.message)) return;
          const cause = entry.cause ? ` — ${String(entry.cause).split('\n')[0]}` : '';
          opts.warn(`sdk: ${entry.message} ${JSON.stringify(entry.attributes ?? {})}${cause}`);
        },
      },
    });
    const host = new RunnerHost(sdk, opts);
    void host.pumpEvents();
    // Bounded: a hung SDK call here must degrade to a prompt that may fail,
    // not to a POST /message that never answers the dispatcher.
    host.ready = Promise.race([
      host.connectCredentials(opts.credentials).catch((e) => {
        opts.warn(`credential setup failed: ${describe(e)}`);
      }),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          opts.warn('credential setup still running after 60s — accepting prompts anyway');
          resolve();
        }, 60_000).unref(),
      ),
    ]);
    return host;
  }

  /** The SDK's own idea of its version; "unknown" for embedded hosts in 2.0.10. */
  async version(): Promise<string> {
    try {
      const info = await this.sdk.server.info();
      return (info as { version?: string }).version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async createSession(title: string, agent?: string): Promise<SessionSummary> {
    const s = await this.sdk.sessions.create({
      location: { directory: this.opts.workspace },
      ...(title ? { title } : {}),
      ...(agent ? { agent: agent as never } : {}),
    });
    const summary = { id: s.id, title, ...(agent ? { agent } : {}) };
    this.sessions.set(s.id, summary);
    return summary;
  }

  /**
   * v1 `GET /provider` shape: `{ all, default, connected }`. provider.list is
   * the set of providers that are configured or connected; models come from
   * model.list grouped by provider.
   */
  async providers(): Promise<ProviderListing> {
    const location = { directory: this.opts.workspace };
    const providersRes = await this.sdk.provider.list({ location });
    const modelsRes = await this.sdk.model.list({ location });
    return providerListing(
      providersRes.data as unknown as V2Provider[],
      modelsRes.data as unknown as V2ModelEntry[],
    );
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map(({ id, title }) => ({ id, title }));
  }

  has(sessionID: string): boolean {
    return this.sessions.has(sessionID);
  }

  /** Full transcript in v1 shape, oldest first. */
  async messages(sessionID: string): Promise<TranscriptMessage[]> {
    const all: V2Message[] = [];
    let cursor: string | undefined;
    // 2.0.10 pages message.list; walk it so long runs are not silently cut.
    // The cursor encodes the order, and passing both is rejected.
    for (let page = 0; page < 200; page++) {
      const res = await this.sdk.message.list({
        sessionID: sessionID as never,
        limit: 200,
        ...(cursor ? { cursor } : { order: 'asc' as const }),
      });
      all.push(...(res.data as unknown as V2Message[]));
      cursor = res.cursor?.next;
      if (!cursor || res.data.length === 0) break;
    }
    return translateMessages(sessionID, all);
  }

  /**
   * Deliver a user turn. Model and agent are switched first when given; the
   * dispatcher sends the model as {providerID, modelID} and v2 wants
   * {providerID, id}.
   */
  async prompt(
    sessionID: string,
    input: { text: string; agent?: string; model?: { providerID?: string; modelID?: string } },
  ): Promise<void> {
    // The dispatcher posts the first prompt right after creating the session;
    // a prompt that races the credential connection resolves to no model.
    await this.ready;
    const sid = sessionID as never;
    if (input.model?.modelID) {
      const providerID = input.model.providerID;
      if (providerID) {
        if (!(await this.waitForModel(providerID, input.model.modelID, 15_000))) {
          this.opts.warn(
            `model ${providerID}/${input.model.modelID} not listed after 15s — prompting anyway`,
          );
        }
        try {
          await this.sdk.sessions.switchModel({
            sessionID: sid,
            model: { providerID, id: input.model.modelID } as never,
          });
        } catch (e) {
          this.opts.warn(`switchModel ${providerID}/${input.model.modelID} failed: ${describe(e)}`);
        }
      } else {
        this.opts.warn(
          `model "${input.model.modelID}" has no provider prefix — using the configured default model`,
        );
      }
    }
    if (input.agent) {
      try {
        await this.sdk.sessions.switchAgent({ sessionID: sid, agent: input.agent as never });
        const s = this.sessions.get(sessionID);
        if (s) s.agent = input.agent;
      } catch (e) {
        this.opts.warn(`switchAgent ${input.agent} failed: ${describe(e)}`);
      }
    }
    await this.sdk.sessions.prompt({ sessionID: sid, text: input.text });
  }

  async interrupt(sessionID: string): Promise<void> {
    await this.sdk.sessions.interrupt({ sessionID: sessionID as never });
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    await this.sdk.close();
  }

  // ---------------------------------------------------------------------------

  private publish(event: V1Event): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        // A broken SSE client must never take down the event pump.
      }
    }
  }

  private async latestAssistantInfo(
    sessionID: string,
    messageID: string | undefined,
  ): Promise<MessageInfo | undefined> {
    try {
      if (messageID) {
        const m = await this.sdk.sessions.message.get({
          sessionID: sessionID as never,
          messageID: messageID as never,
        });
        return translateMessage(sessionID, m as unknown as V2Message)?.info;
      }
      const res = await this.sdk.message.list({
        sessionID: sessionID as never,
        order: 'desc',
        limit: 1,
        type: 'assistant',
      });
      const m = res.data[0] as unknown as V2Message | undefined;
      return m ? translateMessage(sessionID, m)?.info : undefined;
    } catch (e) {
      this.opts.warn(`fetching assistant message failed: ${describe(e)}`);
      return undefined;
    }
  }

  /**
   * True once model.list shows exactly `providerID/modelID`, false after `ms`.
   *
   * The catalog lists a provider's models before any credential is connected,
   * so "some model from this provider" is always true; the connected provider's
   * fuller model set (and routability) lands 200–500 ms after connect.key, in
   * the batch that also emits models-dev.refreshed / integration.updated.
   * Waiting for the model the dispatcher actually asked for is the check that
   * cannot be fooled by the catalog.
   */
  private async waitForModel(providerID: string, modelID: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    const location = { directory: this.opts.workspace };
    while (Date.now() < deadline && !this.closed) {
      try {
        const res = await this.sdk.model.list({ location });
        const models = res.data as unknown as Array<{
          providerID?: string;
          id?: string;
          modelID?: string;
        }>;
        if (models.some((m) => m.providerID === providerID && (m.id ?? m.modelID) === modelID)) {
          return true;
        }
      } catch {
        // registry not ready yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  /**
   * Register API keys with the SDK's integration service.
   *
   * The integration catalog is loaded asynchronously after create(), so each
   * provider is polled into existence first (a few hundred ms in practice).
   * Routability of the connected provider's models arrives later still; see
   * waitForModel.
   */
  private async connectCredentials(creds: ApiCredential[]): Promise<void> {
    if (creds.length === 0) return;
    const location = { directory: this.opts.workspace };
    let connected = 0;
    for (const cred of creds) {
      const integrationID = cred.providerID as never;
      let found = false;
      for (let i = 0; i < 80 && !this.closed; i++) {
        try {
          await this.sdk.integration.get({ integrationID, location });
          found = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (!found) {
        this.opts.warn(
          `credential: integration "${cred.providerID}" not in the catalog after 20s — key not registered (a config-defined provider still reads options.apiKey)`,
        );
        continue;
      }
      try {
        await this.sdk.integration.connect.key({
          integrationID,
          key: cred.key,
          location,
          label: 'percussionist',
        });
        connected++;
        // The connection is folded into the model registry asynchronously;
        // prompt() waits for the specific requested model (waitForModel).
        this.opts.log(`credential: ${cred.providerID} api key connected`);
      } catch (e) {
        this.opts.warn(`credential: connect.key(${cred.providerID}) failed: ${describe(e)}`);
      }
    }
    if (connected > 0) this.opts.log(`credential: ${connected} provider(s) ready`);
  }

  /**
   * Bridge SDK events to the three v1 events the dispatcher understands.
   * Re-subscribes on error for as long as the host is open.
   */
  private async pumpEvents(): Promise<void> {
    while (!this.closed) {
      try {
        for await (const raw of this.sdk.events.subscribe({}, { signal: this.abort.signal })) {
          const ev = raw as unknown as SdkEvent;
          const type = ev.type ?? '';
          const sessionID = ev.data?.sessionID;
          if (this.opts.logEvents)
            this.opts.log(`event ${type}${sessionID ? ` (${sessionID})` : ''}`);
          if (!sessionID || !this.sessions.has(sessionID)) continue;

          if (USAGE_EVENTS.has(type)) {
            const info = await this.latestAssistantInfo(sessionID, ev.data?.assistantMessageID);
            if (info) this.publish({ type: 'message.updated', properties: { info } });
            continue;
          }
          if (TERMINAL_EVENTS.has(type)) {
            // Usage is final by now; flush it once more before parking so the
            // dispatcher's totals include the closing turn.
            const info = await this.latestAssistantInfo(sessionID, undefined);
            if (info) this.publish({ type: 'message.updated', properties: { info } });
            if (type === 'session.execution.failed') {
              this.opts.warn(
                `session ${sessionID} execution failed: ${JSON.stringify(ev.data?.error ?? {})}`,
              );
            }
            this.publish({
              type: 'session.idle',
              properties: { sessionID, agent: this.sessions.get(sessionID)?.agent },
            });
            continue;
          }
          if (type.startsWith('permission.') && this.opts.permissionMode === 'ask') {
            this.publish({ type: 'permission.updated', properties: { sessionID, ...ev.data } });
          }
        }
        if (!this.closed) this.opts.warn('event stream ended; resubscribing');
      } catch (e) {
        if (this.closed || this.abort.signal.aborted) return;
        this.opts.warn(`event stream error: ${describe(e)}; resubscribing in 1s`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') return JSON.stringify(e).slice(0, 300);
  return String(e);
}
