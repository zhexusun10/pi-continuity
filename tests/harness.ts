import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore, InMemoryModelsStore, fauxProvider, type FauxResponseStep, type Message,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSessionEvent, type ExtensionFactory, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import piContinuity from "../extensions/index.ts";
import { CHECKPOINT_TYPE, CONTINUATION_TYPE } from "../lib/continuity.ts";

export async function createHarness(options: {
  enabled?: boolean;
  nativeRetries?: number;
  flags?: Record<string, boolean | string>;
  tools?: ToolDefinition[];
  before?: ExtensionFactory;
  after?: ExtensionFactory;
  compaction?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-continuity-test-"));
  const faux = fauxProvider({ models: [{ id: "test", contextWindow: 1_000_000, maxTokens: 16 }] });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: options.compaction ?? false },
    retry: { enabled: (options.nativeRetries ?? 0) > 0, maxRetries: options.nativeRetries ?? 0, baseDelayMs: 0 },
    cacheWarming: "off",
  });
  const factories: ExtensionFactory[] = [];
  if (options.before) factories.push(options.before);
  if (options.enabled !== false) factories.push(piContinuity);
  if (options.after) factories.push(options.after);
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: join(root, "agent"), settingsManager: settings, extensionFactories: factories,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.flagValues.set("continuity-stream-delay-ms", "0");
  for (const [key, value] of Object.entries(options.flags ?? {})) loaded.runtime.flagValues.set(key, value);
  const manager = SessionManager.inMemory(root);
  const { session } = await createAgentSession({
    cwd: root, agentDir: join(root, "agent"), model: faux.getModel(), modelRuntime: runtime,
    resourceLoader: loader, sessionManager: manager, settingsManager: settings,
    noTools: "builtin", customTools: options.tools,
  });
  const errors: string[] = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  const requests: Message[][] = [];
  function setResponses(responses: FauxResponseStep[]) {
    faux.setResponses(responses.map((response) => async (context, streamOptions, state, model) => {
      requests.push(structuredClone(context.messages));
      return typeof response === "function" ? response(context, streamOptions, state, model) : response;
    }));
  }
  return {
    session, manager, faux, requests, events, errors, setResponses,
    continuations: () => manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE),
    checkpoints: () => manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === CHECKPOINT_TYPE),
    cleanup: () => { session.dispose(); rmSync(root, { recursive: true, force: true }); },
  };
}

export function allText(messages: Message[]): string {
  return messages.map((message) => typeof message.content === "string" ? message.content :
    message.content.map((block) => block.type === "text" ? block.text : "").join("\n")).join("\n");
}
