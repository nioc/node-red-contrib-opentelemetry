/**
 * The edit dialog, exercised against stubs for jQuery and the Node-RED editor.
 *
 * `oneditprepare` builds two editable lists. If it throws part way through, every list after
 * the failure is left uninitialised and the dialog silently loses those sections, so what
 * matters here is that it survives a node whose newer properties are missing: the editor only
 * fills defaults in on import, not when loading the flows it already has
 * (`applyNodeDefaults` defaults to false).
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/** Load the editor script out of the node's html file and return the registered definition */
function loadNodeDefinition () {
  const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'opentelemetry-node.html'), 'utf8')
  const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(script, 'the html must hold an editor script')

  const registered = {}
  const initialised = []
  // the selector is kept out of the proxy, whose get trap would turn it back into a function
  let currentSelector = null
  const chain = new Proxy({}, {
    get (_target, property) {
      return (...args) => {
        if (property === 'editableList' && typeof args[0] === 'object') {
          // the list is being set up, rather than being appended to
          initialised.push(currentSelector)
        }
        if (property === 'val') {
          return 'none'
        }
        if (property === 'items') {
          return { each: () => chain }
        }
        return chain
      }
    },
  })
  const $ = (selector) => {
    currentSelector = selector
    return chain
  }
  const sandbox = {
    // eslint-disable-next-line security/detect-object-injection
    RED: { nodes: { registerType: (type, definition) => { registered[type] = definition } } },
    $,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(script[1], sandbox)
  return { definition: registered.OpenTelemetry, initialised }
}

test('the edit dialog builds both lists for a node that has every property', () => {
  const { definition, initialised } = loadNodeDefinition()
  definition.oneditprepare.call({ headers: [{ key: 'x-tenant', value: 'acme' }], attributeMappings: [] })
  assert.ok(initialised.includes('#node-input-otelHeader-container'))
  assert.ok(initialised.includes('#node-input-otelAttributeMapping-container'))
})

test('the edit dialog survives a node saved before the newer fields existed', () => {
  const { definition, initialised } = loadNodeDefinition()
  // exactly what the editor hands over for a config node stored by an older version
  definition.oneditprepare.call({ headers: undefined, attributeMappings: undefined })
  assert.ok(initialised.includes('#node-input-otelHeader-container'), 'headers list must still be built')
  assert.ok(
    initialised.includes('#node-input-otelAttributeMapping-container'),
    'the span attribute mappings list must still be built: it is set up after the headers one, ' +
    'so anything throwing earlier makes that section disappear from the dialog',
  )
})

test('saving collects both lists without touching the flow', () => {
  const { definition } = loadNodeDefinition()
  const node = {}
  definition.oneditsave.call(node)
  // compared as JSON: arrays built inside the vm realm are not reference-equal to host ones
  assert.equal(JSON.stringify(node.headers), '[]')
  assert.equal(JSON.stringify(node.attributeMappings), '[]')
})
