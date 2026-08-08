/**
 * A minimal stand-in for the Node-RED runtime, reproducing the hook sequence of a real
 * message delivery:
 *
 *   onSend -> (clone) -> preDeliver -> postDeliver -> [next tick] onReceive -> handler -> postReceive
 *
 * with `onComplete` triggered by the node calling `done()`. `postDeliver` firing before
 * `onReceive`, and `onComplete` carrying the message the node *received*, both matter to the
 * span lifecycle, so they are reproduced exactly (see Flow.js `handlePreDeliver` and
 * Node.js `_emitInput` / `_complete` in node-red).
 */

const { ExportResultCode } = require('@opentelemetry/core')

/** Spans handed to the exporter, reset by each `startRuntime` call */
const exportedSpans = []

class CollectingExporter {
  export (spans, resultCallback) {
    exportedSpans.push(...spans)
    resultCallback({ code: ExportResultCode.SUCCESS })
  }

  shutdown () {
    return Promise.resolve()
  }

  forceFlush () {
    return Promise.resolve()
  }
}

// The node requires its exporter lazily, so pre-seeding the module cache is enough to keep
// spans in memory. The exported bindings are getters, so assigning on the real module object
// would silently do nothing (and the spans would be sent to a real collector).
for (const exporterModule of ['@opentelemetry/exporter-trace-otlp-http', '@opentelemetry/exporter-trace-otlp-proto']) {
  const filename = require.resolve(exporterModule)
  // eslint-disable-next-line security/detect-object-injection
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports: { OTLPTraceExporter: CollectingExporter },
  }
}

const DEFAULT_CONFIG = {
  // never reached: the exporter above is in-memory, the URL only has to be non-empty
  url: 'http://127.0.0.1:1/v1/traces',
  protocol: 'http',
  serviceName: 'test',
  rootPrefix: 'Message ',
  ignoredTypes: 'debug,catch',
  propagateHeadersTypes: '',
  isLogging: false,
  timeout: 10,
  attributeMappings: [],
}

let messageCounter = 0

function nextMsgId () {
  return `msgid-${++messageCounter}`
}

/** Node-RED clones a message before delivering it to more than one destination */
function cloneMessage (msg) {
  const clone = { ...msg }
  if (msg.headers) {
    clone.headers = { ...msg.headers }
  }
  return clone
}

class MiniRed {
  /**
   * @param {object} [config] Overrides of the OpenTelemetry node configuration
   */
  constructor (config = {}) {
    exportedSpans.length = 0
    this.hooks = {}
    this.nodes = new Map()
    this.wires = new Map()
    this.handlers = new Map()
    this.queue = []

    // hook labels are global to the runtime, and registering one twice throws
    this.labelledHooks = new Set()
    const RED = {
      nodes: {
        createNode: (node) => {
          node.statuses = []
          node.warnings = []
          node.status = (status) => node.statuses.push(status)
          node.warn = (warning) => node.warnings.push(warning)
          node.on = (event, callback) => {
            if (event === 'close') {
              this.closeHandler = callback.bind(node)
            }
          }
        },
        registerType: (_type, constructor) => {
          this.constructNode = constructor
        },
      },
      hooks: {
        add: (name, handler) => {
          const [id] = name.split('.')
          if (this.labelledHooks.has(name)) {
            throw new Error('Hook ' + name + ' already registered')
          }
          this.labelledHooks.add(name)
          // eslint-disable-next-line security/detect-object-injection
          this.hooks[id] = handler
        },
        remove: (name) => {
          const [id, label] = name.split('.')
          for (const registered of [...this.labelledHooks]) {
            const [registeredId, registeredLabel] = registered.split('.')
            if (registeredLabel === label && (id === '*' || id === registeredId)) {
              this.labelledHooks.delete(registered)
            }
          }
        },
      },
    }
    require('../../lib/opentelemetry-node')(RED)
    this.otelNode = this.addOtelNode(config)
  }

  /**
   * Add an OpenTelemetry node to the runtime, as placing one on a flow does
   * @param {object} [config] Overrides of the OpenTelemetry node configuration
   * @param {string} [id] Node identifier
   * @returns {object} The node instance, carrying its `statuses` and `warnings`
   */
  addOtelNode (config = {}, id = 'otel-node-1') {
    const node = { id }
    this.constructNode.call(node, { ...DEFAULT_CONFIG, ...config })
    return node
  }

  /**
   * Declare a node
   * @param {string} id Node identifier
   * @param {string} type Node type
   * @param {object} [definition] Extra definition properties (name, url, method, ...)
   * @returns {object} The node definition
   */
  node (id, type, definition = {}) {
    const node = { id, type, z: 'flow-1', name: '', _flow: { flow: { label: 'Test flow' } }, ...definition }
    this.nodes.set(id, node)
    return node
  }

  /**
   * Wire a node to its destinations
   * @param {object} source Source node definition
   * @param {object[]|object[][]} destinations Destination node definitions for the single
   *   output, or one array of destinations per output port
   */
  wire (source, destinations) {
    this.wires.set(source.id, destinations)
  }

  /**
   * Register what a node does when it receives a message. The default forwards the message
   * unchanged and reports completion, like most core nodes.
   * @param {object} node Node definition
   * @param {(msg: any, send: (msg: any) => void, done: (error?: any) => void) => void} handler
   */
  on (node, handler) {
    this.handlers.set(node.id, handler)
  }

  /**
   * Emit a message from a node, as `node.send()` does
   * @param {object} source Source node definition
   * @param {any|any[]} msgOrArray Message to emit, or one message per output port with
   *   `null` for the ports that emit nothing. A fresh `_msgid` is minted for any message
   *   that has none, as Node-RED's `Node.prototype.send` does.
   */
  send (source, msgOrArray) {
    const perPort = Array.isArray(msgOrArray) ? msgOrArray : [msgOrArray]
    const wires = this.wires.get(source.id) ?? []
    const ports = Array.isArray(wires[0]) ? wires : [wires]

    // Node-RED passes every message of a single `send` call to `onSend` at once
    const sendEvents = []
    perPort.forEach((msg, port) => {
      if (msg === null || msg === undefined) {
        return
      }
      if (!msg._msgid) {
        msg._msgid = nextMsgId()
      }
      // eslint-disable-next-line security/detect-object-injection
      for (const destination of ports[port] ?? []) {
        sendEvents.push({
          msg,
          source: { id: source.id, node: source, port },
          destination: { id: destination.id, node: destination },
        })
      }
    })
    if (sendEvents.length === 0) {
      return
    }
    this.hooks.onSend(sendEvents)

    const dispatched = new Set()
    for (const sendEvent of sendEvents) {
      // preRoute clones a message that is being delivered more than once
      if (dispatched.has(sendEvent.msg)) {
        sendEvent.msg = cloneMessage(sendEvent.msg)
      } else {
        dispatched.add(sendEvent.msg)
      }
      this.hooks.preDeliver(sendEvent)
      // delivery is asynchronous by default, postDeliver fires straight after preDeliver
      this.queue.push(sendEvent)
      this.hooks.postDeliver(sendEvent)
    }
  }

  /** Deliver every queued message, running the receiving nodes until the flow settles */
  run () {
    let guard = 0
    while (this.queue.length > 0) {
      if (++guard > 10000) {
        throw new Error('flow did not settle')
      }
      const sendEvent = this.queue.shift()
      this.deliver(sendEvent.destination.node, sendEvent.msg)
    }
  }

  /**
   * Hand a message to a node, as `Node.prototype.receive` does
   * @param {object} node Node definition
   * @param {any} msg Message data
   */
  deliver (node, msg) {
    if (!msg._msgid) {
      msg._msgid = nextMsgId()
    }
    const receiveEvent = { msg, destination: { id: node.id, node } }
    this.hooks.onReceive(receiveEvent)
    const handler = this.handlers.get(node.id) ?? ((received, send, done) => {
      send(received)
      done()
    })
    try {
      handler(
        msg,
        (emitted) => this.send(node, emitted),
        (error) => this.complete(node, msg, error),
      )
    } catch (error) {
      // a function node that throws is reported as `done(err)`, which is what puts the error on
      // the span. `node.error()` alone would only route to a catch node (not modelled here).
      this.complete(node, msg, error)
    }
    this.hooks.postReceive(receiveEvent)
  }

  /**
   * Report completion for a message, as `Node.prototype._complete` does
   * @param {object} node Node definition
   * @param {any} msg The message the node received
   * @param {any} [error] Error encountered
   */
  complete (node, msg, error) {
    this.hooks.onComplete({ msg, error, node: { id: node.id, node } })
  }

  /**
   * Shut the node down, which flushes the span processor, and return the exported spans
   * @returns {Promise<import('@opentelemetry/sdk-trace-base').ReadableSpan[]>}
   */
  async stop () {
    // a run is closed once the current turn has settled, so give the runtime that turn before
    // shutting down, exactly as it would get between two deliveries
    await settle()
    await this.closeHandler()
    return exportedSpans.slice()
  }
}

/** @param {number} ms */
function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Let the current turn finish, which is when a quiet run gets closed */
function settle () {
  return new Promise((resolve) => setImmediate(resolve))
}

module.exports = { MiniRed, sleep, settle, nextMsgId }
