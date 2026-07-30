/**
 * Exporter authentication, checked against a real OTLP request.
 *
 * The exporter is the real one here, so the assertions are on the headers a collector actually
 * receives rather than on how the node was configured.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const DEFAULT_CONFIG = {
  protocol: 'http',
  serviceName: 'test',
  rootPrefix: 'Message ',
  ignoredTypes: 'debug,catch',
  propagateHeadersTypes: '',
  isLogging: false,
  timeout: 10,
  attributeMappings: [],
  authScheme: 'none',
  authHeaderName: '',
  headers: [],
}

let messageCounter = 0

/** A collector recording what it receives */
function startCollector () {
  const requests = []
  let notify = null
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      requests.push({ headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      if (notify) {
        const resolve = notify
        notify = null
        resolve()
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1/traces`,
        requests,
        /** Resolves once one export request has been handled */
        received: () => new Promise((resolve) => { notify = resolve }),
        close: () => new Promise((resolve) => server.close(resolve)),
      })
    })
  })
}

/**
 * Instantiate the OpenTelemetry node against a stubbed Node-RED runtime
 * @param {object} config Configuration overrides
 * @param {object} [credentials] Node credentials
 */
function startNode (config, credentials = {}) {
  const hooks = {}
  const warnings = []
  let closeHandler
  let constructNode
  const RED = {
    nodes: {
      createNode: (node) => {
        node.credentials = credentials
        node.status = () => {}
        node.warn = (warning) => warnings.push(warning)
        node.on = (event, callback) => {
          if (event === 'close') {
            closeHandler = callback.bind(node)
          }
        }
      },
      registerType: (_type, constructor) => {
        constructNode = constructor
      },
    },
    hooks: {
      add: (name, handler) => { hooks[name.split('.')[0]] = handler },
      remove: () => {},
    },
  }
  require('../lib/opentelemetry-node')(RED)
  const node = { id: 'otel-node' }
  constructNode.call(node, { ...DEFAULT_CONFIG, ...config })

  return {
    warnings,
    /** Run a message through one node, which produces spans to export */
    trace: () => {
      const msg = { _msgid: `msgid-${++messageCounter}`, payload: 1 }
      const traced = { id: 'traced-node', type: 'inject', name: '', z: 'flow-1' }
      hooks.onSend([{ msg, source: { id: traced.id, node: traced, port: 0 }, destination: { id: 'next', node: undefined } }])
      hooks.onComplete({ msg, error: undefined, node: { id: traced.id, node: traced } })
    },
    /** Shutting the node down flushes the span processor */
    stop: () => closeHandler(),
  }
}

/**
 * Export one span and return the headers the collector saw
 * @param {object} config Configuration overrides
 * @param {object} [credentials] Node credentials
 */
async function exportedHeaders (config, credentials) {
  const collector = await startCollector()
  const node = startNode({ ...config, url: collector.url }, credentials)
  node.trace()
  const received = collector.received()
  await node.stop()
  await received
  await collector.close()
  assert.equal(collector.requests.length, 1, 'the collector must have received one export request')
  return { headers: collector.requests[0].headers, warnings: node.warnings }
}

test('no authentication sends no authorization header', async () => {
  const { headers } = await exportedHeaders({ authScheme: 'none' })
  assert.equal(headers.authorization, undefined)
})

test('a bearer token is sent as an authorization header', async () => {
  const { headers } = await exportedHeaders({ authScheme: 'bearer' }, { token: 'sekret-token' })
  assert.equal(headers.authorization, 'Bearer sekret-token')
})

test('basic credentials are sent base64 encoded', async () => {
  const { headers } = await exportedHeaders({ authScheme: 'basic' }, { username: 'root@example.com', password: 'pa:ss word' })
  assert.equal(headers.authorization, `Basic ${Buffer.from('root@example.com:pa:ss word').toString('base64')}`)
})

test('a custom header carries the secret under the configured name', async () => {
  const { headers } = await exportedHeaders({ authScheme: 'header', authHeaderName: 'x-api-key' }, { token: 'abc123' })
  assert.equal(headers['x-api-key'], 'abc123')
  assert.equal(headers.authorization, undefined)
})

test('additional headers are sent alongside the authentication', async () => {
  const { headers } = await exportedHeaders({
    authScheme: 'bearer',
    headers: [{ key: 'x-dataset', value: 'production' }, { key: 'x-tenant', value: 'acme' }],
  }, { token: 'tok' })
  assert.equal(headers.authorization, 'Bearer tok')
  assert.equal(headers['x-dataset'], 'production')
  assert.equal(headers['x-tenant'], 'acme')
})

test('an incomplete authentication configuration warns instead of sending a broken header', async () => {
  const { headers, warnings } = await exportedHeaders({ authScheme: 'bearer' }, {})
  assert.equal(headers.authorization, undefined, 'no header rather than "Bearer undefined"')
  assert.match(warnings.join(' '), /no token is set/)
})

test('a header name without a value warns instead of sending it', async () => {
  const { headers, warnings } = await exportedHeaders({ authScheme: 'header', authHeaderName: 'x-api-key' }, {})
  assert.equal(headers['x-api-key'], undefined)
  assert.match(warnings.join(' '), /header name or its value is missing/)
})

test('a local collector over plain http is not warned about', async () => {
  // the collector in these tests is on 127.0.0.1, which is exempt
  const { warnings } = await exportedHeaders({ authScheme: 'bearer' }, { token: 'tok' })
  assert.deepEqual(warnings, [])
})

test('credentials sent over plain http to a remote collector are warned about', async () => {
  // no span is exported here, so nothing leaves the machine: the warning is raised on startup
  const node = startNode({ url: 'http://collector.example.com:4318/v1/traces', authScheme: 'bearer' }, { token: 'tok' })
  assert.match(node.warnings.join(' '), /sent over plain http/)
  await node.stop()
})

test('no warning is raised over https, nor without credentials', async () => {
  const secure = startNode({ url: 'https://collector.example.com/v1/traces', authScheme: 'bearer' }, { token: 'tok' })
  assert.deepEqual(secure.warnings, [])
  await secure.stop()

  const anonymous = startNode({ url: 'http://collector.example.com/v1/traces', authScheme: 'none' })
  assert.deepEqual(anonymous.warnings, [])
  await anonymous.stop()
})
