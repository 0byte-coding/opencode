import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260621000000_session_system_prompt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`system_prompt\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
