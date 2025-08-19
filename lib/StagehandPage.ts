import type { CDPSession, Page as PlaywrightPage, Frame } from "playwright";
import { selectors } from "playwright";
import { z } from "zod/v3";
import { Page, defaultExtractSchema } from "../types/page";
import {
  ExtractOptions,
  ExtractResult,
  ObserveOptions,
  ObserveResult,
} from "../types/stagehand";
import { StagehandAPI } from "./api";
import { StagehandActHandler } from "./handlers/actHandler";
import { StagehandExtractHandler } from "./handlers/extractHandler";
import { StagehandObserveHandler } from "./handlers/observeHandler";
import { ActOptions, ActResult, GotoOptions, Stagehand } from "./index";
import { LLMClient } from "./llm/LLMClient";
import { StagehandContext } from "./StagehandContext";
import { EncodedId, EnhancedContext } from "../types/context";
import { clearOverlays } from "./utils";
import {
  StagehandError,
  StagehandNotInitializedError,
  StagehandEnvironmentError,
  CaptchaTimeoutError,
  MissingLLMConfigurationError,
  HandlerNotInitializedError,
  StagehandDefaultError,
  ExperimentalApiConflictError,
} from "../types/stagehandErrors";
import { StagehandAPIError } from "@/types/stagehandApiErrors";
import { scriptContent } from "@/lib/dom/build/scriptContent";
import type { Protocol } from "devtools-protocol";

async function getCurrentRootFrameId(session: CDPSession): Promise<string> {
  const { frameTree } = (await session.send(
    "Page.getFrameTree",
  )) as Protocol.Page.GetFrameTreeResponse;
  return frameTree.frame.id;
}

/** ensure we register the custom selector only once per process */
let stagehandSelectorRegistered = false;

export class StagehandPage {
  private stagehand: Stagehand;
  private rawPage: PlaywrightPage;
  private intPage: Page;
  private intContext: StagehandContext;
  private actHandler: StagehandActHandler;
  private extractHandler: StagehandExtractHandler;
  private observeHandler: StagehandObserveHandler;
  private llmClient: LLMClient;
  private cdpClient: CDPSession | null = null;
  private api: StagehandAPI;
  private userProvidedInstructions?: string;
  private waitForCaptchaSolves: boolean;
  private initialized: boolean = false;
  private readonly cdpClients = new WeakMap<
    PlaywrightPage | Frame,
    CDPSession
  >();
  private fidOrdinals: Map<string | undefined, number> = new Map([
    [undefined, 0],
  ]);

  private rootFrameId!: string;

  public get frameId(): string {
    return this.rootFrameId;
  }

  public updateRootFrameId(newId: string): void {
    this.rootFrameId = newId;
  }

  constructor(
    page: PlaywrightPage,
    stagehand: Stagehand,
    context: StagehandContext,
    llmClient: LLMClient,
    userProvidedInstructions?: string,
    api?: StagehandAPI,
    waitForCaptchaSolves?: boolean,
  ) {
    if (stagehand.experimental && api) {
      throw new ExperimentalApiConflictError();
    }
    this.rawPage = page;
    // Create a proxy to intercept all method calls and property access
    this.intPage = new Proxy(page, {
      get: (target: PlaywrightPage, prop: keyof PlaywrightPage) => {
        // Special handling for our enhanced methods before initialization
        if (
          !this.initialized &&
          (prop === ("act" as keyof Page) ||
            prop === ("extract" as keyof Page) ||
            prop === ("observe" as keyof Page) ||
            prop === ("on" as keyof Page))
        ) {
          return () => {
            throw new StagehandNotInitializedError(String(prop));
          };
        }

        const value = target[prop];
        // If the property is a function, wrap it to update active page before execution
        if (typeof value === "function" && prop !== "on") {
          return (...args: unknown[]) => value.apply(target, args);
        }
        return value;
      },
    }) as Page;

    this.stagehand = stagehand;
    this.intContext = context;
    this.llmClient = llmClient;
    this.api = api;
    this.userProvidedInstructions = userProvidedInstructions;
    this.waitForCaptchaSolves = waitForCaptchaSolves ?? false;

    if (this.llmClient) {
      this.actHandler = new StagehandActHandler({
        logger: this.stagehand.logger,
        stagehandPage: this,
        selfHeal: this.stagehand.selfHeal,
        experimental: this.stagehand.experimental,
      });
      this.extractHandler = new StagehandExtractHandler({
        stagehand: this.stagehand,
        logger: this.stagehand.logger,
        stagehandPage: this,
        userProvidedInstructions,
        experimental: this.stagehand.experimental,
      });
      this.observeHandler = new StagehandObserveHandler({
        stagehand: this.stagehand,
        logger: this.stagehand.logger,
        stagehandPage: this,
        userProvidedInstructions,
        experimental: this.stagehand.experimental,
      });
    }
  }

  public ordinalForFrameId(fid: string | undefined): number {
    if (fid === undefined) return 0;

    const cached = this.fidOrdinals.get(fid);
    if (cached !== undefined) return cached;

    const next: number = this.fidOrdinals.size;
    this.fidOrdinals.set(fid, next);
    return next;
  }

  public encodeWithFrameId(
    fid: string | undefined,
    backendId: number,
  ): EncodedId {
    return `${this.ordinalForFrameId(fid)}-${backendId}` as EncodedId;
  }

  public resetFrameOrdinals(): void {
    this.fidOrdinals = new Map([[undefined, 0]]);
  }

  private async ensureStagehandScript(): Promise<void> {
    try {
      const injected = await this.rawPage.evaluate(
        () => !!window.__stagehandInjected,
      );

      if (injected) return;

      const guardedScript = `if (!window.__stagehandInjected) { \
window.__stagehandInjected = true; \
${scriptContent} \
}`;

      await this.rawPage.addInitScript({ content: guardedScript });
      await this.rawPage.evaluate(guardedScript);
    } catch (err) {
      if (!this.stagehand.isClosed) {
        this.stagehand.log({
          category: "dom",
          message: "Failed to inject Stagehand helper script",
          level: 1,
          auxiliary: {
            error: { value: (err as Error).message, type: "string" },
            trace: { value: (err as Error).stack, type: "string" },
          },
        });
        throw err;
      }
    }
  }

  /** Register the custom selector engine that pierces open/closed shadow roots. */
  private async ensureStagehandSelectorEngine(): Promise<void> {
    if (stagehandSelectorRegistered) return;
    stagehandSelectorRegistered = true;

    await selectors.register("stagehand", () => {
      type Backdoor = {
        getClosedRoot?: (host: Element) => ShadowRoot | undefined;
      };

      function parseSelector(input: string): { name: string; value: string } {
        // Accept either:  "abc123"  → uses DEFAULT_ATTR
        // or explicitly:  "data-__stagehand-id=abc123"
        const raw = input.trim();
        const eq = raw.indexOf("=");
        if (eq === -1) {
          return {
            name: "data-__stagehand-id",
            value: raw.replace(/^["']|["']$/g, ""),
          };
        }
        const name = raw.slice(0, eq).trim();
        const value = raw
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
        return { name, value };
      }

      function pushChildren(node: Node, stack: Node[]): void {
        if (node.nodeType === Node.DOCUMENT_NODE) {
          const de = (node as Document).documentElement;
          if (de) stack.push(de);
          return;
        }

        if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
          const frag = node as DocumentFragment;
          const hc = frag.children as HTMLCollection | undefined;
          if (hc && hc.length) {
            for (let i = hc.length - 1; i >= 0; i--)
              stack.push(hc[i] as Element);
          } else {
            const cn = frag.childNodes;
            for (let i = cn.length - 1; i >= 0; i--) stack.push(cn[i]);
          }
          return;
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          for (let i = el.children.length - 1; i >= 0; i--)
            stack.push(el.children[i]);
        }
      }

      function* traverseAllTrees(
        start: Node,
      ): Generator<Element, void, unknown> {
        const backdoor = window.__stagehand__ as Backdoor | undefined;
        const stack: Node[] = [];

        if (start.nodeType === Node.DOCUMENT_NODE) {
          const de = (start as Document).documentElement;
          if (de) stack.push(de);
        } else {
          stack.push(start);
        }

        while (stack.length) {
          const node = stack.pop()!;
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            yield el;

            // open shadow
            const open = el.shadowRoot as ShadowRoot | null;
            if (open) stack.push(open);

            // closed shadow via backdoor
            const closed = backdoor?.getClosedRoot?.(el);
            if (closed) stack.push(closed);
          }
          pushChildren(node, stack);
        }
      }

      return {
        query(root: Node, selector: string): Element | null {
          const { name, value } = parseSelector(selector);
          for (const el of traverseAllTrees(root)) {
            if (el.getAttribute(name) === value) return el;
          }
          return null;
        },
        queryAll(root: Node, selector: string): Element[] {
          const { name, value } = parseSelector(selector);
          const out: Element[] = [];
          for (const el of traverseAllTrees(root)) {
            if (el.getAttribute(name) === value) out.push(el);
          }
          return out;
        },
      };
    });
  }

  /**
   * Waits for a captcha to be solved when using Browserbase environment.
   *
   * @param timeoutMs - Optional timeout in milliseconds. If provided, the promise will reject if the captcha solving hasn't started within the given time.
   * @throws StagehandEnvironmentError if called in a LOCAL environment
   * @throws CaptchaTimeoutError if the timeout is reached before captcha solving starts
   * @returns Promise that resolves when the captcha is solved
   */
  public async waitForCaptchaSolve(timeoutMs?: number) {
    if (this.stagehand.env === "LOCAL") {
      throw new StagehandEnvironmentError(
        this.stagehand.env,
        "BROWSERBASE",
        "waitForCaptcha method",
      );
    }

    this.stagehand.log({
      category: "captcha",
      message: "Waiting for captcha",
      level: 1,
    });

    return new Promise<void>((resolve, reject) => {
      let started = false;
      let timeoutId: NodeJS.Timeout;

      if (timeoutMs) {
        timeoutId = setTimeout(() => {
          if (!started) {
            reject(new CaptchaTimeoutError());
          }
        }, timeoutMs);
      }

      this.intPage.on("console", (msg) => {
        if (msg.text() === "browserbase-solving-finished") {
          this.stagehand.log({
            category: "captcha",
            message: "Captcha solving finished",
            level: 1,
          });
          if (timeoutId) clearTimeout(timeoutId);
          resolve();
        } else if (msg.text() === "browserbase-solving-started") {
          started = true;
          this.stagehand.log({
            category: "captcha",
            message: "Captcha solving started",
            level: 1,
          });
        }
      });
    });
  }

  async init(): Promise<StagehandPage> {
    try {
      const page = this.rawPage;
      const stagehand = this.stagehand;

      // Create a proxy that updates active page on method calls
      const handler = {
        get: (target: PlaywrightPage, prop: string | symbol) => {
          const value = target[prop as keyof PlaywrightPage];

          // Inject-on-demand for evaluate
          if (
            prop === "evaluate" ||
            prop === "evaluateHandle" ||
            prop === "$eval" ||
            prop === "$$eval"
          ) {
            return async (...args: unknown[]) => {
              // Make sure helpers exist
              await this.ensureStagehandScript();
              return (value as (...a: unknown[]) => unknown).apply(
                target,
                args,
              );
            };
          }

          // Handle enhanced methods
          if (prop === "act" || prop === "extract" || prop === "observe") {
            if (!this.llmClient) {
              return () => {
                throw new MissingLLMConfigurationError();
              };
            }

            // Use type assertion to safely call the method with proper typing
            type EnhancedMethod = (
              options:
                | ActOptions
                | ExtractOptions<z.AnyZodObject>
                | ObserveOptions,
            ) => Promise<
              ActResult | ExtractResult<z.AnyZodObject> | ObserveResult[]
            >;

            const method = this[prop as keyof StagehandPage] as EnhancedMethod;
            return (options: unknown) => method.call(this, options);
          }

          // Handle screenshots with CDP
          if (prop === "screenshot" && this.stagehand.env === "BROWSERBASE") {
            return async (
              options: {
                type?: "png" | "jpeg";
                quality?: number;
                fullPage?: boolean;
                clip?: { x: number; y: number; width: number; height: number };
                omitBackground?: boolean;
              } = {},
            ) => {
              const cdpOptions: Record<string, unknown> = {
                format: options.type === "jpeg" ? "jpeg" : "png",
                quality: options.quality,
                clip: options.clip,
                omitBackground: options.omitBackground,
                fromSurface: true,
              };

              if (options.fullPage) {
                cdpOptions.captureBeyondViewport = true;
              }

              const data = await this.sendCDP<{ data: string }>(
                "Page.captureScreenshot",
                cdpOptions,
              );

              // Convert base64 to buffer
              const buffer = Buffer.from(data.data, "base64");

              return buffer;
            };
          }

          // Handle goto specially
          if (prop === "goto") {
            const rawGoto: typeof target.goto =
              Object.getPrototypeOf(target).goto.bind(target);
            return async (url: string, options: GotoOptions) => {
              const result = this.api
                ? await this.api.goto(url, {
                    ...options,
                    frameId: this.rootFrameId,
                  })
                : await rawGoto(url, options);

              this.stagehand.addToHistory("navigate", { url, options }, result);

              if (this.waitForCaptchaSolves) {
                try {
                  await this.waitForCaptchaSolve(1000);
                } catch {
                  // ignore
                }
              }

              if (this.stagehand.debugDom) {
                this.stagehand.log({
                  category: "deprecation",
                  message:
                    "Warning: debugDom is not supported in this version of Stagehand",
                  level: 1,
                });
              }
              await target.waitForLoadState("domcontentloaded");
              await this._waitForSettledDom();

              return result;
            };
          }

          // Handle event listeners
          if (prop === "on") {
            return (
              event: keyof PlaywrightPage["on"],
              listener: Parameters<PlaywrightPage["on"]>[1],
            ) => {
              if (event === "popup") {
                return this.context.on("page", async (page: PlaywrightPage) => {
                  const newContext = await StagehandContext.init(
                    page.context(),
                    stagehand,
                  );
                  const newStagehandPage = new StagehandPage(
                    page,
                    stagehand,
                    newContext,
                    this.llmClient,
                  );

                  await newStagehandPage.init();
                  listener(newStagehandPage.page);
                });
              }
              this.intContext.setActivePage(this);
              if (target && !target.isClosed()) { 
                return target.on(event, listener);
              }
            };
          }

          // For all other method calls, update active page
          if (typeof value === "function") {
            return (...args: unknown[]) => value.apply(target, args);
          }

          return value;
        },
      };

      const session = await this.getCDPClient(this.rawPage);
      await session.send("Page.enable");

      const rootId = await getCurrentRootFrameId(session);
      this.updateRootFrameId(rootId);
      this.intContext.registerFrameId(rootId, this);

      this.intPage = new Proxy(page, handler) as unknown as Page;

      // Ensure backdoor and selector engine are ready up front
      await this.ensureStagehandSelectorEngine();

      this.initialized = true;
      return this;
    } catch (err: unknown) {
      if (err instanceof StagehandError || err instanceof StagehandAPIError) {
        throw err;
      }
      throw new StagehandDefaultError(err);
    }
  }

  public get page(): Page {
    return this.intPage;
  }

  public get context(): EnhancedContext {
    return this.intContext.context;
  }

  /**
   * `_waitForSettledDom` waits until the DOM is settled, and therefore is
   * ready for actions to be taken.
   *
   * **Definition of "settled"**
   *   • No in-flight network requests (except WebSocket / Server-Sent-Events).
   *   • That idle state lasts for at least **500 ms** (the "quiet-window").
   *
   * **How it works**
   *   1.  Subscribes to CDP Network and Page events for the main target and all
   *       out-of-process iframes (via `Target.setAutoAttach { flatten:true }`).
   *   2.  Every time `Network.requestWillBeSent` fires, the request ID is added
   *       to an **`inflight`** `Set`.
   *   3.  When the request finishes—`loadingFinished`, `loadingFailed`,
   *       `requestServedFromCache`, or a *data:* response—the request ID is
   *       removed.
   *   4.  *Document* requests are also mapped **frameId → requestId**; when
   *       `Page.frameStoppedLoading` fires the corresponding Document request is
   *       removed immediately (covers iframes whose network events never close).
   *   5.  A **stalled-request sweep timer** runs every 500 ms.  If a *Document*
   *       request has been open for ≥ 2 s it is forcibly removed; this prevents
   *       ad/analytics iframes from blocking the wait forever.
   *   6.  When `inflight` becomes empty the helper starts a 500 ms timer.
   *       If no new request appears before the timer fires, the promise
   *       resolves → **DOM is considered settled**.
   *   7.  A global guard (`timeoutMs` or `stagehand.domSettleTimeoutMs`,
   *       default ≈ 30 s) ensures we always resolve; if it fires we log how many
   *       requests were still outstanding.
   *
   * @param timeoutMs – Optional hard cap (ms).  Defaults to
   *                    `this.stagehand.domSettleTimeoutMs`.
   */
  public async _waitForSettledDom(timeoutMs?: number): Promise<void> {
    const timeout = timeoutMs ?? this.stagehand.domSettleTimeoutMs;
    const client = await this.getCDPClient();

    const hasDoc = !!(await this.page.title().catch(() => false));
    if (!hasDoc) await this.page.waitForLoadState("domcontentloaded");

    await client.send("Network.enable");
    await client.send("Page.enable");
    await client.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [
        { type: "worker", exclude: true },
        { type: "shared_worker", exclude: true },
      ],
    });

    return new Promise<void>((resolve) => {
      const inflight = new Set<string>();
      const meta = new Map<string, { url: string; start: number }>();
      const docByFrame = new Map<string, string>();

      let quietTimer: NodeJS.Timeout | null = null;
      let stalledRequestSweepTimer: NodeJS.Timeout | null = null;

      const clearQuiet = () => {
        if (quietTimer) {
          clearTimeout(quietTimer);
          quietTimer = null;
        }
      };

      const maybeQuiet = () => {
        if (inflight.size === 0 && !quietTimer)
          quietTimer = setTimeout(() => resolveDone(), 500);
      };

      const finishReq = (id: string) => {
        if (!inflight.delete(id)) return;
        meta.delete(id);
        for (const [fid, rid] of docByFrame)
          if (rid === id) docByFrame.delete(fid);
        clearQuiet();
        maybeQuiet();
      };

      const onRequest = (p: Protocol.Network.RequestWillBeSentEvent) => {
        if (p.type === "WebSocket" || p.type === "EventSource") return;

        inflight.add(p.requestId);
        meta.set(p.requestId, { url: p.request.url, start: Date.now() });

        if (p.type === "Document" && p.frameId)
          docByFrame.set(p.frameId, p.requestId);

        clearQuiet();
      };

      const onFinish = (p: { requestId: string }) => finishReq(p.requestId);
      const onCached = (p: { requestId: string }) => finishReq(p.requestId);
      const onDataUrl = (p: Protocol.Network.ResponseReceivedEvent) =>
        p.response.url.startsWith("data:") && finishReq(p.requestId);

      const onFrameStop = (f: Protocol.Page.FrameStoppedLoadingEvent) => {
        const id = docByFrame.get(f.frameId);
        if (id) finishReq(id);
      };

      client.on("Network.requestWillBeSent", onRequest);
      client.on("Network.loadingFinished", onFinish);
      client.on("Network.loadingFailed", onFinish);
      client.on("Network.requestServedFromCache", onCached);
      client.on("Network.responseReceived", onDataUrl);
      client.on("Page.frameStoppedLoading", onFrameStop);

      stalledRequestSweepTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, m] of meta) {
          if (now - m.start > 2_000) {
            inflight.delete(id);
            meta.delete(id);
            this.stagehand.log({
              category: "dom",
              message: "⏳ forcing completion of stalled iframe document",
              level: 2,
              auxiliary: {
                url: {
                  value: m.url.slice(0, 120),
                  type: "string",
                },
              },
            });
          }
        }
        maybeQuiet();
      }, 500);

      maybeQuiet();

      const guard = setTimeout(() => {
        if (inflight.size)
          this.stagehand.log({
            category: "dom",
            message:
              "⚠️ DOM-settle timeout reached – network requests still pending",
            level: 2,
            auxiliary: {
              count: {
                value: inflight.size.toString(),
                type: "integer",
              },
            },
          });
        resolveDone();
      }, timeout);

      const resolveDone = () => {
        client.off("Network.requestWillBeSent", onRequest);
        client.off("Network.loadingFinished", onFinish);
        client.off("Network.loadingFailed", onFinish);
        client.off("Network.requestServedFromCache", onCached);
        client.off("Network.responseReceived", onDataUrl);
        client.off("Page.frameStoppedLoading", onFrameStop);
        if (quietTimer) clearTimeout(quietTimer);
        if (stalledRequestSweepTimer) clearInterval(stalledRequestSweepTimer);
        clearTimeout(guard);
        resolve();
      };
    });
  }

  async act(
    actionOrOptions: string | ActOptions | ObserveResult,
  ): Promise<ActResult> {
    try {
      if (!this.actHandler) {
        throw new HandlerNotInitializedError("Act");
      }

      await clearOverlays(this.page);

      // If actionOrOptions is an ObserveResult, we call actFromObserveResult.
      // We need to ensure there is both a selector and a method in the ObserveResult.
      if (typeof actionOrOptions === "object" && actionOrOptions !== null) {
        // If it has selector AND method => treat as ObserveResult
        if ("selector" in actionOrOptions && "method" in actionOrOptions) {
          const observeResult = actionOrOptions as ObserveResult;

          if (this.api) {
            const result = await this.api.act({
              ...observeResult,
              frameId: this.rootFrameId,
            });
            this.stagehand.addToHistory("act", observeResult, result);
            return result;
          }

          // validate observeResult.method, etc.
          return this.actHandler.actFromObserveResult(observeResult);
        } else {
          // If it's an object but no selector/method,
          // check that it's truly ActOptions (i.e., has an `action` field).
          if (!("action" in actionOrOptions)) {
            throw new StagehandError(
              "Invalid argument. Valid arguments are: a string, an ActOptions object, " +
                "or an ObserveResult WITH 'selector' and 'method' fields.",
            );
          }
        }
      } else if (typeof actionOrOptions === "string") {
        // Convert string to ActOptions
        actionOrOptions = { action: actionOrOptions };
      } else {
        throw new StagehandError(
          "Invalid argument: you may have called act with an empty ObserveResult.\n" +
            "Valid arguments are: a string, an ActOptions object, or an ObserveResult " +
            "WITH 'selector' and 'method' fields.",
        );
      }

      const { action, modelName, modelClientOptions } = actionOrOptions;

      if (this.api) {
        const opts = { ...actionOrOptions, frameId: this.rootFrameId };
        const result = await this.api.act(opts);
        this.stagehand.addToHistory("act", actionOrOptions, result);
        return result;
      }

      const requestId = Math.random().toString(36).substring(2);
      const llmClient: LLMClient = modelName
        ? this.stagehand.llmProvider.getClient(modelName, modelClientOptions)
        : this.llmClient;

      this.stagehand.log({
        category: "act",
        message: "running act",
        level: 1,
        auxiliary: {
          action: {
            value: action,
            type: "string",
          },
          requestId: {
            value: requestId,
            type: "string",
          },
          modelName: {
            value: llmClient.modelName,
            type: "string",
          },
        },
      });

      const result = await this.actHandler.observeAct(
        actionOrOptions,
        this.observeHandler,
        llmClient,
        requestId,
      );
      this.stagehand.addToHistory("act", actionOrOptions, result);
      return result;
    } catch (err: unknown) {
      if (err instanceof StagehandError || err instanceof StagehandAPIError) {
        throw err;
      }
      throw new StagehandDefaultError(err);
    }
  }

  async extract<T extends z.AnyZodObject = typeof defaultExtractSchema>(
    instructionOrOptions?: string | ExtractOptions<T>,
  ): Promise<ExtractResult<T>> {
    try {
      if (!this.extractHandler) {
        throw new HandlerNotInitializedError("Extract");
      }

      await clearOverlays(this.page);

      // check if user called extract() with no arguments
      if (!instructionOrOptions) {
        let result: ExtractResult<T>;
        if (this.api) {
          result = await this.api.extract<T>({ frameId: this.rootFrameId });
        } else {
          result = await this.extractHandler.extract();
        }
        this.stagehand.addToHistory("extract", instructionOrOptions, result);
        return result;
      }

      const options: ExtractOptions<T> =
        typeof instructionOrOptions === "string"
          ? {
              instruction: instructionOrOptions,
              schema: defaultExtractSchema as T,
            }
          : instructionOrOptions.schema
            ? instructionOrOptions
            : {
                ...instructionOrOptions,
                schema: defaultExtractSchema as T,
              };

      const {
        instruction,
        schema,
        modelName,
        modelClientOptions,
        domSettleTimeoutMs,
        useTextExtract,
        selector,
        iframes,
      } = options;

      if (this.api) {
        const opts = { ...options, frameId: this.rootFrameId };
        const result = await this.api.extract<T>(opts);
        this.stagehand.addToHistory("extract", instructionOrOptions, result);
        return result;
      }

      const requestId = Math.random().toString(36).substring(2);
      const llmClient = modelName
        ? this.stagehand.llmProvider.getClient(modelName, modelClientOptions)
        : this.llmClient;

      this.stagehand.log({
        category: "extract",
        message: "running extract",
        level: 1,
        auxiliary: {
          instruction: {
            value: instruction,
            type: "string",
          },
          requestId: {
            value: requestId,
            type: "string",
          },
          modelName: {
            value: llmClient.modelName,
            type: "string",
          },
        },
      });

      const result = await this.extractHandler
        .extract({
          instruction,
          schema,
          llmClient,
          requestId,
          domSettleTimeoutMs,
          useTextExtract,
          selector,
          iframes,
        })
        .catch((e) => {
          this.stagehand.log({
            category: "extract",
            message: "error extracting",
            level: 1,
            auxiliary: {
              error: {
                value: e.message,
                type: "string",
              },
              trace: {
                value: e.stack,
                type: "string",
              },
            },
          });

          if (this.stagehand.enableCaching) {
            this.stagehand.llmProvider.cleanRequestCache(requestId);
          }

          throw e;
        });

      this.stagehand.addToHistory("extract", instructionOrOptions, result);

      return result;
    } catch (err: unknown) {
      if (err instanceof StagehandError || err instanceof StagehandAPIError) {
        throw err;
      }
      throw new StagehandDefaultError(err);
    }
  }

  async observe(
    instructionOrOptions?: string | ObserveOptions,
  ): Promise<ObserveResult[]> {
    try {
      if (!this.observeHandler) {
        throw new HandlerNotInitializedError("Observe");
      }

      await clearOverlays(this.page);

      const options: ObserveOptions =
        typeof instructionOrOptions === "string"
          ? { instruction: instructionOrOptions }
          : instructionOrOptions || {};

      const {
        instruction,
        modelName,
        modelClientOptions,
        domSettleTimeoutMs,
        returnAction = true,
        onlyVisible,
        drawOverlay,
        iframes,
      } = options;

      if (this.api) {
        const opts = { ...options, frameId: this.rootFrameId };
        const result = await this.api.observe(opts);
        this.stagehand.addToHistory("observe", instructionOrOptions, result);
        return result;
      }

      const requestId = Math.random().toString(36).substring(2);
      const llmClient = modelName
        ? this.stagehand.llmProvider.getClient(modelName, modelClientOptions)
        : this.llmClient;

      this.stagehand.log({
        category: "observe",
        message: "running observe",
        level: 1,
        auxiliary: {
          instruction: {
            value: instruction,
            type: "string",
          },
          requestId: {
            value: requestId,
            type: "string",
          },
          modelName: {
            value: llmClient.modelName,
            type: "string",
          },
          ...(onlyVisible !== undefined && {
            onlyVisible: {
              value: onlyVisible ? "true" : "false",
              type: "boolean",
            },
          }),
        },
      });

      const result = await this.observeHandler
        .observe({
          instruction,
          llmClient,
          requestId,
          domSettleTimeoutMs,
          returnAction,
          onlyVisible,
          drawOverlay,
          iframes,
        })
        .catch((e) => {
          this.stagehand.log({
            category: "observe",
            message: "error observing",
            level: 1,
            auxiliary: {
              error: {
                value: e.message,
                type: "string",
              },
              trace: {
                value: e.stack,
                type: "string",
              },
              requestId: {
                value: requestId,
                type: "string",
              },
              instruction: {
                value: instruction,
                type: "string",
              },
            },
          });

          if (this.stagehand.enableCaching) {
            this.stagehand.llmProvider.cleanRequestCache(requestId);
          }

          throw e;
        });

      this.stagehand.addToHistory("observe", instructionOrOptions, result);

      return result;
    } catch (err: unknown) {
      if (err instanceof StagehandError || err instanceof StagehandAPIError) {
        throw err;
      }
      throw new StagehandDefaultError(err);
    }
  }

  /**
   * Get or create a CDP session for the given target.
   * @param target  The Page or (OOPIF) Frame you want to talk to.
   */
  async getCDPClient(
    target: PlaywrightPage | Frame = this.page,
  ): Promise<CDPSession> {
    const cached = this.cdpClients.get(target);
    if (cached) return cached;

    try {
      const session = await this.context.newCDPSession(target);
      this.cdpClients.set(target, session);
      return session;
    } catch (err) {
      // Fallback for same-process iframes
      const msg = (err as Error).message ?? "";
      if (msg.includes("does not have a separate CDP session")) {
        // Re-use / create the top-level session instead
        const rootSession = await this.getCDPClient(this.page);
        // cache the alias so we don't try again for this frame
        this.cdpClients.set(target, rootSession);
        return rootSession;
      }
      throw err;
    }
  }

  /**
   * Send a CDP command to the chosen DevTools target.
   *
   * @param method  Any valid CDP method, e.g. `"DOM.getDocument"`.
   * @param params  Command parameters (optional).
   * @param target  A `Page` or OOPIF `Frame`. Defaults to the main page.
   *
   * @typeParam T  Expected result shape (defaults to `unknown`).
   */
  async sendCDP<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    target?: PlaywrightPage | Frame,
  ): Promise<T> {
    const client = await this.getCDPClient(target ?? this.page);

    return client.send(
      method as Parameters<CDPSession["send"]>[0],
      params as Parameters<CDPSession["send"]>[1],
    ) as Promise<T>;
  }

  /** Enable a CDP domain (e.g. `"Network"` or `"DOM"`) on the chosen target. */
  async enableCDP(
    domain: string,
    target?: PlaywrightPage | Frame,
  ): Promise<void> {
    await this.sendCDP<void>(`${domain}.enable`, {}, target);
  }

  /** Disable a CDP domain on the chosen target. */
  async disableCDP(
    domain: string,
    target?: PlaywrightPage | Frame,
  ): Promise<void> {
    await this.sendCDP<void>(`${domain}.disable`, {}, target);
  }
}
