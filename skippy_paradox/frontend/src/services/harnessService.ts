import { StoredFile } from './storageService';
import { fetchRawContent, getStoredToken } from './githubService';

const configured = (import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
export const API_BASE = configured ? (configured.endsWith('/api') ? configured : configured + '/api') : '/api';

export interface HarnessEvent {
  type: string;
  content?: string;
  message?: string;
  path?: string;
  previous?: string | null;
  name?: string;
  arguments?: string;
  result?: string;
  status?: string;
  id?: string;
  reason?: string;
  runId?: string;
  token?: string;
  author?: string;
}

export interface RunRequestBody {
  provider: 'ollama' | 'openrouter';
  model: string;
  apiKey?: string;
  prompt: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  files: Array<{ path: string; content: string }>;
}

async function checked(response: Response) {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(typeof error.detail === 'string' ? error.detail : `Server error ${response.status}. Check your configuration.`);
  }
  return response;
}

export const POPULAR_OPENROUTER_MODELS = [
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-lightning',
  'qwen/qwen-2.5-coder-32b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-r1:free',
  'google/gemini-2.0-flash-exp:free',
];

export async function loadModels(provider: string, apiKey: string, accessToken: string) {
  if (provider === 'openrouter') {
    const key = (apiKey || '').trim();
    if (key) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (res.ok) {
          const data = await res.json();
          const list: string[] = (data.data || [])
            .map((m: any) => m.id as string)
            .filter((id: string) => id.includes(':free') || id.includes('nemotron') || id.includes('qwen') || id.includes('llama') || id.includes('deepseek'));

          const nemotrons = list.filter(m => m.includes('nemotron'));
          const others = list.filter(m => !m.includes('nemotron'));
          const combined = Array.from(new Set(['nvidia/nemotron-3.5-lightning:free', ...nemotrons, ...others]));
          return { models: combined };
        }
      } catch {
        // Fall back to predefined list
      }
    }
    return { models: POPULAR_OPENROUTER_MODELS };
  }

  // Ollama fallback to local / backend API
  return (await checked(await fetch(`${API_BASE}/harness/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ provider, apiKey }),
  }))).json();
}

export async function hydrateFiles(files: StoredFile[]): Promise<StoredFile[]> {
  // Fetch lazy repository content before giving it to the agent or GitHub push.
  const result: StoredFile[] = [];
  for (const file of files) {
    if (file.contentLoaded === false) {
      if (!file.repoOrigin) throw new Error(`Load ${file.path || file.name} before continuing.`);
      const origin = file.repoOrigin;
      const content = await fetchRawContent(origin.owner, origin.repo, origin.branch, file.path || file.name, getStoredToken() || undefined);
      result.push({ ...file, content, contentLoaded: true });
    } else result.push({ ...file });
  }
  return result;
}

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Creates a new file or completely replaces the code of an existing file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path of the file to write (e.g. index.html, main.py, src/app.js)' },
          content: { type: 'string', description: 'The complete code or text to write to the file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Reads the complete content of an existing file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path of the file to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Performs an exact search-and-replace edit on an existing file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path of the file to edit' },
          old_string: { type: 'string', description: 'Exact string to be replaced' },
          new_string: { type: 'string', description: 'Replacement string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Lists all files currently in the workspace.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

async function streamOpenRouterDirect(
  body: RunRequestBody,
  signal: AbortSignal,
  onEvent: (event: HarnessEvent) => Promise<void>
) {
  const apiKey = (body.apiKey || '').trim();
  if (!apiKey) {
    throw new Error('Please enter your OpenRouter API key in the Harness settings.');
  }
  let activeModel = body.model || 'nvidia/nemotron-3.5-lightning:free';

  // In-memory workspace map for rapid reading/writing
  const fileMap = new Map<string, string>();
  for (const f of body.files) {
    fileMap.set(f.path, f.content);
  }

  const fileListText = Array.from(fileMap.entries())
    .map(([path, content]) => `- ${path} (${content.length} chars)`)
    .join('\n');

  const systemPrompt = `You are Skippy, an autonomous senior coding assistant in a collaborative web IDE.
When the user asks you to create, modify, or write code, you MUST invoke the 'write_file' or 'edit_file' tools to make actual changes to the workspace files.
Always write clean, complete, working code.
Do not just print code blocks in text when asked to write files — call the appropriate tool.

Current workspace files:
${fileListText || '(No files yet)'}`;

  const messages: any[] = [
    { role: 'system', content: systemPrompt },
  ];

  if (body.history && body.history.length > 0) {
    for (const h of body.history) {
      messages.push({ role: h.role, content: h.content });
    }
  }

  messages.push({ role: 'user', content: body.prompt });

  let iterations = 0;
  const maxIterations = 12;

  while (iterations < maxIterations) {
    if (signal.aborted) throw new Error('Run stopped by user.');
    iterations++;

    await onEvent({ type: 'status', message: `Thinking · step ${iterations}` });

    let res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://skiffy-lilac.vercel.app',
        'X-Title': 'Skippy Collaborative IDE',
      },
      signal,
      body: JSON.stringify({
        model: activeModel,
        messages,
        tools: AGENT_TOOLS,
        tool_choice: 'auto',
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errMsg = err.error?.message || `OpenRouter error ${res.status}`;

      if (activeModel !== 'nvidia/nemotron-3.5-lightning:free' && (res.status === 402 || res.status === 403 || errMsg.includes('credit') || errMsg.includes('endpoint'))) {
        await onEvent({
          type: 'status',
          message: `Model ${activeModel} unavailable on key tier. Switching to nvidia/nemotron-3.5-lightning:free...`,
        });
        activeModel = 'nvidia/nemotron-3.5-lightning:free';
        res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://skiffy-lilac.vercel.app',
            'X-Title': 'Skippy Collaborative IDE',
          },
          signal,
          body: JSON.stringify({
            model: activeModel,
            messages,
            tools: AGENT_TOOLS,
            tool_choice: 'auto',
          }),
        });
        if (!res.ok) {
          const fallbackErr = await res.json().catch(() => ({}));
          throw new Error(fallbackErr.error?.message || `OpenRouter error ${res.status}`);
        }
      } else {
        throw new Error(errMsg);
      }
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const assistantMsg = choice?.message;
    if (!assistantMsg) {
      throw new Error('OpenRouter returned an empty response. Try again.');
    }

    messages.push(assistantMsg);

    if (assistantMsg.content) {
      await onEvent({ type: 'message', content: assistantMsg.content });
    }

    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      for (const tc of assistantMsg.tool_calls) {
        const fnName = tc.function.name;
        let args: any = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          args = {};
        }

        const callId = tc.id || `call-${Date.now()}`;
        await onEvent({
          type: 'tool',
          id: callId,
          name: fnName,
          arguments: tc.function.arguments || '{}',
          status: 'running',
        });

        let toolResultStr = '';
        try {
          if (fnName === 'write_file') {
            const rawPath = String(args.path || 'untitled.txt').replace(/^[/\\]+/, '').trim();
            const newContent = String(args.content ?? '');
            const previous = fileMap.get(rawPath) ?? null;
            fileMap.set(rawPath, newContent);
            await onEvent({
              type: 'file',
              path: rawPath,
              content: newContent,
              previous,
            });
            toolResultStr = `Successfully wrote ${newContent.length} characters to ${rawPath}`;
            await onEvent({
              type: 'tool',
              id: callId,
              name: fnName,
              result: toolResultStr,
              status: 'success',
            });
          } else if (fnName === 'read_file') {
            const rawPath = String(args.path || '').replace(/^[/\\]+/, '').trim();
            const content = fileMap.get(rawPath);
            if (content === undefined) {
              toolResultStr = `Error: File ${rawPath} not found in workspace. Current files: ${Array.from(fileMap.keys()).join(', ')}`;
              await onEvent({
                type: 'tool',
                id: callId,
                name: fnName,
                result: toolResultStr,
                status: 'failed',
              });
            } else {
              toolResultStr = content;
              await onEvent({
                type: 'tool',
                id: callId,
                name: fnName,
                result: `Read ${content.length} characters from ${rawPath}`,
                status: 'success',
              });
            }
          } else if (fnName === 'edit_file' || fnName === 'str_replace') {
            const rawPath = String(args.path || '').replace(/^[/\\]+/, '').trim();
            const oldStr = String(args.old_string ?? args.old_str ?? '');
            const newStr = String(args.new_string ?? args.new_str ?? '');
            const current = fileMap.get(rawPath);
            if (current === undefined) {
              toolResultStr = `Error: File ${rawPath} not found in workspace.`;
              await onEvent({
                type: 'tool',
                id: callId,
                name: fnName,
                result: toolResultStr,
                status: 'failed',
              });
            } else if (!current.includes(oldStr)) {
              toolResultStr = `Error: Could not find exact text match to replace in ${rawPath}.`;
              await onEvent({
                type: 'tool',
                id: callId,
                name: fnName,
                result: toolResultStr,
                status: 'failed',
              });
            } else {
              const updated = current.replace(oldStr, newStr);
              fileMap.set(rawPath, updated);
              await onEvent({
                type: 'file',
                path: rawPath,
                content: updated,
                previous: current,
              });
              toolResultStr = `Successfully edited ${rawPath}`;
              await onEvent({
                type: 'tool',
                id: callId,
                name: fnName,
                result: toolResultStr,
                status: 'success',
              });
            }
          } else if (fnName === 'list_files') {
            toolResultStr = Array.from(fileMap.keys()).join('\n') || '(empty workspace)';
            await onEvent({
              type: 'tool',
              id: callId,
              name: fnName,
              result: toolResultStr,
              status: 'success',
            });
          } else {
            toolResultStr = `Unknown tool: ${fnName}`;
            await onEvent({
              type: 'tool',
              id: callId,
              name: fnName,
              result: toolResultStr,
              status: 'failed',
            });
          }
        } catch (toolError: any) {
          toolResultStr = `Error: ${toolError.message || String(toolError)}`;
          await onEvent({
            type: 'tool',
            id: callId,
            name: fnName,
            result: toolResultStr,
            status: 'failed',
          });
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolResultStr,
        });
      }
    } else {
      await onEvent({ type: 'done' });
      return;
    }
  }

  await onEvent({ type: 'done' });
}

export async function streamHarness(
  body: unknown,
  accessToken: string,
  signal: AbortSignal,
  onEvent: (event: HarnessEvent) => Promise<void>
) {
  const req = body as RunRequestBody;
  if (req && req.provider === 'openrouter') {
    return streamOpenRouterDirect(req, signal, onEvent);
  }

  // Fallback to local Python backend for Ollama
  const response = await checked(await fetch(`${API_BASE}/harness/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
    signal,
  }));
  if (!response.body) throw new Error('Streaming is unavailable in this browser.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'done' || event.type === 'error') finished = true;
        if (event.type !== 'heartbeat') await onEvent(event);
      }
      if (done) break;
    }
    if (!finished) throw new Error('Connection ended before the harness finished. Applied edits are saved.');
  } finally {
    reader.releaseLock();
  }
}

export async function approveCommand(runId: string, token: string, approved: boolean) {
  await checked(await fetch(`${API_BASE}/harness/runs/${runId}/approval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Run-Token': token },
    body: JSON.stringify({ approved }),
  }));
}

export async function cancelRun(runId: string, token: string) {
  await fetch(`${API_BASE}/harness/runs/${runId}`, { method: 'DELETE', headers: { 'X-Run-Token': token } });
}
