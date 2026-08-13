import { webcrypto } from 'node:crypto'

const ticket = 'b'.repeat(43)
const opened = []

class ProbeWebSocket {
  readyState = 0
  listeners = new Map()

  constructor(url, protocols, options) {
    this.url = url
    this.protocols = protocols
    this.options = options
    opened.push(this)
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener)
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type)
  }

  send() {}
  close() {}
}

globalThis.crypto ??= webcrypto
globalThis.WebSocket = ProbeWebSocket
globalThis.fetch = async () => new Response(JSON.stringify({
  ticket,
  expires_in: 60,
  websocket_path: '/acp',
  protocols: ['acp', `connectonion.ticket.${ticket}`],
}), {
  status: 201,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  },
})

const address = await import('../dist/address-browser.js')
const native = await import('@connectonion/react/experimental/native-acp')
const root = await import('@connectonion/react')
const keys = address.generateBrowser()
const stream = await native.createAuthenticatedACPStream({
  agentAddress: `0x${'a'.repeat(64)}`,
  httpUrl: 'https://agent.example',
  transport: {
    protocol_version: 1,
    type: 'websocket',
    path: '/acp',
    authorization: {
      type: 'connectonion-ticket',
      path: '/acp/authorize',
    },
  },
  keys,
})

if (!stream.readable || !stream.writable) {
  throw new Error('Official SDK did not return an ACP Stream')
}
if (opened.length !== 1 || opened[0].url !== 'wss://agent.example/acp') {
  throw new Error('Native adapter did not open exactly one ACP WebSocket')
}
if (opened[0].options?.headers !== undefined) {
  throw new Error('Native adapter leaked admission data into WebSocket headers')
}
if (opened[0].protocols?.[1] !== `connectonion.ticket.${ticket}`) {
  throw new Error('Native adapter did not bind the ticket to subprotocol negotiation')
}
if (typeof root.useAgentForHuman !== 'function') {
  throw new Error('Conditional ESM root did not re-export the React API')
}

await stream.writable.abort()
console.log('Native ACP published-runtime probe passed')
