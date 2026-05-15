import { agent, tool } from "@21st-sdk/agent"
import { z } from "zod"

export default agent({
  model: "claude-sonnet-4-6",
  tools: {
    greet: tool({
      description: "Greet a user by name",
      inputSchema: z.object({
        name: z.string().describe("Name to greet"),
      }),
      execute: async ({ name }) => {
        return {
          content: [{ type: "text", text: `Hello, ${name}!` }],
        }
      },
    }),
  },
})
