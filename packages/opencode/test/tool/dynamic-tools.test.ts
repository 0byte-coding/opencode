import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, SessionID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})

const root = LayerNode.group([ToolRegistry.node, Agent.node])
const baseline = [
  [Config.node, configLayer],
  [RuntimeFlags.node, RuntimeFlags.layer()],
] as const

const it = testEffect(LayerNode.compile(root, baseline))
const withDynamicTools = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalDynamicTools: true })],
  ]),
)

// Fake plugin whose single tool must remain reachable through `call_tool`
// even though dynamic tool mode hides it from the LLM-facing tool list.
const echoPluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () =>
      Effect.succeed([
        {
          tool: {
            echo_plugin_tool: {
              description: "echoes the given text back",
              args: {},
              execute: async (args: { text?: string }) => `echo: ${args.text ?? ""}`,
            },
          },
        },
      ]),
  }),
)
const withDynamicToolsAndPlugin = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalDynamicTools: true })],
    [Plugin.node, echoPluginLayer],
  ]),
)

async function context(): Promise<Tool.Context> {
  return {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry dynamic tools", () => {
  it.instance("keeps the full tool list when dynamic tools is disabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })

      const ids = tools.map((tool) => tool.id)
      expect(ids).toContain("read")
      expect(ids).not.toContain("list_tools")
      expect(ids).not.toContain("call_tool")
    }),
  )

  withDynamicTools.instance("collapses the LLM-facing tool list down to list_tools/call_tool", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })

      expect(tools.map((tool) => tool.id).toSorted()).toEqual(["call_tool", "invalid", "list_tools"])
    }),
  )

  withDynamicTools.instance("still registers every other tool in the full registry", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).toContain("read")
      expect(ids).toContain("bash")
      expect(ids).toContain("list_tools")
      expect(ids).toContain("call_tool")
    }),
  )

  withDynamicTools.instance("list_tools reports every other registered tool with a one-line description", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const all = yield* registry.all()
      const listTools = all.find((tool) => tool.id === "list_tools")
      if (!listTools) throw new Error("list_tools was not registered")

      const result = yield* listTools.execute({}, yield* Effect.promise(context))
      const parsed = JSON.parse(result.output) as Array<{ name: string; description: string }>
      const names = parsed.map((item) => item.name)

      expect(names).toContain("read")
      expect(names).toContain("bash")
      expect(names).not.toContain("list_tools")
      expect(names).not.toContain("call_tool")
      expect(names).not.toContain("invalid")
    }),
  )

  withDynamicTools.instance("list_tools returns full parameter details when given specific names", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const all = yield* registry.all()
      const listTools = all.find((tool) => tool.id === "list_tools")
      if (!listTools) throw new Error("list_tools was not registered")

      const result = yield* listTools.execute({ names: ["read"] }, yield* Effect.promise(context))
      const parsed = JSON.parse(result.output) as Array<{ name: string; description: string; parameters: unknown }>

      expect(parsed).toHaveLength(1)
      expect(parsed[0]?.name).toBe("read")
      expect(parsed[0]?.parameters).toBeDefined()
    }),
  )

  withDynamicTools.instance("call_tool dispatches to a builtin tool by name", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const target = path.join(test.directory, "dynamic-tools-fixture.txt")
      yield* Effect.promise(() => fs.writeFile(target, "hello from dynamic tools"))

      const registry = yield* ToolRegistry.Service
      const all = yield* registry.all()
      const callTool = all.find((tool) => tool.id === "call_tool")
      if (!callTool) throw new Error("call_tool was not registered")

      const result = yield* callTool.execute(
        { name: "read", args: { filePath: target } },
        yield* Effect.promise(context),
      )

      expect(result.output).toContain("hello from dynamic tools")
    }),
  )

  withDynamicTools.instance("call_tool reports an error for an unknown tool name instead of throwing", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const all = yield* registry.all()
      const callTool = all.find((tool) => tool.id === "call_tool")
      if (!callTool) throw new Error("call_tool was not registered")

      const result = yield* callTool.execute({ name: "does_not_exist" }, yield* Effect.promise(context))

      expect(result.output).toContain('no tool named "does_not_exist"')
    }),
  )

  withDynamicTools.instance("call_tool refuses to dispatch to itself or list_tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const all = yield* registry.all()
      const callTool = all.find((tool) => tool.id === "call_tool")
      if (!callTool) throw new Error("call_tool was not registered")

      const result = yield* callTool.execute({ name: "call_tool" }, yield* Effect.promise(context))

      expect(result.output).toContain('no tool named "call_tool"')
    }),
  )

  withDynamicToolsAndPlugin.instance("plugin tools stay reachable through call_tool in dynamic mode", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      expect(tools.map((tool) => tool.id)).not.toContain("echo_plugin_tool")

      const all = yield* registry.all()
      const callTool = all.find((tool) => tool.id === "call_tool")
      if (!callTool) throw new Error("call_tool was not registered")

      const result = yield* callTool.execute(
        { name: "echo_plugin_tool", args: { text: "hi" } },
        yield* Effect.promise(context),
      )

      expect(result.output).toBe("echo: hi")
    }),
  )
})
