const os = require('os')
const { name, version } = require('../package.json')
const { trace, context, propagation, SpanKind, SpanStatusCode } = require('@opentelemetry/api')
const { Resource } = require('@opentelemetry/resources')
const { ATTR_SERVICE_NAME, ATTR_HTTP_RESPONSE_STATUS_CODE, ATTR_URL_PATH, ATTR_SERVER_ADDRESS, ATTR_SERVER_PORT, ATTR_URL_SCHEME, ATTR_HTTP_REQUEST_METHOD, ATTR_CLIENT_ADDRESS, ATTR_USER_AGENT_ORIGINAL, ATTR_HTTP_REQUEST_HEADER } = require('@opentelemetry/semantic-conventions')
// eslint-disable-next-line node/no-missing-require
const { ATTR_HOST_NAME, ATTR_CODE_FUNCTION } = require('@opentelemetry/semantic-conventions/incubating')
const { BasicTracerProvider, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base')
const { B3InjectEncoding, B3Propagator } = require('@opentelemetry/propagator-b3')
const { JaegerPropagator } = require('@opentelemetry/propagator-jaeger')
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
 *
 * @typedef {object} Run A single flow execution: one root span and the node spans below it
 * @property {string} id
 * @property {Span} rootSpan
 * @property {Context} ctx Context holding the root span, used as parent of every node span
 * @property {Map<string, Span>} spans Open node spans, keyed by `<msgId>#<nodeId>`
 * @property {Set<string>} ignored Span keys of nodes excluded from tracing
 * @property {Set<string>} entrySpans Span keys of nodes that emitted a message without receiving one
 * @property {number} pending Number of open node spans (the root ends when this reaches 0)
 * @property {number} updateTimestamp
 * @property {boolean} ended
 *
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
/** Type of the node that started the run, on the run span only */
const ATTR_TRIGGER_TYPE = 'node_red.trigger.type'
const ATTR_SPAN_INCOMPLETE = 'node_red.span.incomplete'
const ATTR_LINK_TYPE = 'node_red.link.type'

/**
 * Message property carrying the run identifier. Kept under its historical name so that
 * flows and dashboards referring to it keep working; it now identifies the whole flow
 * execution instead of only the message that entered a `split` node.
 */
const RUN_ID_PROPERTY = 'otelRootMsgId'

/** Node types that emit messages without receiving one but whose span is closed elsewhere */
const CORRELATED_ENTRY_TYPES = ['http in']

/** How long the context of a finished run stays available for linking a continuation (ms) */
const LINKABLE_RUN_RETENTION = 60000

/** Upper bound on retained run contexts, so a busy instance cannot grow the map unchecked */
const LINKABLE_RUN_LIMIT = 10000

const fakeSpan = {
  end: () => {},
  recordException: () => {},
  setStatus: () => {},
  setAttribute: () => {},
  setAttributes: () => {},
}

/**
 * Flow executions currently in progress, keyed by run id
 * @type {Map<string, Run>}
 */
const runs = new Map()

/**
 * What each node is currently processing, used to attribute a newly created message to the
 * run its emitting node belongs to (Node-RED mints a fresh `_msgid` for every message object
 * a node emits that does not already have one).
 * @type {Map<string, NodeState>}
 */
const nodeStates = new Map()

/**
 * Root span context of recently finished runs, so a continuation can be linked to it
 * @type {Map<string, {spanContext: import('@opentelemetry/api').SpanContext, endTimestamp: number}>}
 */
const endedRuns = new Map()

/**
 * Identifier of the OpenTelemetry node owning the runtime hooks. Hook labels are global to the
 * Node-RED runtime, so only one node can register them.
 * @type {string|null}
 */
let activeNodeId = null

let runSequence = 0
let _isLogging = false
let _rootPrefix = ''
let _timeout = 10
let intervalId = null
let _attributeMappings = []

const propagator = new CompositePropagator({
  propagators: [
    new JaegerPropagator(),
    new W3CTraceContextPropagator(),
    new W3CBaggagePropagator(),
    new B3Propagator(),
    new B3Propagator({
      injectEncoding: B3InjectEncoding.MULTI_HEADER,
    }),
  ],
})

/**
 * Read the run identifier carried by a message
 * @param {any} msg Message data
 * @returns {string|undefined}
 */
function getRunId (msg) {
  // eslint-disable-next-line security/detect-object-injection
  return msg[RUN_ID_PROPERTY]
}

/**
 * Carry the run identifier on a message, so the nodes it reaches join the same trace
 * @param {any} msg Message data
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
 * Find the key of an already open span for this node, tolerating a node that emitted a new
 * message (and therefore a new `_msgid`) while it was processing another one
 * @param {Run} run Run holding the span
 * @param {any} msg Message data
 * @param {string} nodeId Node identifier
 * @returns {string|undefined} Span key, or undefined when this node has no open span
 */
function findSpanKey (run, msg, nodeId) {
  const direct = getSpanKey(msg._msgid, nodeId)
  if (run.spans.has(direct) || run.ignored.has(direct)) {
    return direct
  }
  const state = nodeStates.get(nodeId)
  if (state !== undefined) {
    const viaNodeState = getSpanKey(state.msgId, nodeId)
    if (run.spans.has(viaNodeState) || run.ignored.has(viaNodeState)) {
      return viaNodeState
    }
  }
  return undefined
}

/**
 * Return the first candidate identifier matching a run still in progress
 * @param {Array<string|undefined>} candidateIds Candidate run identifiers, most trusted first
 * @returns {Run|undefined}
 */
function resolveRun (candidateIds) {
  for (const candidateId of candidateIds) {
    if (candidateId !== undefined && runs.has(candidateId)) {
      return runs.get(candidateId)
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
 * Try to continue the trace of the caller, using the context carried by the incoming message
 * @param {any} nodeDefinition Node receiving the message from outside Node-RED
 * @param {any} msg Complete message data
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
 * @param {any} node OTEL node (for using Node-RED utilities)
 * @param {string} eventType
 * @param {any} event
 * @returns
 */
function logEvent (node, eventType, event) {
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
 * Use message data to provide user custom span attributes
 * @param {boolean} isAfter Should attribute analysis be after node processing?
 * @param {any} data Message data to be used for parsing
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
 * @param {any} nodeDefinition Current node definition
 * @param {any} msg Complete message data
 * @param {string} runId Run identifier
 * @returns {Record<string, string | number | boolean >}
 */
function getCommonAttributes (nodeDefinition, msg, runId) {
  return {
    [ATTR_RUN_ID]: runId,
    [ATTR_MSG_ID]: msg._msgid,
    [ATTR_FLOW_ID]: nodeDefinition.z,
    [ATTR_FLOW_NAME]: nodeDefinition._flow?.flow?.label ?? '',
    [ATTR_NODE_ID]: nodeDefinition.id,
    [ATTR_NODE_TYPE]: nodeDefinition.type,
    [ATTR_NODE_NAME]: nodeDefinition.name,
  }
}

/**
 * Start a new run: one root span standing for this flow execution, parented to the caller
 * context when the entry node carries one, and linked to the run it continues when the
 * message comes from an execution that already finished (an asynchronous hand-off).
 * @param {Tracer} tracer Tracer used for creating spans
 * @param {any} msg Complete message data
 * @param {any} nodeDefinition Node starting the run
 * @param {string|undefined} predecessorRunId Run this execution continues, if any
 * @returns {Run}
 */
function createRun (tracer, msg, nodeDefinition, predecessorRunId) {
  // a run is identified by the message that started it, kept unique so that a message sent
  // again later cannot be mistaken for the run it originally belonged to
  let runId = msg._msgid
  if (runs.has(runId) || endedRuns.has(runId)) {
    runId = `${msg._msgid}-${++runSequence}`
  }
  const now = Date.now()
  const links = []
  if (predecessorRunId !== undefined && endedRuns.has(predecessorRunId)) {
    links.push({
      context: endedRuns.get(predecessorRunId).spanContext,
      attributes: { [ATTR_LINK_TYPE]: 'continuation' },
    })
  }
  const rootSpan = tracer.startSpan(_rootPrefix + (nodeDefinition.name || nodeDefinition.type), {
    attributes: {
      [ATTR_IS_MESSAGE_CREATION]: true,
      // what set this run off, kept on the run span so a collector can route or filter on it
      // without looking at the node spans below
      [ATTR_TRIGGER_TYPE]: nodeDefinition.type,
      ...getCommonAttributes(nodeDefinition, msg, runId),
    },
    kind: getSpanKind(nodeDefinition.type),
    links,
  }, extractIncomingContext(nodeDefinition, msg) ?? context.active())
  const run = {
    id: runId,
    rootSpan,
    ctx: trace.setSpan(context.active(), rootSpan),
    spans: new Map(),
    ignored: new Set(),
    entrySpans: new Set(),
    pending: 0,
    updateTimestamp: now,
    ended: false,
  }
  runs.set(runId, run)
  if (_isLogging) {
    console.log(`=> Started run ${runId} on ${nodeDefinition.type}${links.length > 0 ? ` (linked to ${predecessorRunId})` : ''}`)
  }
  return run
}

/**
 * Return the run this message belongs to, starting one when there is none in progress
 * @param {Tracer} tracer Tracer used for creating spans
 * @param {any} msg Complete message data
 * @param {any} nodeDefinition Current node definition
 * @param {Array<string|undefined>} candidateIds Candidate run identifiers, most trusted first
 * @returns {Run}
 */
function getOrCreateRun (tracer, msg, nodeDefinition, candidateIds) {
  const run = resolveRun(candidateIds)
  if (run !== undefined) {
    return run
  }
  // no run in progress: this message starts one, possibly continuing a finished run
  const predecessorRunId = candidateIds.find((candidateId) => candidateId !== undefined && endedRuns.has(candidateId))
  return createRun(tracer, msg, nodeDefinition, predecessorRunId)
}

/**
 * End the root span of a run, keeping its context available for linking a continuation
 * @param {Run} run Run to close
 * @param {number} [endTime] Explicit end timestamp (used when closing an abandoned run)
 */
function finishRun (run, endTime) {
  if (run.ended) {
    return
  }
  run.ended = true
  run.rootSpan.end(endTime)
  endedRuns.set(run.id, {
    spanContext: run.rootSpan.spanContext(),
    endTimestamp: Date.now(),
  })
  if (endedRuns.size > LINKABLE_RUN_LIMIT) {
    // insertion ordered, so this drops the oldest retained context
    endedRuns.delete(endedRuns.keys().next().value)
  }
  runs.delete(run.id)
  if (_isLogging) {
    console.log(`=> Ended run ${run.id}`)
  }
}

/**
 * End a node span and close the run once its last node span is done
 * @param {Run} run Run holding the span
 * @param {string} spanKey Span key
 * @param {number} [endTime] Explicit end timestamp
 */
function endChildSpan (run, spanKey, endTime) {
  if (run.ignored.has(spanKey)) {
    // not traced, and never counted as pending
    run.ignored.delete(spanKey)
    return
  }
  const span = run.spans.get(spanKey)
  if (span === undefined) {
    return
  }
  span.end(endTime)
  run.spans.delete(spanKey)
  run.entrySpans.delete(spanKey)
  run.pending = Math.max(0, run.pending - 1)
  run.updateTimestamp = Date.now()
  if (run.pending === 0) {
    finishRun(run)
  }
}

/**
 * Close runs left behind by nodes that never report completion. Node spans still open are
 * ended (and flagged) instead of being dropped, so the trace keeps them.
 */
function sweepRuns () {
  const now = Date.now()
  try {
    for (const [runId, run] of runs) {
      if (run.updateTimestamp >= now - _timeout) {
        continue
      }
      if (_isLogging) {
        console.log(`Run ${runId} is outdated, ending ${run.spans.size} unfinished span(s)`)
      }
      for (const [spanKey, span] of run.spans) {
        span.setAttribute(ATTR_SPAN_INCOMPLETE, true)
        span.end(run.updateTimestamp)
        run.spans.delete(spanKey)
      }
      run.pending = 0
      run.rootSpan.setAttribute(ATTR_SPAN_INCOMPLETE, true)
      finishRun(run, run.updateTimestamp)
    }
    for (const [runId, endedRun] of endedRuns) {
      if (endedRun.endTimestamp < now - LINKABLE_RUN_RETENTION) {
        endedRuns.delete(runId)
      }
    }
  } catch (error) {
    console.error('An error occurred during run cleaning', error)
  }
}

/**
 * Create a span for this node and message
 * @param {Tracer} tracer Tracer used for creating spans
 * @param {any} msg Complete message data
 * @param {any} nodeDefinition Current node definition
 * @param {Array<string|undefined>} candidateRunIds Candidate run identifiers, most trusted first
 * @param {boolean} isNotTraced Should the node be left untraced?
 * @param {boolean} isEntry Is the node emitting a message it never received?
 * @returns {Span|undefined} Created (or already open) span
 */
function createSpan (tracer, msg, nodeDefinition, candidateRunIds, isNotTraced, isEntry) {
  try {
    if (msg === undefined || msg === null || msg._msgid === undefined) {
      return
    }
    const run = getOrCreateRun(tracer, msg, nodeDefinition, candidateRunIds)
    // Carry the run on the message, so every node downstream joins the same trace even when a
    // node emits a brand new message object (Node-RED gives those a fresh `_msgid`). This also
    // overwrites the run of a message emitted again long after its original run finished.
    setRunId(msg, run.id)

    // an open span for this node is reused, so a node emitting several messages gets one span
    const openSpanKey = findSpanKey(run, msg, nodeDefinition.id)
    if (openSpanKey !== undefined) {
      return run.spans.get(openSpanKey) ?? fakeSpan
    }
    const spanKey = getSpanKey(msg._msgid, nodeDefinition.id)

    if (isNotTraced) {
      // remembered so the node is not looked at again, but never counted as pending
      run.ignored.add(spanKey)
      return fakeSpan
    }

    const localAttributes = parseAttribute(false, msg, nodeDefinition.z, nodeDefinition.type)
    if (_isLogging) {
      console.log(`Local span attributes (start) for ${nodeDefinition.id}, ${nodeDefinition.type}: ${JSON.stringify(localAttributes)}`)
    }
    const now = Date.now()
    const span = tracer.startSpan(nodeDefinition.name || nodeDefinition.type, {
      attributes: {
        [ATTR_CODE_FUNCTION]: nodeDefinition.type,
        [ATTR_IS_MESSAGE_CREATION]: false,
        ...getCommonAttributes(nodeDefinition, msg, run.id),
        ...localAttributes,
      },
      kind: getSpanKind(nodeDefinition.type),
    }, run.ctx)
    span._creationTimestamp = now

    if (nodeDefinition.type === 'http in') {
      const httpAttributes = {
        [ATTR_URL_PATH]: nodeDefinition.url,
        [ATTR_HTTP_REQUEST_METHOD]: nodeDefinition.method.toUpperCase(),
        [ATTR_CLIENT_ADDRESS]: msg.req?.ip,
        [ATTR_HTTP_REQUEST_HEADER('x-forwarded-for')]: msg.req?.headers['x-forwarded-for'],
        [ATTR_USER_AGENT_ORIGINAL]: msg.req?.headers['user-agent'],
      }
      span.setAttributes(httpAttributes)
      if (getSpanAttribute(run.rootSpan, ATTR_NODE_ID) === nodeDefinition.id) {
        run.rootSpan.setAttributes(httpAttributes)
        run.rootSpan.updateName(`${run.rootSpan.name} ${nodeDefinition.url}`)
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
      if (getSpanAttribute(run.rootSpan, ATTR_NODE_ID) === nodeDefinition.id) {
        run.rootSpan.setAttribute(ATTR_URL_PATH, nodeDefinition.serverConfig.path)
        run.rootSpan.updateName(`${run.rootSpan.name} ${nodeDefinition.serverConfig.path}`)
      }
    }

    run.spans.set(spanKey, span)
    run.pending++
    run.updateTimestamp = now
    if (isEntry && !CORRELATED_ENTRY_TYPES.includes(nodeDefinition.type)) {
      // this node never receives a message, so it will never report completion either:
      // its span is closed once the message it created has been dispatched
      run.entrySpans.add(spanKey)
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
 * @param {any} msg Complete message data
 * @param {any} error Any error encountered
 * @param {any} nodeDefinition Current node definition
 */
function endSpan (msg, error, nodeDefinition) {
  try {
    if (msg === undefined || msg === null) {
      return
    }
    const run = resolveRun([getRunId(msg), nodeStates.get(nodeDefinition.id)?.runId, msg._msgid])
    if (run === undefined) {
      return
    }
    const spanKey = findSpanKey(run, msg, nodeDefinition.id)
    if (spanKey === undefined) {
      return
    }
    if (run.ignored.has(spanKey)) {
      run.ignored.delete(spanKey)
      return
    }
    const span = run.spans.get(spanKey)

    if (nodeDefinition.type === 'http request') {
      // add http status code in attribute
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, msg.statusCode)
      if (msg.statusCode >= 400) {
        span.setStatus({ code: SpanStatusCode.ERROR })
      } else if (msg.statusCode >= 200 && msg.statusCode < 300) {
        span.setStatus({ code: SpanStatusCode.OK })
      }
      // add URL info in attributes
      try {
        const url = new URL(msg.responseUrl)
        span.setAttribute(ATTR_URL_PATH, url.pathname)
        span.setAttribute(ATTR_SERVER_ADDRESS, url.hostname)
        span.setAttribute(ATTR_SERVER_PORT, url.port)
        span.setAttribute(ATTR_URL_SCHEME, url.protocol.replace(':', ''))
      } catch (_error) { }
    }
    if (error) {
      // log errors
      if (msg.error) {
        span.recordException(msg.error)
      } else {
        span.recordException(error)
      }
      // the SDK drops a status message that is not a string, and a node that throws reports an
      // Error object here, so the reason would be lost
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) })
      run.rootSpan.setStatus({ code: SpanStatusCode.ERROR })
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
      for (const [httpInSpanKey, spanIn] of run.spans) {
        if (getSpanAttribute(spanIn, ATTR_NODE_TYPE) === 'http in') {
          if (_isLogging) {
            console.log('==> Ended related span for ', httpInSpanKey, 'http in')
          }
          endChildSpan(run, httpInSpanKey)
          break
        }
      }
      // add http status code in attribute
      if (statusCode !== undefined) {
        if (statusCode >= 400) {
          span.setStatus({ code: SpanStatusCode.ERROR })
          run.rootSpan.setStatus({ code: SpanStatusCode.ERROR })
        } else if (statusCode >= 200 && statusCode < 300) {
          span.setStatus({ code: SpanStatusCode.OK })
          run.rootSpan.setStatus({ code: SpanStatusCode.OK })
        }
        span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode)
        run.rootSpan.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode)
      }
    }

    if (_isLogging) {
      console.log('==> Ended span for ', nodeDefinition.id, nodeDefinition.type)
    }
    endChildSpan(run, spanKey)
  } catch (error) {
    console.error(error)
  }
}

/**
 * Build the headers the exporter has to send, from the configured authentication and the
 * additional headers some collectors require (dataset, organization, stream, ...).
 *
 * Secrets live in the node credentials, never in the flow configuration, so they stay out of
 * `flows.json` and out of any exported flow. Headers set in `OTEL_EXPORTER_OTLP_HEADERS` are
 * merged by the SDK itself; a header defined here wins over the environment for the same key.
 *
 * @param {any} config Node configuration
 * @param {any} credentials Node credentials
 * @param {any} node OTEL node, warned when the configuration is incomplete
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

module.exports = function (RED) {
  'use strict'

  function OpenTelemetryNode (config) {
    RED.nodes.createNode(this, config)

    // get config
    const { url, protocol, serviceName, rootPrefix, ignoredTypes, propagateHeadersTypes, isLogging, timeout, attributeMappings } = config
    const node = this

    // check config
    if (!url) {
      this.status({ fill: 'red', shape: 'ring', text: 'invalid configuration' })
      return
    }

    // The `.otel` hook label is global to the Node-RED runtime, so a single node can own the
    // hooks. A second one stays inactive rather than failing the deploy with
    // "Hook onSend.otel already registered", and leaves the active node's settings alone.
    if (activeNodeId !== null && activeNodeId !== node.id) {
      node.warn(`OpenTelemetry tracing is already handled by node "${activeNodeId}", this node stays inactive. One OpenTelemetry node covers every flow, wherever it is placed.`)
      node.status({ fill: 'grey', shape: 'ring', text: 'inactive, another OTEL node is active' })
      return
    }
    // reclaim hooks left behind by an instance whose close handler did not run
    RED.hooks.remove('*.otel')
    activeNodeId = node.id

    const ignoredTypesList = ignoredTypes.split(',').map(key => key.trim())
    const propagateHeadersTypesList = propagateHeadersTypes.split(',').map(key => key.trim())
    _isLogging = isLogging
    _rootPrefix = rootPrefix
    _timeout = timeout * 1000
    _attributeMappings = attributeMappings

    // authentication and any additional headers the collector requires
    const headers = getExporterHeaders(config, this.credentials, node)
    if (Object.keys(headers).length > 0 && url.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) {
      node.warn('Exporter headers are sent over plain http, they can be read in transit: use https for a remote collector')
    }

    // create tracer
    let spanProcessor
    if (protocol === 'proto') {
      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto')
      spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter({ url, headers }))
    } else {
      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http')
      spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter({ url, headers }))
    }
    const provider = new BasicTracerProvider({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_HOST_NAME]: os.hostname(),
      }),
      spanProcessors: [spanProcessor],
    })
    provider.register()
    const tracer = trace.getTracer(name, version)

    // add hooks
    RED.hooks.add('onSend.otel', (events) => {
      if (events.length === 0) {
        return
      }
      logEvent(node, '1.onSend', events[0])
      const { msg, source } = events[0]
      // a node emitting a message without processing one starts a run and never reports
      // completion, so its span is flagged to be closed on dispatch
      const isEntry = !(nodeStates.get(source.node.id)?.inFlight > 0)
      createSpan(tracer, msg, source.node, [nodeStates.get(source.node.id)?.runId, getRunId(msg)], ignoredTypesList.includes(source.node.type), isEntry)
    })

    RED.hooks.add('preDeliver.otel', (sendEvent) => {
      // the run is already carried by the message: `onSend` stamped it before the message was
      // cloned for delivery, so every clone reaching this point belongs to it
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

    RED.hooks.add('postDeliver.otel', (sendEvent) => {
      logEvent(node, '4.postDeliver', sendEvent)
      const { msg, source, destination } = sendEvent
      const span = createSpan(tracer, msg, destination.node, [getRunId(msg), nodeStates.get(source.node.id)?.runId], ignoredTypesList.includes(destination.node.type), false)
      if (propagateHeadersTypesList.includes(destination.node.type)) {
        const run = resolveRun([getRunId(msg)])
        const output = {}
        // the span of the receiving node when it is traced, the run itself otherwise
        propagation.inject(span?.spanContext !== undefined ? trace.setSpan(context.active(), span) : run?.ctx ?? context.active(), output)
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

      const sourceRun = resolveRun([nodeStates.get(source.node.id)?.runId, getRunId(msg)])
      if (sourceRun === undefined) {
        return
      }
      const sourceSpanKey = findSpanKey(sourceRun, msg, source.node.id)
      if (sourceSpanKey === undefined) {
        return
      }
      if (sourceRun.entrySpans.has(sourceSpanKey)) {
        // the node created this message instead of receiving one: no completion event will
        // ever come for it, so its span ends now that the message has been dispatched
        if (_isLogging) {
          console.log(`Entry span ${sourceSpanKey} will be ended`)
        }
        endChildSpan(sourceRun, sourceSpanKey)
      } else if (source.node.type === 'switch' || source.node.type.startsWith('subflow')) {
        // end switch or subflow spans as they do not trigger onComplete
        if (_isLogging) {
          console.log(`Switch or subflow span ${sourceSpanKey} will be ended`)
        }
        endChildSpan(sourceRun, sourceSpanKey)
      }
    })

    RED.hooks.add('postReceive.otel', (sendEvent) => {
      logEvent(node, '6.postReceive', sendEvent)
    })

    RED.hooks.add('onReceive.otel', (receiveEvent) => {
      // remember what this node is working on, to attribute the messages it emits to this run
      const { msg, destination } = receiveEvent
      const state = nodeStates.get(destination.node.id) ?? { inFlight: 0 }
      state.runId = getRunId(msg) ?? msg._msgid
      state.msgId = msg._msgid
      state.inFlight++
      nodeStates.set(destination.node.id, state)
      logEvent(node, '5.onReceive', receiveEvent)
    })

    RED.hooks.add('onComplete.otel', (completeEvent) => {
      logEvent(node, '7.onComplete', completeEvent)
      const state = nodeStates.get(completeEvent.node.node.id)
      if (state !== undefined) {
        state.inFlight = Math.max(0, state.inFlight - 1)
      }
      endSpan(completeEvent.msg, completeEvent.error, completeEvent.node.node)
    })

    // add timer for closing runs abandoned by nodes that never report completion
    if (intervalId) {
      clearInterval(intervalId)
    }
    intervalId = setInterval(sweepRuns, 5000)

    // on node stop, remove previous hooks, cancel timer and clear maps
    this.on('close', async function () {
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
      RED.hooks.remove('*.otel')
      activeNodeId = null
      runs.clear()
      nodeStates.clear()
      endedRuns.clear()
      await provider.shutdown()
      trace.disable()
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
