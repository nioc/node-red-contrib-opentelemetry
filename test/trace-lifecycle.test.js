const test = require('node:test')
const assert = require('node:assert/strict')
const { MiniRed, sleep } = require('./helpers/mini-red')

/** ReadableSpan exposes the parent as `parentSpanId` (SDK 1.x) or `parentSpanContext` (2.x) */
function parentSpanIdOf (span) {
  return span.parentSpanId ?? span.parentSpanContext?.spanId
}

function traceIdsOf (spans) {
  return new Set(spans.map((span) => span.spanContext().traceId))
}

function byName (spans, name) {
  return spans.filter((span) => span.name === name)
}

/**
 * The span standing for the whole flow execution. It is identified by `node_red.msg.new`
 * rather than by the absence of a parent, since it is a child of the caller span whenever the
 * entry node received a trace context from outside Node-RED.
 */
function runSpansOf (spans) {
  return spans.filter((span) => span.attributes['node_red.msg.new'] === true)
}

function rootOf (spans) {
  const roots = runSpansOf(spans)
  assert.equal(roots.length, 1, `expected exactly one run span, got ${roots.map((s) => s.name).join(', ')}`)
  return roots[0]
}

test('a message forwarded unchanged produces a single trace', async () => {
  const red = new MiniRed()
  const inject = red.node('n1', 'inject')
  const change = red.node('n2', 'change')
  const debug = red.node('n3', 'debug')
  red.wire(inject, [change])
  red.wire(change, [debug])

  red.send(inject, { payload: 1 })
  red.run()
  const spans = await red.stop()

  assert.equal(traceIdsOf(spans).size, 1)
  const root = rootOf(spans)
  assert.equal(root.name, 'Message inject')
  assert.equal(parentSpanIdOf(root), undefined, 'with no incoming context the run span is a trace root')
  // debug is in the ignored types, so it gets no span
  assert.deepEqual(spans.map((span) => span.name).sort(), ['Message inject', 'change', 'inject'])
  for (const span of spans.filter((span) => span !== root)) {
    assert.equal(parentSpanIdOf(span), root.spanContext().spanId)
    assert.equal(span.attributes['node_red.run.id'], root.attributes['node_red.run.id'])
  }
})

test('a node emitting a brand new message stays in the same trace', async () => {
  const red = new MiniRed()
  const inject = red.node('n1', 'inject')
  const fn = red.node('n2', 'function')
  const change = red.node('n3', 'change')
  const debug = red.node('n4', 'debug')
  red.wire(inject, [fn])
  red.wire(fn, [change])
  red.wire(change, [debug])
  // returning a new object instead of the received message: Node-RED mints a fresh _msgid,
  // which used to start a second, unrelated trace
  red.on(fn, (msg, send, done) => {
    send({ payload: 'rebuilt' })
    done()
  })

  red.send(inject, { payload: 1 })
  red.run()
  const spans = await red.stop()

  assert.equal(traceIdsOf(spans).size, 1, 'the whole execution must be one trace')
  const root = rootOf(spans)
  assert.equal(byName(spans, 'function').length, 1, 'the function node must get exactly one span')
  const changeSpan = byName(spans, 'change')[0]
  assert.equal(parentSpanIdOf(changeSpan), root.spanContext().spanId)
  // the downstream span carries its own message id, and the run id of the whole execution
  assert.notEqual(changeSpan.attributes['node_red.msg.id'], root.attributes['node_red.msg.id'])
  assert.equal(changeSpan.attributes['node_red.run.id'], root.attributes['node_red.run.id'])
})

test('split parts stay in the trace of the message they came from', async () => {
  const red = new MiniRed()
  const inject = red.node('n1', 'inject')
  const split = red.node('n2', 'split')
  const change = red.node('n3', 'change')
  const debug = red.node('n4', 'debug')
  red.wire(inject, [split])
  red.wire(split, [change])
  red.wire(change, [debug])
  red.on(split, (msg, send, done) => {
    for (const part of ['a', 'b', 'c']) {
      send({ payload: part })
    }
    done()
  })

  red.send(inject, { payload: ['a', 'b', 'c'] })
  red.run()
  const spans = await red.stop()

  assert.equal(traceIdsOf(spans).size, 1)
  assert.equal(byName(spans, 'split').length, 1, 'the split node must get one span, not one per part')
  assert.equal(byName(spans, 'change').length, 3, 'each part must get its own downstream span')
  const root = rootOf(spans)
  for (const span of byName(spans, 'change')) {
    assert.equal(parentSpanIdOf(span), root.spanContext().spanId)
  }
})

test('an incoming trace context is continued instead of starting a new trace', async () => {
  const red = new MiniRed()
  const callerTraceId = '0af7651916cd43dd8448eb211c80319c'
  const callerSpanId = 'b7ad6b7169203331'
  const httpIn = red.node('n1', 'http in', { url: '/test', method: 'get' })
  const fn = red.node('n2', 'function')
  const httpResponse = red.node('n3', 'http response')
  red.wire(httpIn, [fn])
  red.wire(fn, [httpResponse])
  red.on(httpResponse, (msg, send, done) => done())

  red.send(httpIn, {
    payload: '',
    req: { ip: '127.0.0.1', headers: { traceparent: `00-${callerTraceId}-${callerSpanId}-01`, 'user-agent': 'test' } },
    res: { _res: { statusCode: 200 } },
  })
  red.run()
  const spans = await red.stop()

  assert.equal(traceIdsOf(spans).size, 1)
  const root = rootOf(spans)
  assert.equal(root.spanContext().traceId, callerTraceId, 'the run must join the caller trace')
  assert.equal(parentSpanIdOf(root), callerSpanId, 'the run must be a child of the caller span')
  assert.equal(root.name, 'Message http in /test')
  assert.equal(root.attributes['http.response.status_code'], 200)
  // the "http in" span is closed by the "http response" node, and must be exported
  assert.equal(byName(spans, 'http in').length, 1)
  assert.equal(byName(spans, 'http response').length, 1)
})

test('a node that emits without receiving gets its span exported', async () => {
  const red = new MiniRed()
  // tcp in never receives a message and never reports completion (issue #15)
  const tcpIn = red.node('n1', 'tcp in')
  const debug = red.node('n2', 'debug')
  red.wire(tcpIn, [debug])

  red.send(tcpIn, { payload: 'from the socket' })
  red.run()
  const spans = await red.stop()

  assert.equal(byName(spans, 'tcp in').length, 1, 'the entry span must not be dropped')
  const root = rootOf(spans)
  assert.equal(root.name, 'Message tcp in')
  assert.equal(traceIdsOf(spans).size, 1)
})

test('an error marks both the node span and the run as failed', async () => {
  const red = new MiniRed()
  const inject = red.node('n1', 'inject')
  const fn = red.node('n2', 'function')
  red.wire(inject, [fn])
  red.on(fn, (msg, send, done) => done('boom'))

  red.send(inject, { payload: 1 })
  red.run()
  const spans = await red.stop()

  assert.equal(traceIdsOf(spans).size, 1)
  const fnSpan = byName(spans, 'function')[0]
  assert.equal(fnSpan.status.code, 2, 'node span must be ERROR')
  assert.equal(rootOf(spans).status.code, 2, 'run span must be ERROR')
})

test('a message emitted after the run finished starts a linked trace', async () => {
  const red = new MiniRed()
  const inject = red.node('n1', 'inject')
  // a node that acknowledges the message and emits later, decoupling input from output
  const delay = red.node('n2', 'delay')
  const change = red.node('n3', 'change')
  red.wire(inject, [delay])
  red.wire(delay, [change])
  red.on(delay, (msg, send, done) => done())

  red.send(inject, { payload: 1 })
  red.run()
  // the queued message is released once the first run is already over
  red.send(delay, { payload: 'released' })
  red.run()
  const spans = await red.stop()

  const traceIds = traceIdsOf(spans)
  assert.equal(traceIds.size, 2, 'an asynchronous hand-off is a separate trace')
  const roots = runSpansOf(spans)
  assert.equal(roots.length, 2)
  const [firstRoot, secondRoot] = roots
  assert.equal(secondRoot.links.length, 1, 'the continuation must be linked to the run it came from')
  assert.equal(secondRoot.links[0].context.spanId, firstRoot.spanContext().spanId)
  assert.equal(secondRoot.links[0].attributes['node_red.link.type'], 'continuation')
})

test('a run abandoned by a node still exports its open spans', async () => {
  // timeout is deliberately short; the sweep runs every 5s
  const red = new MiniRed({ timeout: 0.05 })
  const inject = red.node('n1', 'inject')
  const stuck = red.node('n2', 'function', { name: 'never completes' })
  red.wire(inject, [stuck])
  red.on(stuck, () => { /* neither sends nor reports completion */ })

  red.send(inject, { payload: 1 })
  red.run()
  await sleep(5300)
  const spans = await red.stop()

  const stuckSpan = byName(spans, 'never completes')[0]
  assert.ok(stuckSpan, 'the unfinished span must be exported instead of dropped')
  assert.equal(stuckSpan.attributes['node_red.span.incomplete'], true)
  const root = rootOf(spans)
  assert.equal(root.attributes['node_red.span.incomplete'], true)
  assert.equal(traceIdsOf(spans).size, 1)
})

test('a second OpenTelemetry node stays inactive instead of failing the deploy', async () => {
  const red = new MiniRed()
  // adding the node to another flow used to throw "Hook onSend.otel already registered",
  // which fails the deploy of that flow
  const second = red.addOtelNode({ rootPrefix: 'Clobbered ' }, 'otel-node-2')

  assert.deepEqual(second.statuses.at(-1), { fill: 'grey', shape: 'ring', text: 'inactive, another OTEL node is active' })
  assert.match(second.warnings.at(-1), /already handled by node "otel-node-1"/)

  // the node that owns the hooks keeps tracing, with its own settings
  const inject = red.node('n1', 'inject')
  const change = red.node('n2', 'change')
  red.wire(inject, [change])
  red.send(inject, { payload: 1 })
  red.run()
  const spans = await red.stop()

  assert.equal(traceIdsOf(spans).size, 1)
  assert.equal(byName(spans, 'change').length, 1)
  assert.equal(rootOf(spans).name, 'Message inject', 'the inactive node must not override the active settings')
})

test('a session looping over two messages is one trace with a span per iteration', async () => {
  const red = new MiniRed()
  const inject = red.node('n1', 'inject', { name: 'start session' })
  const start = red.node('n2', 'function', { name: 'start session' })
  const split = red.node('n3', 'split', { name: '2 messages' })
  const work = red.node('n4', 'function', { name: 'process attempt' })
  const more = red.node('n5', 'switch', { name: 'more attempts?' })
  const join = red.node('n6', 'join', { name: 'session results' })
  const debug = red.node('n7', 'debug', { name: 'session done' })
  red.wire(inject, [start])
  red.wire(start, [split])
  red.wire(split, [work])
  red.wire(work, [more])
  // two output ports: back to the worker, or on to the join
  red.wire(more, [[work], [join]])
  red.wire(join, [debug])

  // a brand new object, so Node-RED mints a fresh _msgid for the session
  red.on(start, (msg, send, done) => {
    send({ sessionId: 'S-test', payload: [{ item: 'alpha' }, { item: 'beta' }] })
    done()
  })
  red.on(split, (msg, send, done) => {
    for (const item of msg.payload) {
      send({ sessionId: msg.sessionId, payload: item })
    }
    done()
  })
  red.on(work, (msg, send, done) => {
    const item = msg.payload.item
    msg.attempts = (msg.attempts || 0) + 1
    msg.payload = { session: msg.sessionId, item, attempt: msg.attempts }
    send(msg)
    done()
  })
  red.on(more, (msg, send, done) => {
    // attempts < 3 loops back on port 0, otherwise leaves on port 1
    send(msg.attempts < 3 ? [msg, null] : [null, msg])
    done()
  })
  const collected = []
  red.on(join, (msg, send, done) => {
    collected.push(msg)
    if (collected.length === 2) {
      send({ sessionId: msg.payload.session, payload: collected.map((m) => m.payload) })
    }
    done()
  })

  red.send(inject, { payload: 1 })
  red.run()
  const spans = await red.stop()

  assert.equal(traceIdsOf(spans).size, 1, 'the whole session must be one trace')
  const root = rootOf(spans)
  assert.equal(byName(spans, 'process attempt').length, 6, '2 messages x 3 attempts, one span each')
  assert.equal(byName(spans, 'more attempts?').length, 6, 'the switch node is entered once per iteration')
  assert.equal(byName(spans, '2 messages').length, 1)
  assert.equal(byName(spans, 'session results').length, 2, 'one span per message reaching the join')
  for (const span of spans.filter((span) => span !== root)) {
    assert.equal(parentSpanIdOf(span), root.spanContext().spanId)
    assert.equal(span.attributes['node_red.run.id'], root.attributes['node_red.run.id'])
  }
  // nothing may be left flagged as unfinished
  assert.equal(spans.filter((span) => span.attributes['node_red.span.incomplete']).length, 0)
})

test('a thrown error keeps its message on the span and marks the run', async () => {
  const red = new MiniRed()
  const inject = red.node('n1', 'inject')
  const work = red.node('n2', 'function', { name: 'process attempt' })
  red.wire(inject, [work])
  red.on(work, () => {
    throw new Error('still failing after 3 attempts')
  })

  red.send(inject, { payload: 1 })
  red.run()
  const spans = await red.stop()

  assert.equal(traceIdsOf(spans).size, 1)
  const workSpan = byName(spans, 'process attempt')[0]
  assert.equal(workSpan.status.code, 2)
  // the SDK drops a status message that is not a string, so an Error must be unwrapped
  assert.equal(workSpan.status.message, 'still failing after 3 attempts')
  assert.equal(workSpan.events.at(-1)?.name, 'exception')
  assert.equal(rootOf(spans).status.code, 2, 'the run must be marked failed')
})

test('a session where one message is retried and another gives up is still one trace', async () => {
  const red = new MiniRed()
  const inject = red.node('n1', 'inject')
  const start = red.node('n2', 'function', { name: 'build session' })
  const split = red.node('n3', 'split', { name: 'fan out items' })
  const work = red.node('n4', 'function', { name: 'process attempt' })
  const outcome = red.node('n5', 'switch', { name: 'outcome?' })
  const done = red.node('n6', 'debug', { name: 'item done' })
  red.wire(inject, [start])
  red.wire(start, [split])
  red.wire(split, [work])
  red.wire(work, [outcome])
  red.wire(outcome, [[work], [done]])

  red.on(start, (msg, send, cb) => {
    send({ sessionId: 'S-test', payload: [{ item: 'alpha' }, { item: 'beta' }] })
    cb()
  })
  red.on(split, (msg, send, cb) => {
    for (const item of msg.payload) {
      send({ sessionId: msg.sessionId, payload: item })
    }
    cb()
  })
  // scripted instead of random: alpha fails once then succeeds, beta never succeeds
  const MAX_ATTEMPTS = 3
  red.on(work, (msg, send, cb) => {
    const item = msg.payload.item
    msg.attempts = (msg.attempts || 0) + 1
    const succeeds = item === 'alpha' && msg.attempts === 2
    if (succeeds) {
      msg.outcome = 'ok'
      msg.payload = { item, attempt: msg.attempts }
      send(msg)
      return cb()
    }
    if (msg.attempts >= MAX_ATTEMPTS) {
      throw new Error(`${item} still failing after ${msg.attempts} attempts`)
    }
    msg.outcome = 'retry'
    msg.payload = { item, attempt: msg.attempts }
    send(msg)
    cb()
  })
  red.on(outcome, (msg, send, cb) => {
    send(msg.outcome === 'retry' ? [msg, null] : [null, msg])
    cb()
  })

  red.send(inject, { payload: 1 })
  red.run()
  const spans = await red.stop()

  assert.equal(traceIdsOf(spans).size, 1, 'a partly failed session is still one trace')
  const root = rootOf(spans)
  // alpha: 2 attempts then ok. beta: 3 attempts, the last one throws
  assert.equal(byName(spans, 'process attempt').length, 5)
  const failed = byName(spans, 'process attempt').filter((span) => span.status.code === 2)
  assert.equal(failed.length, 1, 'only the attempt that gave up is an error')
  assert.match(failed[0].status.message, /beta still failing after 3 attempts/)
  assert.equal(root.status.code, 2, 'one failed message fails the run')
  // the successful message must not be left hanging by the failure of the other
  assert.equal(spans.filter((span) => span.attributes['node_red.span.incomplete']).length, 0)
  for (const span of spans.filter((span) => span !== root)) {
    assert.equal(parentSpanIdOf(span), root.spanContext().spanId)
  }
})

test('custom attributes are evaluated per loop iteration', async () => {
  const red = new MiniRed({
    attributeMappings: [
      // the file being worked on is set before the loop, so it is there at span start
      { isAfter: false, flow: '', nodeType: 'function', key: 'node_red.file.name', path: 'filename' },
      // the attempt number is set by the node itself, so only the end of the span sees it
      { isAfter: true, flow: '', nodeType: 'function', key: 'node_red.attempt', path: 'attempts' },
      // the same value read at span start instead, to pin down what that gives
      { isAfter: false, flow: '', nodeType: 'function', key: 'node_red.attempt.at.start', path: 'attempts' },
    ],
  })
  const inject = red.node('n1', 'inject')
  const work = red.node('n2', 'function', { name: 'process attempt' })
  const outcome = red.node('n3', 'switch', { name: 'outcome?' })
  const done = red.node('n4', 'debug')
  red.wire(inject, [work])
  red.wire(work, [outcome])
  red.wire(outcome, [[work], [done]])

  red.on(work, (msg, send, cb) => {
    msg.attempts = (msg.attempts || 0) + 1
    msg.outcome = msg.attempts < 3 ? 'retry' : 'ok'
    send(msg)
    cb()
  })
  red.on(outcome, (msg, send, cb) => {
    send(msg.outcome === 'retry' ? [msg, null] : [null, msg])
    cb()
  })

  // the filename arrives with the message, as a split node would hand it over
  red.send(inject, { payload: 1, filename: 'orders-2026-07-30.csv' })
  red.run()
  const spans = await red.stop()

  const attempts = byName(spans, 'process attempt')
  assert.equal(attempts.length, 3, 'one span per iteration')

  // an attribute set before the loop is on every iteration
  for (const span of attempts) {
    assert.equal(span.attributes['node_red.file.name'], 'orders-2026-07-30.csv')
  }
  // read at the end of the span, the attempt number is that of the iteration
  assert.deepEqual(attempts.map((span) => span.attributes['node_red.attempt']), [1, 2, 3])
  // read at the start it is whatever the previous iteration left behind, hence off by one:
  // the first has no value at all, since the node had not counted anything yet
  assert.deepEqual(attempts.map((span) => span.attributes['node_red.attempt.at.start']), [undefined, 1, 2])
})

test('the documented attribute mappings carry per attempt values through a retry loop', async () => {
  // exactly the rows the example flow documents
  const red = new MiniRed({
    attributeMappings: [
      // a plain top level property, which the example flow lifts the filename onto before the
      // loop, and the same value read out of the payload the worker rewrites each iteration
      { isAfter: false, flow: '', nodeType: '', key: 'node_red.file.name', path: 'filename' },
      { isAfter: false, flow: '', nodeType: 'function', key: 'node_red.file.from.payload', path: 'payload.filename' },
      { isAfter: true, flow: '', nodeType: 'function', key: 'node_red.attempt', path: 'attempts' },
      { isAfter: true, flow: '', nodeType: 'function', key: 'node_red.outcome', path: 'outcome' },
      { isAfter: true, flow: '', nodeType: 'function', key: 'node_red.error.reason', path: 'lastError' },
      // Start, not End: a switch span is closed on dispatch rather than on completion, so End
      // mappings never reach it
      { isAfter: false, flow: '', nodeType: '', key: 'node_red.session.id', path: 'sessionId' },
      { isAfter: true, flow: '', nodeType: '', key: 'node_red.session.at.end', path: 'sessionId' },
    ],
  })
  const inject = red.node('n1', 'inject')
  const split = red.node('n2', 'split', { name: 'fan out items' })
  const work = red.node('n3', 'function', { name: 'process attempt' })
  const outcome = red.node('n4', 'switch', { name: 'outcome?' })
  const done = red.node('n5', 'debug')
  red.wire(inject, [split])
  red.wire(split, [work])
  red.wire(work, [outcome])
  red.wire(outcome, [[work], [done]])

  red.on(split, (msg, send, cb) => {
    send({ sessionId: 'S-test', filename: 'orders-2026-07-30.csv', payload: { filename: 'orders-2026-07-30.csv' } })
    cb()
  })
  // as the flow's worker does: fail twice, then succeed on the third attempt
  red.on(work, (msg, send, cb) => {
    const source = msg.payload
    const filename = source.filename
    msg.attempts = (msg.attempts || 0) + 1
    const progress = { session: msg.sessionId, filename, attempt: msg.attempts }
    if (msg.attempts >= 3) {
      msg.outcome = 'ok'
      delete msg.lastError
      msg.payload = { ...progress, outcome: 'ok' }
    } else {
      msg.outcome = 'retry'
      msg.lastError = `${filename} failed on attempt ${msg.attempts}`
      msg.payload = { ...progress, outcome: 'retry' }
    }
    send(msg)
    cb()
  })
  red.on(outcome, (msg, send, cb) => {
    send(msg.outcome === 'retry' ? [msg, null] : [null, msg])
    cb()
  })

  red.send(inject, { payload: 1 })
  red.run()
  const spans = await red.stop()

  const attempts = byName(spans, 'process attempt')
  assert.equal(attempts.length, 3)
  // a top level property survives every iteration whatever the worker does to the payload
  assert.deepEqual(attempts.map((s) => s.attributes['node_red.file.name']),
    ['orders-2026-07-30.csv', 'orders-2026-07-30.csv', 'orders-2026-07-30.csv'])
  // reading out of the payload works too, but only while the worker keeps putting it back
  assert.deepEqual(attempts.map((s) => s.attributes['node_red.file.from.payload']),
    ['orders-2026-07-30.csv', 'orders-2026-07-30.csv', 'orders-2026-07-30.csv'])
  // a mapping with no node type also reaches the switch spans, which End would miss
  assert.equal(byName(spans, 'outcome?')[0].attributes['node_red.file.name'], 'orders-2026-07-30.csv')
  assert.deepEqual(attempts.map((s) => s.attributes['node_red.attempt']), [1, 2, 3])
  assert.deepEqual(attempts.map((s) => s.attributes['node_red.outcome']), ['retry', 'retry', 'ok'])
  // the reason is only there for the attempts that failed
  assert.deepEqual(attempts.map((s) => s.attributes['node_red.error.reason']), [
    'orders-2026-07-30.csv failed on attempt 1',
    'orders-2026-07-30.csv failed on attempt 2',
    undefined,
  ])
  // a mapping without a node type reaches every traced node
  assert.deepEqual(attempts.map((s) => s.attributes['node_red.session.id']), ['S-test', 'S-test', 'S-test'])
  assert.equal(byName(spans, 'outcome?')[0].attributes['node_red.session.id'], 'S-test')
  // the switch span is closed when the message is dispatched rather than on completion, so an
  // End mapping does not reach it, while it does reach a node that reports completion
  assert.equal(byName(spans, 'outcome?')[0].attributes['node_red.session.at.end'], undefined)
  assert.equal(attempts[0].attributes['node_red.session.at.end'], 'S-test')
  // but never the run span: mappings only land on the node spans below it
  assert.equal(rootOf(spans).attributes['node_red.session.id'], undefined)
})

test('the run span records what triggered the run', async () => {
  const red = new MiniRed()
  const httpIn = red.node('n1', 'http in', { url: '/trigger', method: 'get' })
  const fn = red.node('n2', 'function', { name: 'work' })
  const httpResponse = red.node('n3', 'http response')
  red.wire(httpIn, [fn])
  red.wire(fn, [httpResponse])
  red.on(httpResponse, (msg, send, done) => done())

  red.send(httpIn, { payload: '', req: { ip: '127.0.0.1', headers: {} }, res: { _res: { statusCode: 200 } } })
  red.run()
  const spans = await red.stop()

  const root = rootOf(spans)
  assert.equal(root.attributes['node_red.trigger.type'], 'http in')
  // only the run span carries it: on a node span the type is already node_red.node.type, and
  // "what triggered the run" would be wrong there
  for (const span of spans.filter((span) => span !== root)) {
    assert.equal(span.attributes['node_red.trigger.type'], undefined, `${span.name} must not claim to be the trigger`)
  }
  assert.equal(byName(spans, 'work')[0].attributes['node_red.node.type'], 'function')
})

test('an inject started run is labelled by its own trigger type', async () => {
  const red = new MiniRed()
  const inject = red.node('n1', 'inject')
  const change = red.node('n2', 'change')
  red.wire(inject, [change])

  red.send(inject, { payload: 1 })
  red.run()
  const spans = await red.stop()

  assert.equal(rootOf(spans).attributes['node_red.trigger.type'], 'inject')
})
