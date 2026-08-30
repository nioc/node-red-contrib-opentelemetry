/**
 * @typedef {import('@types/node-red__registry').NodeAPI} NodeAPI
 * @typedef {import('@types/node-red__registry').Node} Node
 * @typedef {import('@types/node-red__registry').NodeDef} NodeDef
 */

/**
 * @typedef {Object} PrometheusNodeConfig OTEL node credentials
 * @property {string} endpoint Prometheus scraping endpoint
 * @property {number} port Prometheus scraping port
 * @property {string} serviceName Prometheus service name
 * @property {string} instrumentName Prometheus instrument name
 */

/**
 * Prometheus node definition, including configuration
 * @typedef {NodeDef & PrometheusNodeConfig} PrometheusNodeDef
 */

const { startHttpInExporter, stopHttpInExporter } = require('./prometheus-exporter')

/**
 * @param {NodeAPI} RED Runtime API provided to nodes by Node Registry
 */
module.exports = function (RED) {
  'use strict'
  /**
   * @this {Node}
   * @param {PrometheusNodeDef} config OTEL node definition, including configuration
   */
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
