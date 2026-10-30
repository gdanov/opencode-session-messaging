import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import plugin from "../src/index.ts"

interface Harness {
  readonly ctx: Plugin.Context
  readonly tools: Map<string, { execute: (input: unknown, context: unknown) => Promise<{ content?: string; metadata?: unknown }> }>
  readonly prompts: Array<{ sessionID: string; text: string; delivery?: string }>
  readonly storage: Map<string, unknown>
  readonly cleanup: () => Promise<void>
}

const harness = async (sessions: readonly { id: string; title?: string; directory?: string; effect?: () => void }[]): Promise<Harness> => {
  const tools = new Map<string, { execute: (input: unknown, context: unknown) => Promise<{ content?: string; metadata?: unknown }> }>()
  const prompts: Array<{ sessionID: string; text: string; delivery?: string }> = []
  const storage = new Map<string, unknown>()

  const ctx = {
    location: { directory: "/repo/self" },
    app: { name: "opencode", version: "test", channel: "test" },
    options: {},
    session: {
      list: async () => ({
        data: sessions.map((session) => ({
          id: session.id,
          title: session.title,
          location: { directory: session.directory ?? "/repo/peer" },
          time: { created: Date.now(), updated: Date.now() },
          cost: 0,
          tokens: {},
          projectID: "p",
        })),
        cursor: {},
      }),
      prompt: async (input: { sessionID: string; text: string; delivery?: string }) => {
        const target = sessions.find((session) => session.id === input.sessionID)
        target?.effect?.()
        prompts.push(input)
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.find((candidate) => candidate.id === sessionID)
        if (session === undefined) throw new Error(`unknown session ${sessionID}`)
        return {
          id: session.id,
          title: session.title,
          location: { directory: session.directory ?? "/repo/self" },
        }
      },
    },
    vcs: {
      get: async () => ({ location: { directory: "/repo/self" }, data: { branch: { current: "main" } } }),
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      scan: async () => ({ entries: [...storage.entries()].map(([key, value]) => ({ key, value })) }),
    },
    // The directory observer ends immediately; this test is about the tools.
    event: { subscribe: () => (async function* () {})() },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        const editor = {
          list: () => [],
          get: () => undefined,
          namespace: () => {},
          add: (definition: { name: string }) => tools.set(definition.name, definition as never),
          update: () => {},
          remove: () => {},
        }
        callback(editor)
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context

  const cleanup = (await plugin.setup(ctx)) as unknown as () => Promise<void>
  return { ctx, tools, prompts, storage, cleanup }
}

const call = async (h: Harness, name: string, input: unknown) => {
  const tool = h.tools.get(name)
  if (tool === undefined) throw new Error(`tool ${name} not registered`)
  return tool.execute(input, { sessionID: "ses_self", signal: new AbortController().signal, progress: async () => {} })
}

describe("session-messaging plugin", () => {
  test("registers the two tools", async () => {
    const h = await harness([])

    expect([...h.tools.keys()].sort()).toEqual(["list_sessions", "send_message"])
    await h.cleanup()
  })

  test("lists peers but never the caller", async () => {
    const h = await harness([
      { id: "ses_self", title: "self", directory: "/repo/self" },
      { id: "ses_api", title: "api work", directory: "/repo/api" },
    ])

    const result = await call(h, "list_sessions", {})

    expect(result.content).toContain("ses_api")
    expect(result.content).toContain("/repo/api")
    expect(result.content).not.toContain("ses_self")
    await h.cleanup()
  })

  test("points at peers in the caller's working directory", async () => {
    const h = await harness([
      { id: "ses_same", title: "same dir", directory: "/repo/self" },
      { id: "ses_other", title: "other dir", directory: "/repo/other" },
    ])

    const result = await call(h, "list_sessions", {})

    expect(result.content).toContain("In your working directory: ses_same")
    expect(result.content).toContain("Do not ask the user whether to coordinate")
    expect(result.content).not.toContain("In your working directory: ses_same, ses_other")
    await h.cleanup()
  })

  test("stays quiet when no peer shares the working directory", async () => {
    const h = await harness([{ id: "ses_api", title: "api work", directory: "/repo/api" }])

    const result = await call(h, "list_sessions", {})

    expect(result.content).not.toContain("In your working directory")
    await h.cleanup()
  })

  test("delivers a framed message to a resolved prefix", async () => {
    const h = await harness([
      { id: "ses_self", title: "sender", directory: "/repo/self" },
      { id: "ses_api", title: "api work", directory: "/repo/api" },
    ])

    const result = await call(h, "send_message", { to: "ses_ap", message: "migration landed" })

    expect(result.metadata).toMatchObject({ delivered: true, to: "ses_api" })
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.sessionID).toBe("ses_api")
    expect(h.prompts[0]?.delivery).toBe("steer")
    expect(h.prompts[0]?.text).toContain(
      "[cross-session message from sender <ses_self> on main in /repo/self]",
    )
    expect(h.prompts[0]?.text).toContain("migration landed")
    expect(h.prompts[0]?.text).toContain("not from your user")
    await h.cleanup()
  })

  test("refuses an ambiguous prefix instead of guessing", async () => {
    const h = await harness([
      { id: "ses_api_one" },
      { id: "ses_api_two" },
    ])

    const result = await call(h, "send_message", { to: "ses_api", message: "hi" })

    expect(result.metadata).toMatchObject({ delivered: false })
    expect(result.content).toContain("more than one session")
    expect(h.prompts).toHaveLength(0)
    await h.cleanup()
  })

  test("never delivers to the caller", async () => {
    const h = await harness([{ id: "ses_self" }])

    const result = await call(h, "send_message", { to: "ses_self", message: "hi" })

    expect(result.metadata).toMatchObject({ delivered: false })
    expect(h.prompts).toHaveLength(0)
    await h.cleanup()
  })

  test("reports a delivery failure without throwing", async () => {
    const h = await harness([
      {
        id: "ses_dead",
        effect: () => {
          throw new Error("session gone")
        },
      },
    ])

    const result = await call(h, "send_message", { to: "ses_dead", message: "hi" })

    expect(result.metadata).toMatchObject({ delivered: false })
    expect(result.content).toContain("session gone")
    await h.cleanup()
  })

  test("honours the queue delivery mode", async () => {
    const h = await harness([{ id: "ses_api" }])

    await call(h, "send_message", { to: "ses_api", message: "later", delivery: "queue" })

    expect(h.prompts[0]?.delivery).toBe("queue")
    await h.cleanup()
  })

})
