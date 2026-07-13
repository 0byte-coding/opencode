import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Plugin } from "../plugin"

const DESCRIPTION = `Call a tool by its exact name with the arguments it expects.

Use list_tools first to discover available tool names and, if needed, their full parameter schema.
Calling an unknown tool name returns an error listing the tools that are actually available.`

export const ID = "call_tool"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The exact name of the tool to call, as returned by list_tools." }),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Arguments to pass to the tool, matching its parameter schema. Omit for tools that take no arguments.",
  }),
})

export function CallToolTool(getTargets: () => Tool.Def[]) {
  return Tool.define(
    ID,
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service

      return {
        description: DESCRIPTION,
        parameters: Parameters,
        execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
          Effect.gen(function* () {
            const targets = getTargets()
            const target = targets.find((tool) => tool.id === params.name)
            if (!target) {
              const available = targets
                .map((tool) => tool.id)
                .toSorted((a, b) => a.localeCompare(b))
                .join(", ")
              return {
                title: "Tool not found",
                output: `Error: no tool named "${params.name}" is available. Call list_tools to see available tools: ${available}`,
                metadata: {},
              }
            }

            const args = params.args ?? {}
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: target.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const result = yield* target.execute(args, ctx)
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: target.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              result,
            )
            return result
          }),
      }
    }),
  )
}
