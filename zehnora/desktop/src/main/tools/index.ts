import type { Mode } from '../../shared/types';
import type { ToolSchema } from '../llm';
import type { Tool } from './types';
import { commandTools } from './commands';
import { systemTools } from './system';
import { fileTools } from './files';
import { webTools } from './web';

const ALL: Tool[] = [...fileTools, ...commandTools, ...webTools, ...systemTools];

const byMode: Record<Mode, Map<string, Tool>> = {
  chat: new Map(ALL.filter((tool) => tool.modes.includes('chat')).map((tool) => [tool.name, tool])),
  work: new Map(ALL.filter((tool) => tool.modes.includes('work')).map((tool) => [tool.name, tool])),
};

const schemas: Record<Mode, ToolSchema[]> = {
  chat: [...byMode.chat.values()].map(toSchema),
  work: [...byMode.work.values()].map(toSchema),
};

function toSchema(tool: Tool): ToolSchema {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

export const toolsFor = (mode: Mode): Map<string, Tool> => byMode[mode];
export const schemasFor = (mode: Mode): ToolSchema[] => schemas[mode];
