const os = require('os')
const { name, version } = require('../package.json')
const { trace, context, propagation, SpanKind, SpanStatusCode } = require('@opentelemetry/api')
const { Resource } = require('@opentelemetry/resources')
const { SemanticResourceAttributes, SemanticAttributes } = require('@opentelemetry/semantic-conventions')
const { BasicTracerProvider, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base')
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http')
const { B3InjectEncoding, B3Propagator } = require('@opentelemetry/propagator-b3')
const { JaegerPropagator } = require('@opentelemetry/propagator-jaeger')
const {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} = require('@opentelemetry/core')
const { clearInterval } = require('timers')
const { defaultTextMapGetter } = require('@opentelemetry/api')

const ATTR_MSG_ID = 'node_red.msg.id'
const ATTR_FLOW_ID = 'node_red.flow.id'
const ATTR_NODE_ID = 'node_red.node.id'
const ATTR_NODE_TYPE = 'node_red.node.type'
const ATTR_NODE_NAME = 'node_red.node.name'
const ORPHAN_NODE_TYPES = ['switch', 'rbe']
const fakeSpan = {
  end: () => {},
  recordException: () => {},
  setStatus: () => {},
  setAttribute: () => {},
}
const msgSpans = new Map()
let _isLogging = false
let _rootPrefix = ''
let _timeout = 10
let intervalId = null

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

function getMsgId (msg) {
  return msg.otelRootMsgId ? msg.otelRootMsgId : msg._msgid
}

function getSpanId (msg, nodeDefinition) {
  const msgId = nodeDefinition.type === 'split' && msg.otelRootMsgId ? msg.otelRootMsgId : msg._msgid
  return `${msgId}#${nodeDefinition.id}`
}

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
          [SemanticAttributes.CODE_FUNCTION]: nodeDefinition.type,
          [ATTR_MSG_ID]: msgId,
          [ATTR_FLOW_ID]: nodeDefinition.z,
          [ATTR_NODE_ID]: nodeDefinition.id,
          [ATTR_NODE_TYPE]: nodeDefinition.type,
          [ATTR_NODE_NAME]: nodeDefinition.name,
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
    const span = tracer.startSpan(spanName, {
      attributes: {
        [SemanticAttributes.CODE_FUNCTION]: nodeDefinition.type,
        [ATTR_MSG_ID]: msgId,
        [ATTR_FLOW_ID]: nodeDefinition.z,
        [ATTR_NODE_ID]: nodeDefinition.id,
        [ATTR_NODE_TYPE]: nodeDefinition.type,
        [ATTR_NODE_NAME]: nodeDefinition.name,
      },
      kind,
    }, ctx)
    span._creationTimestamp = now

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
      span.setAttribute(SemanticAttributes.HTTP_STATUS_CODE, msg.statusCode)
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
    span.end()
    const currentSpanCreationTimestamp = span._creationTimestamp
    if (_isLogging) {
      console.log('==> Ended span for ', nodeDefinition.id, nodeDefinition.type)
    }
    parent.spans.delete(msgSpanId)
    parent.updateTimestamp = Date.now()

    // correlate with "http in" node
    if (nodeDefinition.type === 'http response') {
      for (const [msgSpanId, span] of parent.spans) {
        if (span.attributes['node_red.node.type'] === 'http in') {
          if (_isLogging) {
            console.log('==> Ended related span for ', msgSpanId, 'http in')
          }
          span.end()
          parent.spans.delete(msgSpanId)
          break
        }
      }
    }

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
    const { url, serviceName, rootPrefix, ignoredTypes, propagateHeadersTypes, isLogging, timeout } = config
    const ignoredTypesList = ignoredTypes.split(',').map(key => key.trim())
    const propagateHeadersTypesList = propagateHeadersTypes.split(',').map(key => key.trim())
    _isLogging = isLogging
    _rootPrefix = rootPrefix
    _timeout = timeout

    // check config
    if (!url) {
      this.status({ fill: 'red', shape: 'ring', text: 'invalid configuration' })
      return
    }
    const node = this

    // create tracer
    const provider = new BasicTracerProvider({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
        [SemanticResourceAttributes.HOST_NAME]: os.hostname(),
      }),
    })
    provider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter({ url })))
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
    this.on('close', function () {
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
      RED.hooks.remove('*.otel')
      msgSpans.clear()
      this.status({ fill: 'red', shape: 'ring', text: 'deactivated' })
    })

    this.status({ fill: 'green', shape: 'ring', text: 'activated' })
  }

  RED.nodes.registerType('OpenTelemetry', OpenTelemetryNode)
}
