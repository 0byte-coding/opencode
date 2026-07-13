import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Plugin } from "../plugin"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"

const DESCRIPTION = `Call a tool or skill by its exact name with the arguments it expects.

Use list_tools first to discover available names and, if needed, their full parameter schema. Skills are called the
same way as any other tool — pass the skill's name here with no \`args\` (or \`{}\`).
Calling an unknown name returns an error listing the tools and skills that are actually available.`

export const ID = "call_tool"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({
    description: "The exact name of the tool or skill to call, as returned by list_tools.",
  }),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Arguments to pass to the tool, matching its parameter schema. Omit for tools that take no arguments.",
  }),
})

export function CallToolTool(getTargets: () => Tool.Def[]) {
  return Tool.define(
    ID,
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const skill = yield* Skill.Service
      const agents = yield* Agent.Service

      return {
        description: DESCRIPTION,
        parameters: Parameters,
        execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
          Effect.gen(function* () {
            const targets = getTargets()

            const dispatch = (toolID: string, tool: Tool.Def, args: Record<string, unknown>) =>
              Effect.gen(function* () {
                yield* plugin.trigger(
                  "tool.execute.before",
                  { tool: toolID, sessionID: ctx.sessionID, callID: ctx.callID },
                  { args },
                )
                const result = yield* tool.execute(args, ctx)
                yield* plugin.trigger(
                  "tool.execute.after",
                  { tool: toolID, sessionID: ctx.sessionID, callID: ctx.callID, args },
                  result,
                )
                return result
              })

            const target = targets.find((tool) => tool.id === params.name)
            if (target) return yield* dispatch(target.id, target, params.args ?? {})

            // Not a registered tool by that exact name. Skills are discovered live
            // rather than snapshotted into `targets`, so try `name` as a skill name
            // before giving up — this is how skills added/removed mid-session stay
            // callable without needing a registry rebuild.
            const skillTool = targets.find((tool) => tool.id === "skill")
            yield* skill.reload()
            const skillInfo = yield* skill.get(params.name)
            if (skillInfo && skillTool) return yield* dispatch("skill", skillTool, { name: params.name })

            const agent = yield* agents.get(ctx.agent)
            const available = [...targets.map((tool) => tool.id), ...(yield* skill.available(agent)).map((item) => item.name)]
              .toSorted((a, b) => a.localeCompare(b))
              .join(", ")
            return {
              title: "Tool not found",
              output: `Error: no tool or skill named "${params.name}" is available. Call list_tools to see available tools: ${available}`,
              metadata: {},
            }
          }),
      }
    }),
  )
}
