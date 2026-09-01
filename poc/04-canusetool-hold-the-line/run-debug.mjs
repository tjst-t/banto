import { query } from '@anthropic-ai/claude-agent-sdk';
for await (const m of query({
  prompt: 'Bash tool で `echo hold-the-line-ok` を実行して、結果をそのまま報告して。',
  options: {
    maxTurns: 3,
    settingSources: [],
    permissionMode: 'default',
    canUseTool: async (toolName, input) => {
      console.log('[poc] canUseTool called:', toolName, JSON.stringify(input));
      return { behavior: 'allow', updatedInput: input };
    },
  },
})) {
  console.log(JSON.stringify(m).slice(0, 400));
}
