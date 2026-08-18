import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

// prompt-router's own config loader reads `.env` from `process.cwd()`
// (`loadDotenv()` with no path — see src/config.ts), so this only finds the
// real OPENROUTER_API_KEY when process.cwd() is the repo root. Venus is
// configured to spawn this script with `cwd` set to the repo root and
// `args: ["mcp-server/index.js"]` for exactly this reason.
const { loadConfig } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'config.js')));
const { classify } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'classify.js')));

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
