const { startHttpInExporter, stopHttpInExporter } = require('./prometheus-exporter')

module.exports = function (RED) {
  'use strict'

  function PrometheusExporterNode (config) {
    // get config
    RED.nodes.createNode(this, config)
    const { endpoint, port, instrumentName, serviceName } = config
    if (!endpoint || !port || !instrumentName) {
      this.error('Invalid configuration')
      this.status({ fill: 'red', shape: 'ring', text: 'invalid configuration' })
      return
    }

    // add export server
    const node = this
    startHttpInExporter(port, endpoint, instrumentName, serviceName)
      .then(() => node.status({ fill: 'green', shape: 'ring', text: 'activated' }))
      .catch((error) => node.status({ fill: 'red', shape: 'ring', text: error.message }))

    // on node stop, remove export server
    this.on('close', function () {
      stopHttpInExporter(port, endpoint)
      this.status({ fill: 'red', shape: 'ring', text: 'disabled' })
    })
  }

  RED.nodes.registerType('Prometheus Exporter', PrometheusExporterNode)
}
