import { startMockSSE } from '../mockSSE'
import { backendStreamAdapter } from './backendStream'
import type { ChatStreamAdapter, ChatStreamCallbacks, ChatStreamConfig, ChatStreamRequest } from './types'

const mockStreamAdapter: ChatStreamAdapter = {
  start(request, callbacks) {
    return startMockSSE(request.prompt, callbacks, request.context)
  },
}

export function startChatStream(
  request: ChatStreamRequest,
  callbacks: ChatStreamCallbacks,
  config: ChatStreamConfig
): AbortController {
  const adapter = config.mode === 'backend' ? backendStreamAdapter : mockStreamAdapter
  return adapter.start(request, callbacks, config)
}
