const { name, version } = require('../package.json')
const { NodeSDK } = require('@opentelemetry/sdk-node')
const { trace, context, propagation, SpanKind, SpanStatusCode } = require('@opentelemetry/api')
const { defaultResource } = require('@opentelemetry/resources')
const {
  ATTR_CLIENT_ADDRESS,
  ATTR_CODE_FUNCTION_NAME,
  ATTR_HTTP_REQUEST_HEADER,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_NETWORK_PROTOCOL_VERSION,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
  ATTR_URL_PATH,
  ATTR_URL_QUERY,
  ATTR_URL_SCHEME,
  ATTR_USER_AGENT_ORIGINAL,
} = require('@opentelemetry/semantic-conventions')
const { B3InjectEncoding, B3Propagator } = require('@opentelemetry/propagator-b3')
const {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} = require('@opentelemetry/core')
const { clearInterval } = require('timers')
const { defaultTextMapGetter } = require('@opentelemetry/api')
const jmespath = require('jmespath')

/**
 * @typedef {import('@opentelemetry/api').Tracer} Tracer
 * @typedef {import('@opentelemetry/api').Span} Span
 * @typedef {import('@opentelemetry/api').Context} Context
 * @typedef {import('@opentelemetry/api').SpanContext} SpanContext
 * @typedef {import('@types/node-red__registry').NodeMessage} NodeMessage
 * @typedef {import('@types/node-red__registry').NodeAPI} NodeAPI
 * @typedef {import('@types/node-red__registry').Node} Node
 * @typedef {import('@types/node-red__registry').NodeDef} NodeDef
 * @typedef {import('@types/node-red__registry').FlowInfo} FlowInfo
 * @typedef {import('@types/node-red__registry').NodeCredentials} NodeCredentials
 * @typedef {import('@types/node-red__util').SendEvent} SendEvent
 * @typedef {import('@types/node-red__util').ReceiveEvent} ReceiveEvent
 * @typedef {import('@types/node-red__util').CompleteEvent} CompleteEvent
 */

/**
 * @typedef {Object} OtelAttributeMapping Span attribute mapping
 * @property {boolean} isAfter Does the attribute should be parsed before or after node processing?
 * @property {string} flow Flow id or empty for all flows
 * @property {string} nodeType Node type or empty for all types
 * @property {string} key OTEL attribute key
 * @property {string} path Msg path to data or fixed "value"
 */

/**
 * @typedef {Object} OtelNodeConfig OTEL node credentials
 * @property {string} url OpenTelemetry exporter endpoint
 * @property {string} serviceName OpenTelemetry service name
 * @property {"http"|"proto"} protocol OpenTelemetry exporter protocol
 * @property {"none"|"bearer"|"basic"|"header"} authScheme Collector authentication scheme
 * @property {string} authHeaderName Name of the header carrying the secret, for example x-api-key
 * @property {Array<{key: string, value: string}>} headers Additional exporter headers
 * @property {string} rootPrefix Prefix added in the local root span name before initial node name
 * @property {boolean} hasFlowNameInRoot Add the flow name in the local root span name before initial node name
 * @property {number} timeout Time in seconds after which a local root span with no activity is considered abandoned and closed
 * @property {string} ignoredTypes Do not trace nodes of these types
 * @property {string} propagateHeadersTypes Forward trace headers on these types of nodes
 * @property {boolean} isLogging Send debug logs to the console
 * @property {boolean} isNestSpansMode Make each node span a child of the node that sent it the message, instead of a child of the local root span
 * @property {OtelAttributeMapping[]} attributeMappings Span attribute mappings
 */

/**
 * OTEL node definition, including configuration
 * @typedef {NodeDef & OtelNodeConfig} OtelNodeDef
 */

/**
 * @typedef {Object} OtelNodeCredentials OTEL node credentials
 * @property {string} [token] Exporter token
 * @property {string} [username] Exporter username for basic auth
 * @property {string} [password] Exporter password for basic auth
 */

/**
 * @typedef {string} RunId Internal identifier (based on msg._id and an incremental sequence)
 */

/**
 * @typedef {object} LocalRootSpan A single flow execution: a local root span and the node spans below it
 * @property {RunId} runId Internal identifier (based on msg._id and an incremental sequence)
 * @property {Span} rootSpan The root span itself
 * @property {Context} ctx Context holding the root span, used as parent of every node span
 * @property {Map<string, Span>} spans Open node spans, keyed by `<msgId>#<nodeId>`
 * @property {Map<string, {ctx: Context, depth: number}>} spanContexts Context for all node spans of this local root span(keyed by `<msgId>#<nodeId>`), kept after the span closes so that a subsequent span can be nested under it. Used only in "nest spans" mode
 * @property {Set<string>} ignored Span keys of nodes excluded from tracing
 * @property {Set<string>} entrySpans Span keys of nodes that emitted a message without receiving one
 * @property {number} pending Number of open node spans (the root ends when this reaches 0)
 * @property {number} updateTimestamp
 * @property {boolean} isEnded
 * @property {NodeJS.Immediate} [finishTimer] Pending end of local root span check, see scheduleFinishLocalRootSpan function
 * @property {number} [quietSince] Closing timestamp of the last node span, used as the local root span end time
*/

/**
 * @typedef {object} NodeState What a node is currently working on
 * @property {string} runId
 * @property {string} msgId
 * @property {number} inFlight
 */

const ATTR_MSG_ID = 'node_red.msg.id'
const ATTR_RUN_ID = 'node_red.run.id'
const ATTR_FLOW_ID = 'node_red.flow.id'
const ATTR_FLOW_NAME = 'node_red.flow.name'
const ATTR_NODE_ID = 'node_red.node.id'
const ATTR_NODE_TYPE = 'node_red.node.type'
const ATTR_NODE_NAME = 'node_red.node.name'
const ATTR_IS_MESSAGE_CREATION = 'node_red.msg.new'
/** Type of the node that started the trace, apply only in the local root span */
const ATTR_TRIGGER_TYPE = 'node_red.trigger.type'
const ATTR_SPAN_INCOMPLETE = 'node_red.span.incomplete'
const ATTR_LINK_TYPE = 'node_red.link.type'

/** Message property carrying the `rundId`: the local root span internal identifier (based on on msg._id and an incremental sequence) */
const RUN_ID_PROPERTY = 'otelRootMsgId'

/** In "nest spans" mode, the depth of the parent/child chain before a span is attached to the local root, in order to prevent spans from becoming too deeply nested, which would make them difficult to read */
const MAX_NESTING_DEPTH = 50

/** Node types that emit messages without receiving one but whose span is closed elsewhere */
const CORRELATED_ENTRY_TYPES = ['http in']

/** How long the context of a finished local root span stays available for linking a continuation (ms) */
const LINKABLE_LOCAL_ROOT_SPAN_RETENTION = 60000

/** Maximum number of items in the map storing local root span contexts, to prevent it from becoming too large */
const LINKABLE_LOCAL_ROOT_SPAN_LIMIT = 10000

const fakeSpan = {
  end: () => {},
  recordException: () => {},
  setStatus: () => {},
  setAttribute: () => {},
  setAttributes: () => {},
}

/**
 * Flow executions currently in progress, keyed by run id
 * @type {Map<RunId, LocalRootSpan>}
 */
const localRootSpans = new Map()

/**
 * What each node is currently processing, used to assign a newly created message to the local root span to which the node that emits it belongs
 * @type {Map<string, NodeState>}
 */
const nodeStates = new Map()

/**
 * Root span context of recently finished runs, so a continuation can be linked to it, keyed by run id
 * @type {Map<RunId, {spanContext: SpanContext, endTimestamp: number}>}
 */
const endedLocalRootSpans = new Map()

/**
 * Identifier of the OpenTelemetry node owning the runtime hooks. Hook labels are global to the Node-RED runtime, so only one node can register them.
 * @type {string|null}
 */
let activeNodeId = null

let runSequence = 0
let _isLogging = false
let _isNestSpansMode = false
let _rootPrefix = ''
let _hasFlowNameInRoot = true
let _timeout = 10
let intervalId = null
/** @type OtelAttributeMapping[] */
let _attributeMappings = []

const propagator = new CompositePropagator({
  propagators: [
    new W3CTraceContextPropagator(),
    new W3CBaggagePropagator(),
    new B3Propagator(),
    new B3Propagator({
      injectEncoding: B3InjectEncoding.MULTI_HEADER,
    }),
  ],
})

/**
 * Read the run identifier (local root span) carried by a message
 * @param {NodeMessage} msg Message data
 * @returns {string|undefined}
 */
function getRunId (msg) {
  // eslint-disable-next-line security/detect-object-injection
  return msg[RUN_ID_PROPERTY]
}

/**
 * Carry the run identifier (local root span) on a message, so the nodes it reaches join the same trace
 * @param {NodeMessage} msg Message data
 * @param {string} runId Run identifier
 */
function setRunId (msg, runId) {
  // eslint-disable-next-line security/detect-object-injection
  msg[RUN_ID_PROPERTY] = runId
}

/**
 * Read an attribute of a span being built
 * @param {Span} span Span to read
 * @param {string} attributeName One of the attribute names defined above
 * @returns {string|number|boolean|undefined}
 */
function getSpanAttribute (span, attributeName) {
  // eslint-disable-next-line security/detect-object-injection
  return span?.attributes?.[attributeName]
}

/**
 * Return the span key identifying a node span within a run
 * @param {string} msgId Identifier of the message the node is processing
 * @param {string} nodeId Node identifier
 * @returns {string}
 */
function getSpanKey (msgId, nodeId) {
  return `${msgId}#${nodeId}`
}

/**
 * Find the key of an already open span for this node, tolerating a node that emitted a new message (and therefore a new `_msgid`) while processing another one
 * @param {LocalRootSpan} localRootSpan Local root span holding the span
 * @param {NodeMessage} msg Message data
 * @param {string} nodeId Node identifier
 * @returns {string|undefined} Span key, or undefined when this node has no open span
 */
function findSpanKey (localRootSpan, msg, nodeId) {
  const direct = getSpanKey(msg._msgid, nodeId)
  if (localRootSpan.spans.has(direct) || localRootSpan.ignored.has(direct)) {
    return direct
  }
  const state = nodeStates.get(nodeId)
  if (state !== undefined) {
    const viaNodeState = getSpanKey(state.msgId, nodeId)
    if (localRootSpan.spans.has(viaNodeState) || localRootSpan.ignored.has(viaNodeState)) {
      return viaNodeState
    }
  }
  return undefined
}

/**
 * Return the first local root span still in progress matching a provided run identifier
 * @param {Array<string|undefined>} candidateRunIds Run identifiers of candidate local root spans, most trusted first
 * @returns {LocalRootSpan|undefined}
 */
function resolveLocalRootSpan (candidateRunIds) {
  for (const candidateRunId of candidateRunIds) {
    if (candidateRunId !== undefined && localRootSpans.has(candidateRunId)) {
      return localRootSpans.get(candidateRunId)
    }
  }
  return undefined
}

/**
 * Map a Node-RED node type to a span kind
 * @param {string} nodeType Node type (ex: `http in`, `function`)
 * @returns {SpanKind}
 */
function getSpanKind (nodeType) {
  switch (nodeType) {
    case 'http in':
    case 'tcp in':
    case 'udp in':
      return SpanKind.SERVER
    case 'http request':
    case 'tcp request':
      return SpanKind.CLIENT
    case 'mqtt in':
    case 'amqp-in':
    case 'websocket in':
      return SpanKind.CONSUMER
    case 'mqtt out':
    case 'amqp-out':
    case 'websocket out':
      return SpanKind.PRODUCER
    default:
      return SpanKind.INTERNAL
  }
}

/**
 * Retrieve the name of the flow (or subflow)
 * @param {FlowInfo} flow
 * @returns {string}
 */
function getFlowName (flow) {
  // there is a typo on FlowInfo type (does not include `flow.label`)
  return flow?.flow?.label ?? flow?.subflowDef?.name ?? ''
}

/**
 * Try to continue the trace of the caller, using the context carried by the incoming message
 * @param {Node} nodeDefinition Node receiving the message from outside Node-RED
 * @param {NodeMessage} msg Complete message data
 * @returns {Context|undefined} Extracted context, or undefined when there is nothing to extract
 */
function extractIncomingContext (nodeDefinition, msg) {
  try {
    switch (nodeDefinition.type) {
      case 'http in':
        // trace context in incoming http request headers
        return propagator.extract(context.active(), msg.req.headers, defaultTextMapGetter)
      case 'mqtt in':
        // trace context in incoming mqtt v5 user properties
        if (msg.userProperties) {
          return propagator.extract(context.active(), msg.userProperties, defaultTextMapGetter)
        }
        return undefined
      case 'amqp-in':
        // trace context in incoming amqp message headers
        return propagator.extract(context.active(), msg.properties.headers, defaultTextMapGetter)
      default:
        return undefined
    }
  } catch (error) {
    if (_isLogging) {
      console.log(`No trace context extracted from ${nodeDefinition.type}: ${error.message}`)
    }
    return undefined
  }
}

/**
 * @param {Node} _node OTEL node (for using Node-RED utilities)
 * @param {string} eventType
 * @param {SendEvent|ReceiveEvent|CompleteEvent} event
 * @returns
 */
function logEvent (_node, eventType, event) {
  if (!_isLogging) {
    return
  }
  try {
    let msg = `runId: ${getRunId(event.msg)}, _msgId: ${event.msg._msgid}:`
    if (event.source && event.source.node) {
      msg += ` src: ${event.source.node.type} ${event.source.node.id}`
    }
    if (event.destination && event.destination.node) {
      msg += ` >> dest: ${event.destination.node.type} ${event.destination.node.id}`
    }
    if (event.node && event.node.node) {
      msg += ` ## node: ${event.node.node.type} ${event.node.node.id}`
    }
    console.log(`${eventType}: ${msg}`)
  } catch (error) {
    console.error(`An error occurred during logging ${eventType}`, error)
  }
}

/**
 * Attribute value must be a non-null string, boolean, floating point value, integer, or an array of these values
 * ({@link https://opentelemetry.io/docs/concepts/signals/traces/#attributes OTEL doc})
 * @param {any} input Data whose type needs to be tested
 * @returns {boolean} Is the input data a primitive?
 **/
function isPrimitive (input) {
  if (Array.isArray(input)) {
    return input.every(isPrimitive)
  }
  return ['string', 'number', 'boolean'].includes(typeof input)
}

/**
 * Check if a string is a quoted string (ex: `let myVar = '"hello"'`)
 * @param {string} str Tested string
 * @returns boolean
 */
function isQuotedString (str) {
  if (typeof str !== 'string' || str.length < 2) return false
  const first = str[0]
  return (first === '"' || first === "'") && str[str.length - 1] === first
}

/**
 * Use message data to provide user custom span attributes
 * @param {boolean} isAfter Should attribute analysis be after node processing?
 * @param {NodeMessage} data Message data to be used for parsing
 * @param {string} flowId Flow identifier
 * @param {string} nodeType Node type (ex: `http in`, `function`)
 * @returns {Record<string, string | number | boolean > | undefined} Custom attributes as record or undefined
 */
function parseAttribute (isAfter, data, flowId, nodeType) {
  if (_attributeMappings.length === 0) {
    return
  }
  const attributes = {}
  _attributeMappings
    .filter((mapping) => (mapping.flow === '' || mapping.flow === flowId) && (mapping.nodeType === '' || mapping.nodeType === nodeType) && mapping.isAfter === isAfter)
    .forEach((mapping) => {
      try {
        if (isQuotedString(mapping.path)) {
          // eslint-disable-next-line security/detect-object-injection
          attributes[mapping.key] = mapping.path.slice(1, -1)
          return
        }
        const result = jmespath.search(data, mapping.path)
        if (isPrimitive(result)) {
          // eslint-disable-next-line security/detect-object-injection
          attributes[mapping.key] = result
        }
      } catch (error) {
        console.warn(`An error occurred during span attribute parsing (key: ${mapping.key}, path: ${mapping.path}): ${error.message}`)
      }
    })
  return attributes
}

/**
 * Span attributes shared by the root span and every node span
 * @param {Node} nodeDefinition Current node definition
 * @param {NodeMessage} msg Complete message data
 * @param {string} runId Local root span message identifier
 * @returns {Record<string, string | number | boolean >}
 */
function getCommonAttributes (nodeDefinition, msg, runId) {
  return {
    [ATTR_RUN_ID]: runId,
    [ATTR_MSG_ID]: msg._msgid,
    [ATTR_FLOW_ID]: nodeDefinition.z,
    [ATTR_FLOW_NAME]: getFlowName(nodeDefinition._flow),
    [ATTR_NODE_ID]: nodeDefinition.id,
    [ATTR_NODE_TYPE]: nodeDefinition.type,
    [ATTR_NODE_NAME]: nodeDefinition.name,
  }
}

/**
 * Start a new local root span for this flow execution, parented to the caller's context if the entry node has one, and linked to the local root span it continues for asynchronous hand-offs
 * @param {Tracer} tracer Tracer used for creating spans
 * @param {NodeMessage} msg Complete message data
 * @param {Node} nodeDefinition Node starting the local root span
 * @param {string|undefined} predecessorRunId Run id of the local root span this execution continues, if any
 * @returns {LocalRootSpan}
 */
function createLocalRootSpan (tracer, msg, nodeDefinition, predecessorRunId) {
  // a local root span is identified by the message that started it, kept unique so that a message sent again later cannot be mistaken for the local root span it originally belonged to
  let runId = msg._msgid
  if (localRootSpans.has(runId) || endedLocalRootSpans.has(runId)) {
    runId = `${msg._msgid}-${++runSequence}`
  }
  const now = Date.now()
  const links = []
  if (predecessorRunId !== undefined && endedLocalRootSpans.has(predecessorRunId)) {
    links.push({
      context: endedLocalRootSpans.get(predecessorRunId).spanContext,
      attributes: { [ATTR_LINK_TYPE]: 'continuation' },
    })
  }
  const flowName = _hasFlowNameInRoot ? getFlowName(nodeDefinition._flow) + ' ' ?? '' : ''
  const rootSpan = tracer.startSpan(_rootPrefix + flowName + (nodeDefinition.name || nodeDefinition.type), {
    attributes: {
      [ATTR_IS_MESSAGE_CREATION]: true,
      [ATTR_TRIGGER_TYPE]: nodeDefinition.type,
      ...getCommonAttributes(nodeDefinition, msg, runId),
    },
    kind: getSpanKind(nodeDefinition.type),
    links,
  }, extractIncomingContext(nodeDefinition, msg) ?? context.active())
  /** @type LocalRootSpan */
  const localRootSpan = {
    runId,
    rootSpan,
    ctx: trace.setSpan(context.active(), rootSpan),
    spans: new Map(),
    spanContexts: new Map(),
    ignored: new Set(),
    entrySpans: new Set(),
    pending: 0,
    updateTimestamp: now,
    isEnded: false,
  }
  localRootSpans.set(runId, localRootSpan)
  if (_isLogging) {
    console.log(`=> Started run ${runId} on ${nodeDefinition.type}${links.length > 0 ? ` (linked to ${predecessorRunId})` : ''}`)
  }
  return localRootSpan
}

/**
 * Return the run this message belongs to, starting one when there is none in progress
 * @param {Tracer} tracer Tracer used for creating spans
 * @param {NodeMessage} msg Complete message data
 * @param {Node} nodeDefinition Current node definition
 * @param {Array<string|undefined>} candidateRunIds Run identifiers of candidate local root spans, most trusted first
 * @returns {LocalRootSpan}
 */
function getOrCreateLocalRootSpan (tracer, msg, nodeDefinition, candidateRunIds) {
  const localRootSpan = resolveLocalRootSpan(candidateRunIds)
  if (localRootSpan !== undefined) {
    return localRootSpan
  }
  // no local root span in progress: this message starts one, possibly continuing a finished one
  const predecessorRunId = candidateRunIds.find((candidateRunId) => candidateRunId !== undefined && endedLocalRootSpans.has(candidateRunId))
  return createLocalRootSpan(tracer, msg, nodeDefinition, predecessorRunId)
}

/**
 * A node delivers a single `send()` to multiple wires sequentially. Closing the span between wire dispatches would split the trace. Since all `preDeliver`/`postDeliver` events occur synchronously in the same turn, this check is deferred to close the root span precisely when execution goes quiet, avoiding unnecessary delays
 * @param {LocalRootSpan} localRootSpan Local root span whose last node span just ended
 */
function scheduleFinishLocalRootSpan (localRootSpan) {
  if (localRootSpan.isEnded || localRootSpan.finishTimer !== undefined) {
    return
  }
  localRootSpan.quietSince = Date.now()
  localRootSpan.finishTimer = setImmediate(() => {
    localRootSpan.finishTimer = undefined
    // more work arrived while we waited, or the local root span is already gone
    if (localRootSpan.pending > 0 || localRootSpans.get(localRootSpan.runId) !== localRootSpan) {
      return
    }
    endLocalRootSpan(localRootSpan, localRootSpan.quietSince)
  })
}

/**
 * End a local root span, keeping its context available for linking a continuation
 * @param {LocalRootSpan} localRootSpan Local root span to close
 * @param {number} [endTime] Explicit end timestamp (used when closing an abandoned local root span)
 */
function endLocalRootSpan (localRootSpan, endTime) {
  if (localRootSpan.isEnded) {
    return
  }
  if (localRootSpan.finishTimer !== undefined) {
    clearImmediate(localRootSpan.finishTimer)
    localRootSpan.finishTimer = undefined
  }
  localRootSpan.isEnded = true
  localRootSpan.rootSpan.end(endTime)
  endedLocalRootSpans.set(localRootSpan.runId, {
    spanContext: localRootSpan.rootSpan.spanContext(),
    endTimestamp: Date.now(),
  })
  if (endedLocalRootSpans.size > LINKABLE_LOCAL_ROOT_SPAN_LIMIT) {
    // insertion ordered, so this drops the oldest retained context
    endedLocalRootSpans.delete(endedLocalRootSpans.keys().next().value)
  }
  localRootSpans.delete(localRootSpan.runId)
  if (_isLogging) {
    console.log(`=> Ended local root span ${localRootSpan.runId}`)
  }
}

/**
 * End a node span and close the local root span once its last node span is done
 * @param {LocalRootSpan} localRootSpan Local root span holding the span
 * @param {string} spanKey Span key
 * @param {number} [endTime] Explicit end timestamp
 */
function endChildSpan (localRootSpan, spanKey, endTime) {
  if (localRootSpan.ignored.has(spanKey)) {
    // not traced, and never counted as pending
    localRootSpan.ignored.delete(spanKey)
    return
  }
  const span = localRootSpan.spans.get(spanKey)
  if (span === undefined) {
    return
  }
  span.end(endTime)
  localRootSpan.spans.delete(spanKey)
  localRootSpan.entrySpans.delete(spanKey)
  localRootSpan.pending = Math.max(0, localRootSpan.pending - 1)
  localRootSpan.updateTimestamp = Date.now()
  if (localRootSpan.pending === 0) {
    scheduleFinishLocalRootSpan(localRootSpan)
  }
}

/**
 * Close local root spans left by nodes that never report completion. Node spans that are still open are ended (and flagged) so the trace keeps them.
 */
function cleanUpOutdatedLocalRootSpans () {
  const now = Date.now()
  try {
    for (const [runId, localRootSpan] of localRootSpans) {
      if (localRootSpan.updateTimestamp >= now - _timeout) {
        continue
      }
      if (_isLogging) {
        console.log(`Local root span ${runId} is outdated, ending ${localRootSpan.spans.size} unfinished span(s)`)
      }
      for (const [spanKey, span] of localRootSpan.spans) {
        span.setAttribute(ATTR_SPAN_INCOMPLETE, true)
        span.end(localRootSpan.updateTimestamp)
        localRootSpan.spans.delete(spanKey)
      }
      localRootSpan.pending = 0
      localRootSpan.rootSpan.setAttribute(ATTR_SPAN_INCOMPLETE, true)
      endLocalRootSpan(localRootSpan, localRootSpan.updateTimestamp)
    }
    for (const [runId, endedLocalRootSpan] of endedLocalRootSpans) {
      if (endedLocalRootSpan.endTimestamp < now - LINKABLE_LOCAL_ROOT_SPAN_RETENTION) {
        endedLocalRootSpans.delete(runId)
      }
    }
  } catch (error) {
    console.error('An error occurred during local root spans cleaning', error)
  }
}

/**
 * Returns the context in which a new span is created: the span of the node that sent the message, or the local root span if there is no such node, if nest spans mode is off, or if the chain has grown too deep to read
 * @param {LocalRootSpan} localRootSpan Local root span the new span belongs to
 * @param {NodeMessage} msg Message being delivered
 * @param {string|undefined} sourceNodeId Node that sent the message, if any
 * @returns {{ctx: Context, depth: number}}
 */
function getParentContext (localRootSpan, msg, sourceNodeId) {
  if (!_isNestSpansMode || sourceNodeId === undefined) {
    return { ctx: localRootSpan.ctx, depth: 0 }
  }
  // sender may have already closed its span but it remains a valid parent
  const direct = getSpanKey(msg._msgid, sourceNodeId)
  const viaNodeState = getSpanKey(nodeStates.get(sourceNodeId)?.msgId, sourceNodeId)
  const parent = localRootSpan.spanContexts.get(direct) ?? localRootSpan.spanContexts.get(viaNodeState)
  if (parent === undefined || parent.depth >= MAX_NESTING_DEPTH) {
    return { ctx: localRootSpan.ctx, depth: 0 }
  }
  return parent
}

/**
 * Create a span for this node and message
 * @param {Tracer} tracer Tracer used for creating spans
 * @param {NodeMessage} msg Complete message data
 * @param {Node} nodeDefinition Current node definition
 * @param {Array<string|undefined>} candidateRunIds Run identifiers of candidate local root spans, most trusted first
 * @param {boolean} isNotTraced Should the node be left untraced?
 * @param {boolean} isEntry Is the node emitting a message it never received?
 * @param {string|undefined} [sourceNodeId] Node that sent the message, used in nest spans mode to make this span its child
 * @returns {Span|undefined} Created (or already open) span
 */
function createSpan (tracer, msg, nodeDefinition, candidateRunIds, isNotTraced, isEntry, sourceNodeId) {
  try {
    if (msg === undefined || msg === null || msg._msgid === undefined) {
      return
    }
    const localRootSpan = getOrCreateLocalRootSpan(tracer, msg, nodeDefinition, candidateRunIds)
    setRunId(msg, localRootSpan.runId)

    // a node that sends multiple messages must have only one span; check whether a span associated with this node is already open
    const openSpanKey = findSpanKey(localRootSpan, msg, nodeDefinition.id)
    if (openSpanKey !== undefined) {
      return localRootSpan.spans.get(openSpanKey) ?? fakeSpan
    }
    const spanKey = getSpanKey(msg._msgid, nodeDefinition.id)
    const parent = getParentContext(localRootSpan, msg, sourceNodeId)

    if (isNotTraced) {
      // remembered so the node is not looked at again, but never counted as pending
      localRootSpan.ignored.add(spanKey)
      if (_isNestSpansMode) {
        // an untraced node mid flow would cut the chain, so it passes its parent on and nesting skips over it
        localRootSpan.spanContexts.set(spanKey, parent)
      }
      return fakeSpan
    }

    const localAttributes = parseAttribute(false, msg, nodeDefinition.z, nodeDefinition.type)
    if (_isLogging) {
      console.log(`Local span attributes (start) for ${nodeDefinition.id}, ${nodeDefinition.type}: ${JSON.stringify(localAttributes)}`)
    }
    const now = Date.now()
    const span = tracer.startSpan(nodeDefinition.name || nodeDefinition.type, {
      attributes: {
        [ATTR_CODE_FUNCTION_NAME]: nodeDefinition.type,
        [ATTR_IS_MESSAGE_CREATION]: false,
        ...getCommonAttributes(nodeDefinition, msg, localRootSpan.runId),
        ...localAttributes,
      },
      kind: getSpanKind(nodeDefinition.type),
    }, parent.ctx)
    span._creationTimestamp = now

    if (nodeDefinition.type === 'http in') {
      const httpAttributes = {
        [ATTR_URL_PATH]: msg.req._parsedUrl?.pathname,
        [ATTR_HTTP_ROUTE]: nodeDefinition.url,
        [ATTR_NETWORK_PROTOCOL_VERSION]: msg.req.httpVersion,
        [ATTR_URL_QUERY]: msg.req._parsedUrl?.query,
        [ATTR_HTTP_REQUEST_METHOD]: nodeDefinition.method.toUpperCase(),
        [ATTR_CLIENT_ADDRESS]: msg.req?.ip,
        [ATTR_HTTP_REQUEST_HEADER('x-forwarded-for')]: msg.req?.headers['x-forwarded-for'],
        [ATTR_USER_AGENT_ORIGINAL]: msg.req?.headers['user-agent'],
      }
      span.setAttributes(httpAttributes)
      if (getSpanAttribute(localRootSpan.rootSpan, ATTR_NODE_ID) === nodeDefinition.id) {
        localRootSpan.rootSpan.setAttributes(httpAttributes)
        localRootSpan.rootSpan.updateName(`${localRootSpan.rootSpan.name} ${nodeDefinition.url}`)
      }
    }
    if (nodeDefinition.type === 'websocket out') {
      // add URL info in attributes
      try {
        const url = new URL(nodeDefinition.serverConfig.path)
        span.setAttribute(ATTR_URL_PATH, url.pathname)
        span.setAttribute(ATTR_SERVER_ADDRESS, url.hostname)
        span.setAttribute(ATTR_SERVER_PORT, url.port)
        span.setAttribute(ATTR_URL_SCHEME, url.protocol.replace(':', ''))
      } catch (_error) { }
    }
    if (nodeDefinition.type === 'websocket in') {
      // add URL info in attributes
      span.setAttribute(ATTR_URL_PATH, nodeDefinition.serverConfig.path)
      if (getSpanAttribute(localRootSpan.rootSpan, ATTR_NODE_ID) === nodeDefinition.id) {
        localRootSpan.rootSpan.setAttribute(ATTR_URL_PATH, nodeDefinition.serverConfig.path)
        localRootSpan.rootSpan.updateName(`${localRootSpan.rootSpan.name} ${nodeDefinition.serverConfig.path}`)
      }
    }

    localRootSpan.spans.set(spanKey, span)
    if (_isNestSpansMode) {
      localRootSpan.spanContexts.set(spanKey, {
        ctx: trace.setSpan(context.active(), span),
        depth: parent.depth + 1,
      })
    }
    localRootSpan.pending++
    localRootSpan.updateTimestamp = now
    if (isEntry && !CORRELATED_ENTRY_TYPES.includes(nodeDefinition.type)) {
      // this node never receives a message, so it will never report completion either: its span is closed once the message it created has been dispatched
      localRootSpan.entrySpans.add(spanKey)
    }
    if (_isLogging) {
      console.log('=> Created span for', nodeDefinition.type)
    }
    return span
  } catch (error) {
    console.error(`An error occurred during span creation for ${nodeDefinition?.type}`, error)
  }
}

/**
 * Ends the span for this node and message
 * @param {NodeMessage} msg Complete message data
 * @param {Error} error Any error encountered
 * @param {Node} nodeDefinition Current node definition
 */
function endSpan (msg, error, nodeDefinition) {
  try {
    if (msg === undefined || msg === null) {
      return
    }
    const localRootSpan = resolveLocalRootSpan([getRunId(msg), nodeStates.get(nodeDefinition.id)?.runId, msg._msgid])
    if (localRootSpan === undefined) {
      return
    }
    const spanKey = findSpanKey(localRootSpan, msg, nodeDefinition.id)
    if (spanKey === undefined) {
      return
    }
    if (localRootSpan.ignored.has(spanKey)) {
      localRootSpan.ignored.delete(spanKey)
      return
    }
    const span = localRootSpan.spans.get(spanKey)

    if (nodeDefinition.type === 'http request') {
      // add http status code in attribute
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, msg.statusCode)
      if (msg.statusCode !== undefined) {
        if (typeof msg.statusCode === 'number') {
          if (msg.statusCode >= 400) {
            const message = `HTTP Error: ${msg.statusCode}`
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message,
            })
            const httpError = new Error(message)
            httpError.name = 'HTTPError'
            if (msg.payload) {
              httpError.stack = msg.payload
            }
            span.recordException(httpError)
          } else if (msg.statusCode >= 200 && msg.statusCode < 300) {
            span.setStatus({ code: SpanStatusCode.OK })
          }
        } else {
          const message = `Network/Protocol Error: ${msg.statusCode}`
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message,
          })
          const networkError = new Error(msg.payload || message)
          networkError.name = String(msg.statusCode)
          span.recordException(networkError)
        }
      }
      // add URL info in attributes
      try {
        if (msg.method) {
          span.setAttribute(ATTR_HTTP_REQUEST_METHOD, msg.method)
        }
        const url = new URL(msg.responseUrl)
        span.setAttribute(ATTR_URL_PATH, url.pathname)
        span.setAttribute(ATTR_SERVER_ADDRESS, url.hostname)
        span.setAttribute(ATTR_SERVER_PORT, url.port)
        span.setAttribute(ATTR_URL_FULL, url.href)
        span.setAttribute(ATTR_URL_SCHEME, url.protocol.replace(':', ''))
      } catch { }
    }
    if (error) {
      // log errors
      if (msg.error) {
        span.recordException(msg.error)
      } else {
        span.recordException(error)
      }
      // the SDK drops a status message that is not a string, and a node that throws reports an Error object here, so the reason would be lost
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) })
      localRootSpan.rootSpan.setStatus({ code: SpanStatusCode.ERROR })
    }
    const localAttributes = parseAttribute(true, msg, nodeDefinition.z, nodeDefinition.type)
    if (localAttributes !== undefined) {
      for (const [key, value] of Object.entries(localAttributes)) {
        span.setAttribute(key, value)
      }
      if (_isLogging) {
        console.log(`Local span attributes (end) for ${nodeDefinition.id}, ${nodeDefinition.type}: ${JSON.stringify(localAttributes)}`)
      }
    }

    if (nodeDefinition.type === 'http response') {
      // correlate with "http in" node
      const statusCode = msg.res?._res?.statusCode
      for (const [httpInSpanKey, spanIn] of localRootSpan.spans) {
        if (getSpanAttribute(spanIn, ATTR_NODE_TYPE) === 'http in') {
          if (_isLogging) {
            console.log('==> Ended related span for ', httpInSpanKey, 'http in')
          }
          endChildSpan(localRootSpan, httpInSpanKey)
          break
        }
      }
      // add http status code in attribute
      if (statusCode !== undefined) {
        if (statusCode >= 400) {
          span.setStatus({ code: SpanStatusCode.ERROR })
          localRootSpan.rootSpan.setStatus({ code: SpanStatusCode.ERROR })
        } else if (statusCode >= 200 && statusCode < 300) {
          span.setStatus({ code: SpanStatusCode.OK })
          localRootSpan.rootSpan.setStatus({ code: SpanStatusCode.OK })
        }
        span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode)
        localRootSpan.rootSpan.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode)
      }
    }

    if (_isLogging) {
      console.log('==> Ended span for ', nodeDefinition.id, nodeDefinition.type)
    }
    endChildSpan(localRootSpan, spanKey)
  } catch (error) {
    console.error(error)
  }
}

/**
 * Build the exporter's headers from configured authentication, collector-specific headers (e.g., dataset, organization, stream) and `OTEL_EXPORTER_OTLP_HEADERS`
 * @param {OtelNodeDef} config Node configuration
 * @param {OtelNodeCredentials} credentials OTEL node credentials
 * @param {Node} node OTEL node, warned when the configuration is incomplete
 * @returns {Record<string, string>} Headers to add to the exporter requests
 */
function getExporterHeaders (config, credentials, node) {
  const { authScheme, authHeaderName, headers: additionalHeaders } = config
  const headers = {}

  ;(additionalHeaders ?? []).forEach((header) => {
    if (header && header.key) {
      // eslint-disable-next-line security/detect-object-injection
      headers[header.key] = header.value ?? ''
    }
  })

  const { token, username, password } = credentials ?? {}
  switch (authScheme) {
    case 'bearer':
      if (!token) {
        node.warn('Bearer authentication is selected but no token is set, requests will be sent unauthenticated')
        break
      }
      headers.authorization = `Bearer ${token}`
      break

    case 'basic':
      if (!username && !password) {
        node.warn('Basic authentication is selected but no user and no password are set, requests will be sent unauthenticated')
        break
      }
      headers.authorization = `Basic ${Buffer.from(`${username ?? ''}:${password ?? ''}`).toString('base64')}`
      break

    case 'header':
      if (!authHeaderName || !token) {
        node.warn('Header authentication is selected but the header name or its value is missing, requests will be sent unauthenticated')
        break
      }
      // eslint-disable-next-line security/detect-object-injection
      headers[authHeaderName] = token
      break

    default:
      break
  }
  return headers
}

/**
 * @param {NodeAPI} RED Runtime API provided to nodes by Node Registry
 */
module.exports = function (RED) {
  'use strict'

  /**
   * @this {Node & { credentials: NodeCredentials<OtelNodeCredentials> }}
   * @param {OtelNodeDef} config OTEL node definition, including configuration
   */
  function OpenTelemetryNode (config) {
    RED.nodes.createNode(this, config)

    // get config
    const { url, protocol, serviceName, rootPrefix, hasFlowNameInRoot, ignoredTypes, propagateHeadersTypes, isLogging, timeout, attributeMappings, isNestSpansMode } = config
    const node = this

    // check config
    if (!url) {
      this.status({ fill: 'red', shape: 'ring', text: 'invalid configuration' })
      return
    }

    // `.otel` hook is global at the Node-RED runtime level and must not be instantiated multiple times. A second node will not be activated.
    if (activeNodeId !== null && activeNodeId !== node.id) {
      node.warn(`OpenTelemetry tracing is already handled by node "${activeNodeId}", this node stays inactive. One OpenTelemetry node covers every flow, wherever it is placed.`)
      node.status({ fill: 'grey', shape: 'ring', text: 'inactive, another OTEL node is active' })
      return
    }
    // remove hooks left behind by an instance whose close handler did not fire
    RED.hooks.remove('*.otel')
    activeNodeId = node.id

    const ignoredTypesList = ignoredTypes.split(',').map(key => key.trim())
    const propagateHeadersTypesList = propagateHeadersTypes.split(',').map(key => key.trim())
    _isLogging = isLogging
    _isNestSpansMode = isNestSpansMode === true
    _rootPrefix = rootPrefix
    _hasFlowNameInRoot = hasFlowNameInRoot
    _timeout = timeout * 1000
    _attributeMappings = attributeMappings

    // authentication and any additional headers the collector requires
    const headers = getExporterHeaders(config, this.credentials, node)
    if (Object.keys(headers).length > 0 && url.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) {
      node.warn('Exporter headers are sent over plain http, they can be read in transit: use https for a remote collector')
    }

    // create tracer
    /** @type OTLPTraceExporter */
    let traceExporter
    if (protocol === 'proto') {
      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto')
      traceExporter = new OTLPTraceExporter({ url, headers })
    } else {
      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http')
      traceExporter = new OTLPTraceExporter({ url, headers })
    }
    const sdk = new NodeSDK({
      serviceName,
      resource: defaultResource(),
      traceExporter,
    })
    sdk.start()
    const tracer = trace.getTracer(name, version)

    // add hooks
    RED.hooks.add('onSend.otel', /** @param {SendEvent[]} events */ (events) => {
      if (events.length === 0) {
        return
      }
      logEvent(node, '1.onSend', events[0])
      const { msg, source } = events[0]
      // if the node sends a message without notifying that it has finished processing it, its span is marked to be closed on dispatch
      const isEntry = !(nodeStates.get(source.node.id)?.inFlight > 0)
      createSpan(tracer, msg, source.node, [nodeStates.get(source.node.id)?.runId, getRunId(msg)], ignoredTypesList.includes(source.node.type), isEntry)
    })

    RED.hooks.add('preDeliver.otel', /** @param {SendEvent} sendEvent */ (sendEvent) => {
      if (propagateHeadersTypesList.includes(sendEvent.source.node.type) && sendEvent.msg.headers) {
        // remove trace context of http request headers
        propagation.fields()
          .forEach(field => {
            // eslint-disable-next-line security/detect-object-injection
            delete sendEvent.msg.headers[field]
          })
      }
      logEvent(node, '3.preDeliver', sendEvent)
    })

    RED.hooks.add('postDeliver.otel', /** @param {SendEvent} sendEvent */ (sendEvent) => {
      logEvent(node, '4.postDeliver', sendEvent)
      const { msg, source, destination } = sendEvent
      const span = createSpan(tracer, msg, destination.node, [getRunId(msg), nodeStates.get(source.node.id)?.runId], ignoredTypesList.includes(destination.node.type), false, source.node.id)
      if (propagateHeadersTypesList.includes(destination.node.type)) {
        const localRootSpan = resolveLocalRootSpan([getRunId(msg)])
        const output = {}
        const ctx = span?.spanContext !== undefined
          ? trace.setSpan(context.active(), span)
          : localRootSpan?.ctx ?? context.active()
        propagation.inject(ctx, output)
        switch (destination.node.type) {
          // add trace context in mqtt v5 user properties
          case 'mqtt out':
            if (!msg.userProperties) {
              msg.userProperties = {}
            }
            Object.assign(msg.userProperties, output)
            break
          default:
            // add trace context in http request headers
            if (!msg.headers) {
              msg.headers = {}
            }
            Object.assign(msg.headers, output)
            break
        }
      }

      const sourceLocalRootSpan = resolveLocalRootSpan([nodeStates.get(source.node.id)?.runId, getRunId(msg)])
      if (sourceLocalRootSpan === undefined) {
        return
      }
      const sourceSpanKey = findSpanKey(sourceLocalRootSpan, msg, source.node.id)
      if (sourceSpanKey === undefined) {
        return
      }
      if (sourceLocalRootSpan.entrySpans.has(sourceSpanKey)) {
        // the node created this message instead of receiving one: no completion event will ever come for it, so its span ends now that the message has been dispatched
        if (_isLogging) {
          console.log(`Entry span ${sourceSpanKey} will be ended`)
        }
        endChildSpan(sourceLocalRootSpan, sourceSpanKey)
      } else if (source.node.type === 'switch' || source.node.type.startsWith('subflow')) {
        // end switch or subflow spans as they do not trigger onComplete
        if (_isLogging) {
          console.log(`Switch or subflow span ${sourceSpanKey} will be ended`)
        }
        endChildSpan(sourceLocalRootSpan, sourceSpanKey)
      }
    })

    RED.hooks.add('postReceive.otel', /** @param {ReceiveEvent} receiveEvent */ (receiveEvent) => {
      logEvent(node, '6.postReceive', receiveEvent)
    })

    RED.hooks.add('onReceive.otel', /** @param {ReceiveEvent} receiveEvent */ (receiveEvent) => {
      // store the message information to associate it with the emitted spans
      const { msg, destination } = receiveEvent
      const state = nodeStates.get(destination.node.id) ?? { inFlight: 0 }
      state.runId = getRunId(msg) ?? msg._msgid
      state.msgId = msg._msgid
      state.inFlight++
      nodeStates.set(destination.node.id, state)
      logEvent(node, '5.onReceive', receiveEvent)
    })

    RED.hooks.add('onComplete.otel', /** @param {CompleteEvent} completeEvent */ (completeEvent) => {
      logEvent(node, '7.onComplete', completeEvent)
      const state = nodeStates.get(completeEvent.node.node.id)
      if (state !== undefined) {
        state.inFlight = Math.max(0, state.inFlight - 1)
      }
      endSpan(completeEvent.msg, completeEvent.error, completeEvent.node.node)
    })

    // add timer for closing abandoned local root span
    if (intervalId) {
      clearInterval(intervalId)
    }
    intervalId = setInterval(cleanUpOutdatedLocalRootSpans, 5000)

    // on node stop, remove previous hooks, cancel timer and clear maps
    this.on('close', async function () {
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
      RED.hooks.remove('*.otel')
      activeNodeId = null
      for (const localRootSpan of localRootSpans.values()) {
        if (localRootSpan.finishTimer !== undefined) {
          clearImmediate(localRootSpan.finishTimer)
        }
      }
      localRootSpans.clear()
      nodeStates.clear()
      endedLocalRootSpans.clear()
      try {
        await sdk.shutdown()
      } catch (error) {
        console.error('Error during OpenTelemetry shutdown:', error)
      }
      trace.disable()
      context.disable()
      propagation.disable()
      this.status({ fill: 'red', shape: 'ring', text: 'deactivated' })
    })

    this.status({ fill: 'green', shape: 'ring', text: url })
  }

  // credentials are stored apart from the flow, so tokens never end up in `flows.json`
  RED.nodes.registerType('OpenTelemetry', OpenTelemetryNode, {
    credentials: {
      token: { type: 'password' },
      username: { type: 'text' },
      password: { type: 'password' },
    },
  })
}
