export interface MockCall { name: string; arguments: string }
export interface MockReply { content?: string; reasoning?: string; tool_calls?: MockCall[]; finish?: string; status?: number; error?: string }
export interface MockRequest { messages: { role: string; content: string | null; tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }[]; tools?: { function: { name: string } }[]; max_tokens: number }
export interface MockModel { url: string; consoleUrl: string; apiKey: string; requests: MockRequest[]; close(): Promise<void> }
export function scenario(body: MockRequest): MockReply;
export function startMockModel(handler?: (body: MockRequest, count: number) => MockReply | Promise<MockReply>, options?: { apiKey?: string }): Promise<MockModel>;
