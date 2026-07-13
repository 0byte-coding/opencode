import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { ToolJsonSchema } from "./json-schema"

const DESCRIPTION = `List the tools currently available, or fetch full usage details for specific tools.

Call this with no arguments to get a compact list of every available tool (name and one-line description).
Pass \`names\` with one or more tool names to get each tool's full description and parameter schema before calling it with call_tool.

Always call list_tools before call_tool if you are not already certain of a tool's exact name and required arguments.`

export const ID = "list_tools"

export const Parameters = Schema.Struct({
  names: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Tool name(s) to get full details (description + parameters) for. Omit to list every available tool with a short description only.",
  }),
})

export function ListToolsTool(getTargets: () => Tool.Def[]) {
  return Tool.define(
    ID,
    Effect.succeed({
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const targets = getTargets()

          if (params.names && params.names.length > 0) {
            const details = params.names.map((name) => {
              const target = targets.find((tool) => tool.id === name)
              if (!target) return { name, error: `no tool named "${name}" is available` }
              return {
                name: target.id,
                description: target.description,
                parameters: ToolJsonSchema.fromTool(target),
              }
            })
            return {
              title: `Tool details (${details.length})`,
              output: JSON.stringify(details, null, 2),
              metadata: {},
            }
          }

          const list = targets
            .toSorted((a, b) => a.id.localeCompare(b.id))
            .map((tool) => ({ name: tool.id, description: tool.description.split("\n")[0] }))
          return {
            title: `Available tools (${list.length})`,
            output: JSON.stringify(list, null, 2),
            metadata: {},
          }
        }),
    }),
  )
}
