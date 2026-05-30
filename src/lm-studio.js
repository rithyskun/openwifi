const { LMStudioClient, tool } = require('@lmstudio/sdk')
const { z } = require('zod')
const { LM_STUDIO_MODEL, LM_STUDIO_TEMPERATURE, LM_STUDIO_MAX_TOKENS } = require('./config')

function createLMStudioAgent(context) {
  let client = null
  let model = null

  function getClient() {
    if (!client) {
      client = new LMStudioClient()
    }
    return client
  }

  async function getModel() {
    if (!model) {
      const c = getClient()
      model = await c.llm.model(LM_STUDIO_MODEL)
    }
    return model
  }

  const listPeersTool = tool({
    name: 'listPeers',
    description: 'List all connected peers in the mesh network. Returns peer IDs, names, and authentication status.',
    parameters: {},
    implementation: () => {
      const peers = context.getPeers()
      if (peers.length === 0) {
        return 'No peers currently connected.'
      }
      return peers.map(p => ({
        id: p.id,
        name: p.name,
        authenticated: p.authenticated || false,
        handshakeDone: p.handshakeDone || false,
      }))
    },
  })

  const sendMessageToPeerTool = tool({
    name: 'sendMessageToPeer',
    description: 'Send a text message to a specific peer in the mesh network. Use listPeers first to get peer IDs.',
    parameters: {
      peerId: z.string().describe('The ID of the peer to send the message to'),
      message: z.string().describe('The text message to send'),
    },
    implementation: ({ peerId, message }) => {
      const peers = context.getPeers()
      const peer = peers.find(p => p.id === peerId)
      if (!peer) {
        return `Error: Peer ${peerId} not found. Use listPeers to see available peers.`
      }
      context.sendMessage(peerId, { type: 'chat', text: message })
      return `Message sent to ${peer.name} (${peerId})`
    },
  })

  const queryRemoteAITool = tool({
    name: 'queryRemoteAI',
    description: 'Send an AI query to a remote peer through the mesh network. The remote peer will process the request and return a response.',
    parameters: {
      peerId: z.string().describe('The ID of the peer to query for AI response'),
      question: z.string().describe('The question to ask the remote AI'),
    },
    implementation: async ({ peerId, question }) => {
      const peers = context.getPeers()
      const peer = peers.find(p => p.id === peerId)
      if (!peer) {
        return `Error: Peer ${peerId} not found. Use listPeers to see available peers.`
      }
      const requestId = `${context.selfId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const messages = [{ role: 'user', content: question }]
      return new Promise((resolve) => {
        context.pendingAIRequests.set(requestId, { resolve, timeout: null })
        const timeout = setTimeout(() => {
          context.pendingAIRequests.delete(requestId)
          resolve('Error: Remote AI request timed out after 60 seconds')
        }, 60000)
        context.pendingAIRequests.get(requestId).timeout = timeout
        context.sendMessage(peerId, {
          type: 'ai-request',
          requestId,
          messages,
        })
      })
    },
  })

  const getNetworkStatsTool = tool({
    name: 'getNetworkStats',
    description: 'Get statistics about the current mesh network including peer count, discovered peers, and connection info.',
    parameters: {},
    implementation: () => {
      const peers = context.getPeers()
      const discovered = context.getDiscoveredPeers()
      return {
        selfId: context.selfId,
        selfName: context.selfName,
        connectedPeers: peers.length,
        discoveredPeers: discovered.length,
        peers: peers.map(p => ({ id: p.id, name: p.name, authenticated: p.authenticated })),
        discovered: discovered.map(p => ({ id: p.id, name: p.name })),
      }
    },
  })

  const broadcastMessageTool = tool({
    name: 'broadcastMessage',
    description: 'Send a message to all connected peers in the mesh network.',
    parameters: {
      message: z.string().describe('The text message to broadcast to all peers'),
    },
    implementation: ({ message }) => {
      context.sendMessage('*broadcast*', { type: 'chat', text: message })
      return `Message broadcasted to all peers`
    },
  })

  const meshTools = [
    listPeersTool,
    sendMessageToPeerTool,
    queryRemoteAITool,
    getNetworkStatsTool,
    broadcastMessageTool,
  ]

  async function checkStatus() {
    try {
      const c = getClient()
      const loadedModels = await c.llm.listLoaded()
      const isLoaded = loadedModels.some(m => m.identifier === LM_STUDIO_MODEL || m.identifier.includes(LM_STUDIO_MODEL))
      return {
        available: true,
        model: LM_STUDIO_MODEL,
        loaded: isLoaded,
        loadedModels: loadedModels.map(m => m.identifier),
      }
    } catch {
      return {
        available: false,
        model: LM_STUDIO_MODEL,
        loaded: false,
        error: 'LM Studio not reachable',
      }
    }
  }

  async function chat(messages, callbacks) {
    const m = await getModel()
    const chatMessages = messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    }))

    const { Chat } = require('@lmstudio/sdk')
    const chat = Chat.from(chatMessages)

    await m.act(chat, meshTools, {
      temperature: LM_STUDIO_TEMPERATURE,
      maxTokens: LM_STUDIO_MAX_TOKENS,
      onMessage: (message) => {
        if (callbacks.onMessage) {
          callbacks.onMessage(message.toString())
        }
      },
      onPredictionFragment: ({ content }) => {
        if (callbacks.onStream) {
          callbacks.onStream(content)
        }
      },
      onToolCallRequest: (request) => {
        if (callbacks.onToolCall) {
          callbacks.onToolCall(request.name, request.arguments)
        }
      },
      onToolCallResult: (result) => {
        if (callbacks.onToolResult) {
          callbacks.onToolResult(result.name, result.result)
        }
      },
    })
  }

  async function simpleChat(messages) {
    const m = await getModel()
    const chatMessages = messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    }))

    const { Chat } = require('@lmstudio/sdk')
    const chat = Chat.from(chatMessages)

    const result = await m.respond(chat, {
      temperature: LM_STUDIO_TEMPERATURE,
      maxTokens: LM_STUDIO_MAX_TOKENS,
    })

    return result.content
  }

  async function streamingChat(messages, onChunk) {
    const m = await getModel()
    const chatMessages = messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    }))

    const { Chat } = require('@lmstudio/sdk')
    const chat = Chat.from(chatMessages)

    const prediction = m.respond(chat, {
      temperature: LM_STUDIO_TEMPERATURE,
      maxTokens: LM_STUDIO_MAX_TOKENS,
    })

    let fullResponse = ''
    for await (const { content } of prediction) {
      fullResponse += content
      if (onChunk) onChunk(content)
    }

    return fullResponse
  }

  return {
    checkStatus,
    chat,
    simpleChat,
    streamingChat,
    getModel,
    getClient,
  }
}

module.exports = { createLMStudioAgent }
