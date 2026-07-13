import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { ToolJsonSchema } from "./json-schema"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"

const DESCRIPTION = `List the tools currently available, or fetch full usage details for specific tools.

Call this with no arguments to get a compact list of every available tool and skill (name and short description).
Pass \`search\` to filter that list down to entries whose name or description contains the search term — use this
instead of scanning the full list once there are many tools registered.
Pass \`names\` with one or more exact tool or skill names to get full details (description and parameters) before
calling call_tool.

Skills are included in this listing alongside regular tools and are discovered fresh on every call, so skills added
or removed while opencode is running always show up without needing a restart. Call a skill the same way as any
other tool: call_tool with its name from this list.

Always call list_tools before call_tool if you are not already certain of a tool's exact name and required arguments.`

export const ID = "list_tools"

const SHORT_DESCRIPTION_MAX = 100

function shortDescription(description: string, max = SHORT_DESCRIPTION_MAX) {
  const collapsed = description.replace(/\s+/g, " ").trim()
  return collapsed.length > max ? `${collapsed.slice(0, max)}...` : collapsed
}

function matchesSearch(search: string, name: string, description: string) {
  const needle = search.toLowerCase()
  return name.toLowerCase().includes(needle) || description.toLowerCase().includes(needle)
}

export const Parameters = Schema.Struct({
  names: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Tool or skill name(s) to get full details (description + parameters) for. Omit to list every available tool and skill with a short description only.",
  }),
  search: Schema.optional(Schema.String).annotate({
    description:
      "Only list tools/skills whose name or description contains this text (case-insensitive). Ignored when `names` is given. Use this to narrow down large tool lists instead of reading everything at once.",
  }),
})

export function ListToolsTool(getTargets: () => Tool.Def[]) {
  return Tool.define(
    ID,
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const agents = yield* Agent.Service

      return {
        description: DESCRIPTION,
        parameters: Parameters,
        execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
          Effect.gen(function* () {
            const targets = getTargets()
            // Skills are never cached here — reload() forces the skill catalog to
            // re-scan disk so ones added/removed mid-session show up immediately.
            yield* skill.reload()
            const agent = yield* agents.get(ctx.agent)
            const skills = (yield* skill.available(agent)).filter((item) => item.description !== undefined)

            if (params.names && params.names.length > 0) {
              const details = params.names.map((name) => {
                const target = targets.find((tool) => tool.id === name)
                if (target) {
                  return {
                    name: target.id,
                    kind: "tool",
                    description: target.description,
                    parameters: ToolJsonSchema.fromTool(target),
                  }
                }
                const skillMatch = skills.find((item) => item.name === name)
                if (skillMatch) {
                  return {
                    name: skillMatch.name,
                    kind: "skill",
                    description: skillMatch.description,
                  }
                }
                return { name, error: `no tool or skill named "${name}" is available` }
              })
              return {
                title: `Tool details (${details.length})`,
                output: JSON.stringify(details, null, 2),
                metadata: {},
              }
            }

            // The generic `skill` wrapper tool is an internal dispatch detail now that
            // every skill is individually listed and directly callable by its own name
            // — hide it from the listing so the model has one obvious way to call a
            // skill instead of two (and doesn't see its now-inaccurate "system prompt"
            // description).
            const toolItems = targets
              .filter((tool) => tool.id !== "skill")
              .map((tool) => ({
                name: tool.id,
                kind: "tool" as const,
                description: shortDescription(tool.description),
              }))
            const skillItems = skills.map((item) => ({
              name: item.name,
              kind: "skill" as const,
              description: shortDescription(item.description ?? ""),
            }))

            const combined = [...toolItems, ...skillItems].toSorted((a, b) => a.name.localeCompare(b.name))
            const list = params.search
              ? combined.filter((item) => matchesSearch(params.search!, item.name, item.description))
              : combined

            return {
              title: `Available tools (${list.length})`,
              output: JSON.stringify(list, null, 2),
              metadata: {},
            }
          }),
      }
    }),
  )
}
