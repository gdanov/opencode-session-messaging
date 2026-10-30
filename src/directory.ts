/**
 * Which sessions exist and which are reachable.
 *
 * The server sees every session on the machine, so the event stream is the
 * primary source: it reports sessions in other directories and other projects
 * as they are created, renamed, moved, started and finished. Storage keeps the
 * directory across server restarts, so a session that started before this
 * plugin loaded is still listed.
 */

import type { Plugin } from "@opencode/plugin"

const STORAGE_PREFIX = "session-messaging/sessions/"
const STALE_MS = 24 * 60 * 60 * 1000
const SEED_LIMIT = 50

const EVENTS = new Set([
  "session.created",
  "session.deleted",
  "session.renamed",
  "session.moved",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

export interface Peer {
  readonly id: string
  readonly title?: string
  readonly directory?: string
  readonly status: "idle" | "running"
  readonly updatedAt: number
}

interface Entry extends Peer {
  readonly parentID?: string
}

/** One session event, reduced to the fields the directory needs. */
interface Change {
  readonly type: string
  readonly sessionID: string
  readonly createdAt: number
  readonly title?: string
  readonly directory?: string
  readonly parentID?: string
}

export interface SessionDirectory {
  /** Reachable sessions other than `self`, newest first. */
  readonly peers: (self: string) => Promise<readonly Peer[]>
  readonly stop: () => void
}

const key = (id: string) => `${STORAGE_PREFIX}${encodeURIComponent(id)}`

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined

const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/** Reads the parts of a session event this plugin acts on; undefined when irrelevant. */
const readChange = (event: unknown): Change | undefined => {
  const type = string(field(event, "type"))
  if (type === undefined || !EVENTS.has(type)) return undefined

  const data = field(event, "data")
  const sessionID = string(field(data, "sessionID"))
  if (sessionID === undefined) return undefined

  const createdAt = field(event, "created")
  const location = field(data, "location")

  return {
    type,
    sessionID,
    createdAt: typeof createdAt === "number" ? createdAt : Date.now(),
    title: string(field(data, "title")),
    directory: string(field(location, "directory")),
    parentID: string(field(data, "parentID")),
  }
}

const record = (entry: Entry): Record<string, string | number> => {
  const value: Record<string, string | number> = { id: entry.id, updatedAt: entry.updatedAt }
  if (entry.title !== undefined) value["title"] = entry.title
  if (entry.directory !== undefined) value["directory"] = entry.directory
  if (entry.parentID !== undefined) value["parentID"] = entry.parentID
  return value
}

const readRecord = (value: unknown): Entry | undefined => {
  const id = string(field(value, "id"))
  const updatedAt = field(value, "updatedAt")
  if (id === undefined || typeof updatedAt !== "number") return undefined
  if (field(value, "title") !== undefined && string(field(value, "title")) === undefined) {
    return undefined
  }
  if (field(value, "directory") !== undefined && string(field(value, "directory")) === undefined) {
    return undefined
  }
  if (field(value, "parentID") !== undefined && string(field(value, "parentID")) === undefined) {
    return undefined
  }

  return {
    id,
    updatedAt,
    title: string(field(value, "title")),
    directory: string(field(value, "directory")),
    parentID: string(field(value, "parentID")),
    status: "idle",
  }
}

export const startDirectory = async (ctx: Plugin.Context): Promise<SessionDirectory> => {
  const live = new Map<string, Entry>()

  const remember = async (entry: Entry) => {
    live.set(entry.id, entry)
    await ctx.storage.set(key(entry.id), record(entry))
  }

  const forget = async (id: string) => {
    live.delete(id)
    await ctx.storage.remove(key(id))
  }

  const apply = async (change: Change) => {
    if (change.type === "session.deleted") {
      await forget(change.sessionID)
      return
    }

    const current = live.get(change.sessionID)

    if (change.type === "session.created") {
      await remember({
        id: change.sessionID,
        title: change.title,
        directory: change.directory,
        parentID: change.parentID,
        status: "idle",
        updatedAt: change.createdAt,
      })
      return
    }

    if (current === undefined) return

    const status =
      change.type === "session.execution.started"
        ? "running"
        : change.type === "session.execution.succeeded" ||
            change.type === "session.execution.failed" ||
            change.type === "session.execution.interrupted"
          ? "idle"
          : current.status

    await remember({
      ...current,
      title: change.title ?? current.title,
      directory: change.directory ?? current.directory,
      status,
      updatedAt: change.createdAt,
    })
  }

  const seed = async () => {
    const page = await ctx.session.list({ limit: SEED_LIMIT, order: "desc", parentID: null })
    page.data
      .filter((session) => session.parentID === undefined)
      .forEach((session) => {
        live.set(session.id, {
          id: session.id,
          title: session.title,
          directory: session.location.directory,
          status: "idle",
          updatedAt: session.time.updated,
        })
      })
  }

  const peers = async (self: string) => {
    const all = new Map<string, Entry>(live)

    let after: string | undefined
    do {
      const page = await ctx.storage.scan({ prefix: STORAGE_PREFIX, limit: 200, after })
      page.entries.forEach((entry) => {
        const value = readRecord(entry.value)
        if (value === undefined) return
        const current = all.get(value.id)
        if (current === undefined || value.updatedAt >= current.updatedAt) {
          all.set(value.id, { ...value, status: current?.status ?? "idle" })
        }
      })
      after = page.next
    } while (after !== undefined)

    const now = Date.now()
    return [...all.values()]
      .filter((entry) => entry.id !== self)
      .filter((entry) => entry.parentID === undefined)
      .filter((entry) => now - entry.updatedAt < STALE_MS)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  const controller = new AbortController()

  const observe = async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      const change = readChange(event)
      if (change === undefined) continue
      try {
        await apply(change)
      } catch (cause) {
        console.error("session-messaging: failed to record session event", change.type, cause)
      }
    }
  }

  await seed().catch((cause) => {
    console.error("session-messaging: failed to seed session directory", cause)
  })

  void observe().catch((cause: unknown) => {
    if (!controller.signal.aborted) {
      console.error("session-messaging: session event stream ended", cause)
    }
  })

  return { peers, stop: () => controller.abort() }
}
