import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"
import { SessionStatus } from "../../src/session/status"
import { SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { NpmTest } from "../fake/npm"

const emptyAccount = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
  activeOrg: () => Effect.succeed(Option.none()),
})
const emptyAuth = Layer.mock(Auth.Service)({
  all: () => Effect.succeed({}),
})
const configLayer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(emptyAuth),
  Layer.provide(emptyAccount),
  Layer.provide(NpmTest.noop),
)
const it = testEffect(
  Layer.mergeAll(
    Plugin.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(configLayer),
      Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
    ),
    Bus.layer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

describe("plugin.waitForPendingEvents", () => {
  it.live("does not exit before async event handlers complete", () =>
    provideTmpdirInstance((dir) => {
      const completionFile = path.join(dir, "completion.txt")
      const file = path.join(dir, "plugin.ts")
      return Effect.gen(function* () {
        yield* Effect.all(
          [
            Effect.promise(() =>
              Bun.write(
                file,
                [
                  `const completionFile = ${JSON.stringify(completionFile)}`,
                  "export default async () => ({",
                  "  event: async ({ event }) => {",
                  "    if (event.type === 'session.idle') {",
                  "      await Bun.sleep(200)",
                  "      await Bun.write(completionFile, 'completed')",
                  "    }",
                  "  },",
                  "})",
                  "",
                ].join("\n"),
              ),
            ),
            Effect.promise(() =>
              Bun.write(
                path.join(dir, "opencode.json"),
                JSON.stringify(
                  {
                    $schema: "https://opencode.ai/config.json",
                    plugin: [pathToFileURL(file).href],
                  },
                  null,
                  2,
                ),
              ),
            ),
          ],
          { discard: true, concurrency: 2 },
        )

        const plugin = yield* Plugin.Service
        const bus = yield* Bus.Service

        yield* plugin.init()
        yield* Effect.sleep("50 millis")

        yield* bus.publish(SessionStatus.Event.Idle, {
          sessionID: SessionID.make("session_test"),
        })

        yield* plugin.waitForPendingEvents(1000)

        const fileExists = yield* Effect.promise(() => Bun.file(completionFile).exists())
        expect(fileExists).toBe(true)

        if (fileExists) {
          const content = yield* Effect.promise(() => Bun.file(completionFile).text())
          expect(content).toBe("completed")
        }
      })
    }),
  )

  it.live("respects timeout and doesn't wait forever", () =>
    provideTmpdirInstance((dir) => {
      const file = path.join(dir, "plugin.ts")
      return Effect.gen(function* () {
        yield* Effect.all(
          [
            Effect.promise(() =>
              Bun.write(
                file,
                [
                  "export default async () => ({",
                  "  event: async ({ event }) => {",
                  "    if (event.type === 'session.idle') {",
                  "      await Bun.sleep(500)",
                  "    }",
                  "  },",
                  "})",
                  "",
                ].join("\n"),
              ),
            ),
            Effect.promise(() =>
              Bun.write(
                path.join(dir, "opencode.json"),
                JSON.stringify(
                  {
                    $schema: "https://opencode.ai/config.json",
                    plugin: [pathToFileURL(file).href],
                  },
                  null,
                  2,
                ),
              ),
            ),
          ],
          { discard: true, concurrency: 2 },
        )

        const plugin = yield* Plugin.Service
        const bus = yield* Bus.Service

        yield* plugin.init()
        yield* Effect.sleep("50 millis")

        yield* bus.publish(SessionStatus.Event.Idle, {
          sessionID: SessionID.make("session_test"),
        })

        const start = Date.now()
        yield* plugin.waitForPendingEvents(100)
        const elapsed = Date.now() - start

        // Should timeout around 100ms, not wait for the full 500ms
        expect(elapsed).toBeGreaterThan(50)
        expect(elapsed).toBeLessThan(400)
      })
    }),
  )
})
