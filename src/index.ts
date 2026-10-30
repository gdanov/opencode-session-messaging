import { Plugin } from "@opencode/plugin"
import { startDirectory, type Peer } from "./directory.ts"
import { envelope, MESSAGE_CHAR_LIMIT } from "./envelope.ts"

const LIST_TOOL = "list_sessions"
const SEND_TOOL = "send_message"

const format = (peers: readonly Peer[]): string =>
  peers
    .map((peer) => {
      const title = peer.title ? ` ${peer.title}` : ""
      const directory = peer.directory ? `  cwd=${peer.directory}` : ""
      return `${peer.id}  [${peer.status}]${title}${directory}`
    })
    .join("\n")

const listing = (peers: readonly Peer[]): string => {
  if (peers.length === 0) {
    return "No other sessions are reachable. Another session has to be running, and this plugin has to be loaded in the server that hosts it."
  }
  return [
    "Reachable sessions, newest first. Send with send_message and one of these IDs.",
    "",
    format(peers),
  ].join("\n")
}

/** Resolves a full session ID or a unique prefix of one. */
const resolve = (peers: readonly Peer[], target: string): Peer | "ambiguous" | undefined => {
  const exact = peers.find((peer) => peer.id === target)
  if (exact !== undefined) return exact
  const matches = peers.filter((peer) => peer.id.startsWith(target))
  return matches.length === 1 ? matches[0] : matches.length > 1 ? "ambiguous" : undefined
}

export default Plugin.define({
  id: "session-messaging",
  async setup(ctx) {
    const directory = await startDirectory(ctx)

    const registration = await ctx.tool.transform((editor) => {
      editor.add({
        name: LIST_TOOL,
        options: { codemode: false },
        description:
          "List the other OpenCode sessions on this machine: ID, whether the session is idle or running, its title, and its working directory.",
        input: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
        execute: async (_input, tool) => ({
          content: listing(await directory.peers(tool.sessionID)),
        }),
      })

      editor.add({
        name: SEND_TOOL,
        options: { codemode: false },
        description:
          "Send a message to another OpenCode session on this machine. For cross-session coordination only: a fact that changes or unblocks the other session's work. Not for delegating your own task, not for asking the user for permission, and not for acknowledgements.",
        input: {
          type: "object",
          properties: {
            to: {
              type: "string",
              description: `Target session ID from ${LIST_TOOL}; a unique prefix is accepted.`,
            },
            message: {
              type: "string",
              minLength: 1,
              maxLength: MESSAGE_CHAR_LIMIT,
              description:
                "The message. State what changed, what the target must do differently, and anything it needs to verify. No secrets.",
            },
            expects_reply: {
              type: "boolean",
              description:
                "True only when you are blocked on an answer from the target. A reply, if sent, arrives later as another cross-session message.",
            },
            delivery: {
              type: "string",
              enum: ["steer", "queue"],
              description:
                "steer (default) delivers after the target's current tool call, inside its turn. queue waits for the target's current turn to finish.",
            },
          },
          required: ["to", "message"],
          additionalProperties: false,
        },
        execute: async (raw, tool) => {
          const input = raw as {
            to: string
            message: string
            expects_reply?: boolean
            delivery?: "steer" | "queue"
          }

          const peers = await directory.peers(tool.sessionID)
          if (peers.length === 0) {
            return { content: listing(peers), metadata: { delivered: false } }
          }

          const target = resolve(peers, input.to)
          if (target === undefined || target === "ambiguous") {
            const candidates =
              target === "ambiguous"
                ? peers.filter((peer) => peer.id.startsWith(input.to))
                : peers
            return {
              content: `${target === "ambiguous" ? `"${input.to}" matches more than one session.` : `No reachable session matches "${input.to}".`} Do not guess.\n\n${listing(
                candidates,
              )}`,
              metadata: { delivered: false },
            }
          }

          const text = input.message.trim()
          if (text.length === 0) {
            return { content: "The message is empty; nothing was sent.", metadata: { delivered: false } }
          }

          const delivery = input.delivery === "queue" ? "queue" : "steer"
          const self = await ctx.session.get({ sessionID: tool.sessionID }).catch((cause: unknown) => {
            console.error("session-messaging: could not read own session for the envelope", cause)
            return undefined
          })
          const cwd = self?.location.directory ?? ctx.location.directory
          const branch = await ctx.vcs
            .get({ location: { directory: cwd } })
            .then((result) => result.data.branch.current)
            .catch((cause: unknown) => {
              console.error("session-messaging: could not read the branch for the envelope", cause)
              return undefined
            })
          const from = { id: tool.sessionID, title: self?.title, directory: cwd, branch }

          try {
            await ctx.session.prompt({
              sessionID: target.id,
              text: envelope({
                from,
                to: target,
                text,
                expectsReply: input.expects_reply === true,
              }),
              delivery,
            })
          } catch (cause) {
            console.error("session-messaging: delivery failed", target.id, cause)
            return {
              content: `Delivery to ${target.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              metadata: { delivered: false, to: target.id },
            }
          }

          return {
            content: `Delivered to ${target.id} (${delivery}). Nothing is returned here: a reply, if the target sends one, arrives later as its own cross-session message. Do not wait or poll.`,
            metadata: { delivered: true, to: target.id, delivery },
          }
        },
      })
    })

    return async () => {
      directory.stop()
      await registration.dispose()
    }
  },
})
