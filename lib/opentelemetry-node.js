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
 */

const ATTR_MSG_ID = 'node_red.msg.id'
const ATTR_FLOW_ID = 'node_red.flow.id'
const ATTR_NODE_ID = 'node_red.node.id'
const ATTR_NODE_TYPE = 'node_red.node.type'
const ATTR_NODE_NAME = 'node_red.node.name'
const ATTR_IS_MESSAGE_CREATION = 'node_red.msg.new'
const ORPHAN_NODE_TYPES = ['switch', 'rbe']
const fakeSpan = {
  end: () => {},
  recordException: () => {},
  setStatus: () => {},
  setAttribute: () => {},
}
/**
 * The map of running parent spans, each message will be an entry, each span will be stored in its own spans map
 * @type {Map<string, {parentSpan: Span, spans: Map<string, Span>, updateTimestamp: number}>}
 */
const msgSpans = new Map()
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
 * Get parent span id or current message id if there is none
 * @param {any} msg Message data to be used to retrieve the parent span id `otelRootMsgId`
 * @returns {string}
 */
function getMsgId (msg) {
  return msg.otelRootMsgId ? msg.otelRootMsgId : msg._msgid
}

/**
 * Return the span identifier for this node and message
 * @param {any} msg Message data to be used to retrieve the parent message id
 * @param {any} nodeDefinition Current node definition
 * @returns {string}
 */
function getSpanId (msg, nodeDefinition) {
  const msgId = nodeDefinition.type === 'split' && msg.otelRootMsgId ? msg.otelRootMsgId : msg._msgid
  return `${msgId}#${nodeDefinition.id}`
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
    let msg = `rootMsgId: ${getMsgId(event.msg)}, _msgId: ${event.msg._msgid}:`
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
 * Delete outdated message spans
 */
function deleteOutdatedMsgSpans () {
  const now = Date.now()
  try {
    for (const [msgId, msgSpan] of msgSpans) {
      if (msgSpan.updateTimestamp < now - _timeout) {
        // ending parent span and remove it
        if (_isLogging) {
          console.log(`Parent span "${msgSpan.parentSpan.name}" ${msgId} is outdated, ending`)
        }
        msgSpan.parentSpan.end(msgSpan.updateTimestamp)
        msgSpans.delete(msgId)
      }
    }
  } catch (error) {
    console.error('An error occurred during span cleaning', error)
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
 * Create a span for this node and message
 * @param {Tracer} tracer Tracer used for creating spans
 * @param {any} msg Complete message data
 * @param {any} nodeDefinition Current node definition
 * @param {any} node OTEL node (for using Node-RED utilities)
 * @param {boolean} isNotTraced Is the node should be traced?
 * @returns {Span|undefined} Created span
 */
function createSpan (tracer, msg, nodeDefinition, node, isNotTraced) {
  try {
    // check and get message id (handle root message id for splitted parts)
    const msgId = getMsgId(msg)
    if (msgId === undefined) {
      return
    }
    // check and get span id (msg id and node id)
    const spanId = getSpanId(msg, nodeDefinition)
    if (msgSpans.has(msgId) && msgSpans.get(msgId).spans.has(spanId)) {
      return
    }

    // define context variables
    const spanName = nodeDefinition.name || nodeDefinition.type
    const now = Date.now()
    let parentSpan, ctx, kind

    // try to set span kind
    switch (nodeDefinition.type) {
      case 'http in':
      case 'tcp in':
      case 'udp in':
        kind = SpanKind.SERVER
        break
      case 'http request':
      case 'tcp request':
        kind = SpanKind.CLIENT
        break
      case 'mqtt in':
      case 'amqp-in':
      case 'websocket in':
        kind = SpanKind.CONSUMER
        break
      case 'mqtt out':
      case 'amqp-out':
      case 'websocket out':
        kind = SpanKind.PRODUCER
        break
      default:
        kind = SpanKind.INTERNAL
        break
    }

    // prepare common attributes
    const commonAttributes = {
      [ATTR_MSG_ID]: msgId,
      [ATTR_FLOW_ID]: nodeDefinition.z,
      [ATTR_NODE_ID]: nodeDefinition.id,
      [ATTR_NODE_TYPE]: nodeDefinition.type,
      [ATTR_NODE_NAME]: nodeDefinition.name,
    }

    // handle context
    if (msgSpans.has(msgId)) {
      // get (parent) message context
      ctx = trace.setSpan(context.active(), msgSpans.get(msgId).parentSpan)
    } else {
      if (nodeDefinition.type === 'http in') {
        // try to get trace context in incoming http request headers
        ctx = propagator.extract(context.active(), msg.req.headers, defaultTextMapGetter)
      } else if (nodeDefinition.type === 'mqtt in' && msg.userProperties) {
        // try to get trace context in incoming mqtt v5 user properties
        ctx = propagator.extract(context.active(), msg.userProperties, defaultTextMapGetter)
      } else if (nodeDefinition.type === 'amqp-in') {
        // try to get trace context in incoming ampq message headers
        ctx = propagator.extract(context.active(), msg.properties.headers, defaultTextMapGetter)
      }
      // create the parent span
      parentSpan = tracer.startSpan(_rootPrefix + spanName, {
        attributes: {
          [ATTR_IS_MESSAGE_CREATION]: true,
          [ATTR_SERVICE_NAME]: nodeDefinition.type,
          ...commonAttributes,
        },
        kind,
      }, ctx)
      // create the message context
      ctx = trace.setSpan(context.active(), parentSpan)
      // store message parent span
      msgSpans.set(msgId, {
        parentSpan,
        spans: new Map(),
        updateTimestamp: now,
      })

      if (_isLogging) {
        console.log('=> Created parent span for', nodeDefinition.type)
      }
    }

    if (isNotTraced) {
      // store fake child span (required to finish parent span)
      msgSpans.get(msgId).spans.set(spanId, Object.assign({
        attributes: { [ATTR_NODE_TYPE]: nodeDefinition.type },
        _creationTimestamp: now,
      }, fakeSpan))
      return fakeSpan
    }
    // create child span
    const localAttributes = parseAttribute(false, msg, nodeDefinition.z, nodeDefinition.type)
    if (_isLogging) {
      console.log(`Local span attributes (start) for ${nodeDefinition.id}, ${nodeDefinition.type}: ${JSON.stringify(localAttributes)}`)
    }
    const span = tracer.startSpan(spanName, {
      attributes: {
        [ATTR_CODE_FUNCTION]: nodeDefinition.type,
        [ATTR_IS_MESSAGE_CREATION]: false,
        ...commonAttributes,
        ...localAttributes,
      },
      kind,
    }, ctx)
    span._creationTimestamp = now

    if (nodeDefinition.type === 'http in') {
      const httpAttributes = {
        [ATTR_URL_PATH]: nodeDefinition.url,
        [ATTR_HTTP_REQUEST_METHOD]: nodeDefinition.method.toUpperCase(),
        [ATTR_CLIENT_ADDRESS]: msg.req.ip,
        [ATTR_HTTP_REQUEST_HEADER('x-forwarded-for')]: msg.req.headers['x-forwarded-for'],
        [ATTR_USER_AGENT_ORIGINAL]: msg.req.headers['user-agent'],
      }
      span.setAttributes(httpAttributes)
      if (parentSpan !== undefined) {
        parentSpan.setAttributes(httpAttributes)
        parentSpan.updateName(`${parentSpan.name} ${nodeDefinition.url}`)
      }
    }
    if (nodeDefinition.type === 'websocket out') {
      // add URL info in attributes
      try {
        const url = URL.parse(nodeDefinition.serverConfig.path)
        span.setAttribute(ATTR_URL_PATH, url.pathname)
        span.setAttribute(ATTR_SERVER_ADDRESS, url.hostname)
        span.setAttribute(ATTR_SERVER_PORT, url.port)
        span.setAttribute(ATTR_URL_SCHEME, url.protocol.replace(':', ''))
      } catch (_error) { }
    }

    if (nodeDefinition.type === 'websocket in') {
      // add URL info in attributes
      span.setAttribute(ATTR_URL_PATH, nodeDefinition.serverConfig.path)
      if (parentSpan !== undefined) {
        parentSpan.setAttribute(ATTR_URL_PATH, nodeDefinition.serverConfig.path)
        parentSpan.updateName(`${parentSpan.name} ${nodeDefinition.serverConfig.path}`)
      }
    }

    if (_isLogging) {
      console.log('=> Created span for', nodeDefinition.type)
    }

    // store child span
    const parent = msgSpans.get(msgId)
    parent.spans.set(spanId, span)
    parent.updateTimestamp = now
    return span
  } catch (error) {
    console.error(`An error occurred during span creation ${eventType}`, error)
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
    // check and get message id (handle root message id for splitted parts)
    const msgId = getMsgId(msg)
    if (!msgId) {
      return
    }
    // check and get span id (msg id and node id)
    const msgSpanId = getSpanId(msg, nodeDefinition)
    if (!msgSpans.has(msgId) || !msgSpans.get(msgId).spans.has(msgSpanId)) {
      return
    }

    // end and remove child span
    const parent = msgSpans.get(msgId)
    const span = parent.spans.get(msgSpanId)
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
        const url = URL.parse(msg.responseUrl)
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
      span.setStatus({ code: SpanStatusCode.ERROR, message: error })
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
      const statusCode = msg.res._res.statusCode
      for (const [msgSpanId, spanIn] of parent.spans) {
        if (spanIn.attributes['node_red.node.type'] === 'http in') {
          if (_isLogging) {
            console.log('==> Ended related span for ', msgSpanId, 'http in')
          }
          spanIn.end()
          parent.spans.delete(msgSpanId)
          break
        }
      }
      // add http status code in attribute
      if (statusCode >= 400) {
        span.setStatus({ code: SpanStatusCode.ERROR })
        parent.parentSpan.setStatus({ code: SpanStatusCode.ERROR })
      } else if (statusCode >= 200 && statusCode < 300) {
        span.setStatus({ code: SpanStatusCode.OK })
        parent.parentSpan.setStatus({ code: SpanStatusCode.OK })
      }
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode)
      parent.parentSpan.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode)
    }

    span.end()
    const currentSpanCreationTimestamp = span._creationTimestamp
    if (_isLogging) {
      console.log('==> Ended span for ', nodeDefinition.id, nodeDefinition.type)
    }
    parent.spans.delete(msgSpanId)
    parent.updateTimestamp = Date.now()

    // check orphan traces (nodes that do not trigger complete event)
    let isOrphan = true
    for (const [, span] of parent.spans) {
      if (!ORPHAN_NODE_TYPES.includes(span.attributes['node_red.node.type']) || span._creationTimestamp > currentSpanCreationTimestamp) {
        // found an active span, skip
        isOrphan = false
        break
      }
    }
    if (isOrphan) {
      for (const [msgSpanId] of parent.spans) {
        if (_isLogging) {
          console.log(`Orphan span to delete: ${msgSpanId}`)
        }
        parent.spans.delete(msgSpanId)
      }
      // all children are completed, end and remove parent span
      if (_isLogging) {
        console.log(`Parent span "${parent.parentSpan.name}" no longer has child span, ending`)
      }
      parent.parentSpan.end()
      msgSpans.delete(msgId)
    }
  } catch (error) {
    console.error(error)
  }
}

module.exports = function (RED) {
  'use strict'

  function OpenTelemetryNode (config) {
    RED.nodes.createNode(this, config)

    // get config
    const { url, protocol, serviceName, rootPrefix, ignoredTypes, propagateHeadersTypes, isLogging, timeout, attributeMappings } = config
    const ignoredTypesList = ignoredTypes.split(',').map(key => key.trim())
    const propagateHeadersTypesList = propagateHeadersTypes.split(',').map(key => key.trim())
    _isLogging = isLogging
    _rootPrefix = rootPrefix
    _timeout = timeout * 1000
    _attributeMappings = attributeMappings

    // check config
    if (!url) {
      this.status({ fill: 'red', shape: 'ring', text: 'invalid configuration' })
      return
    }
    const node = this

    // create tracer
    let spanProcessor
    if (protocol === 'proto') {
      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto')
      spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter({ url }))
    } else {
      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http')
      spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter({ url }))
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
      createSpan(tracer, events[0].msg, events[0].source.node, node, ignoredTypesList.includes(events[0].source.node.type))
    })

    RED.hooks.add('preDeliver.otel', (sendEvent) => {
      if (propagateHeadersTypesList.includes(sendEvent.source.node.type)) {
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
      const span = createSpan(tracer, sendEvent.msg, sendEvent.destination.node, node, ignoredTypesList.includes(sendEvent.destination.node.type))
      if (propagateHeadersTypesList.includes(sendEvent.destination.node.type)) {
        const output = {}
        const ctx = trace.setSpan(context.active(), span)
        propagation.inject(ctx, output)
        switch (sendEvent.destination.node.type) {
          // add trace context in mqtt v5 user properties
          case 'mqtt out':
            if (!sendEvent.msg.userProperties) {
              sendEvent.msg.userProperties = {}
            }
            Object.assign(sendEvent.msg.userProperties, output)
            break
          default:
            // add trace context in http request headers
            if (!sendEvent.msg.headers) {
              sendEvent.msg.headers = {}
            }
            Object.assign(sendEvent.msg.headers, output)
            break
        }
      }
      if (sendEvent.source.node.type === 'switch' || sendEvent.source.node.type.startsWith('subflow')) {
        // end switch or subflow spans as they do not trigger onComplete
        const msgId = getMsgId(sendEvent.msg)
        const spanId = getSpanId(sendEvent.msg, sendEvent.source.node)
        const parent = msgSpans.get(msgId)
        if (parent && parent.spans.has(spanId)) {
          if (_isLogging) {
            console.log(`Switch or subflow span ${spanId} will be ended`)
          }
          parent.spans.get(spanId).end()
          parent.spans.delete(spanId)
        }
      }
    })

    RED.hooks.add('postReceive.otel', (sendEvent) => {
      logEvent(node, '6.postReceive', sendEvent)
      // endSpan(sendEvent.msg, null, sendEvent.destination.node)
    })

    RED.hooks.add('onReceive.otel', (receiveEvent) => {
      if (receiveEvent.destination.node.type === 'split') {
        // store parent message id before split
        receiveEvent.msg.otelRootMsgId = getMsgId(receiveEvent.msg)
      }
      logEvent(node, '5.onReceive', receiveEvent)
    })

    RED.hooks.add('onComplete.otel', (completeEvent) => {
      logEvent(node, '7.onComplete', completeEvent)
      endSpan(completeEvent.msg, completeEvent.error, completeEvent.node.node)
    })

    // add timer for killing outdated message spans
    intervalId = setInterval(deleteOutdatedMsgSpans, 5000)

    // on node stop, remove previous hooks, cancel timer and clear map
    this.on('close', async function () {
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
      RED.hooks.remove('*.otel')
      msgSpans.clear()
      await provider.shutdown()
      trace.disable()
      this.status({ fill: 'red', shape: 'ring', text: 'deactivated' })
    })

    this.status({ fill: 'green', shape: 'ring', text: url })
  }

  RED.nodes.registerType('OpenTelemetry', OpenTelemetryNode)
}
