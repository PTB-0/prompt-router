import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

// prompt-router's own config loader also reads a plain `.env` from
// `process.cwd()` (`loadDotenv()` with no path — see src/config.ts), so we
// chdir to the repo root ourselves rather than relying on whatever cwd the
// MCP client happens to spawn us with.
process.chdir(repoRoot);

// Same length threshold the CLI uses to skip the paid optimizer call for
// trivially short input (see MIN_PROMPT_LENGTH in src/index.ts).
const MIN_PROMPT_LENGTH = 10;

let loadConfig;
let classify;
try {
  ({ loadConfig } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'config.js'))));
  ({ classify } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'classify.js'))));
} catch (err) {
  process.stderr.write(
    'prompt-router-mcp-server: failed to load dist/config.js or dist/classify.js — ' +
      "run `pnpm build` in the repo root first.\n" +
      `${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
}

const server = new McpServer({ name: 'prompt-router-mcp-server', version: '0.1.0' });

server.registerTool(
  'optimize_and_classify_prompt',
  {
    description:
      "Runs prompt-router's optimize+classify step on a piece of text: rewrites it to be precise and " +
      'actionable, and classifies it as "code" (a coding task), "simple-qa" (a short factual question), or ' +
      '"deep-qa" (a broad open-ended question), with a complexity and confidence score. This is READ-ONLY — ' +
      'unlike the full prompt-router CLI, it never dispatches to Claude Code, a local model, or OpenRouter for ' +
      'an answer. Use it to decide how a task should be framed or where it belongs, not to answer it.',
    inputSchema: {
      prompt: z.string().describe('The raw prompt/text to optimize and classify'),
    },
  },
  async ({ prompt }) => {
    if (prompt.trim().length < MIN_PROMPT_LENGTH) {
      return {
        content: [
          {
            type: 'text',
            text: `Prompt is shorter than ${MIN_PROMPT_LENGTH} characters; skipping the paid optimizer call.`,
          },
        ],
      };
    }

    const config = loadConfig();
    if (!config.openrouter.apiKey) {
      return {
        content: [{ type: 'text', text: 'prompt-router has no OPENROUTER_API_KEY configured.' }],
        isError: true,
      };
    }

    const result = await classify(prompt, config);
    if (result === null) {
      return {
        content: [{ type: 'text', text: 'Classification failed (model call errored or returned unparseable output).' }],
        isError: true,
      };
    }

    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
