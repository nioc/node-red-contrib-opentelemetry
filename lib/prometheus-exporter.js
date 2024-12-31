// eslint-disable-next-line node/no-missing-require
const { log: logger } = require('@node-red/util')
const { hostname } = require('os')
const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus')
const { MeterProvider, View, ExplicitBucketHistogramAggregation } = require('@opentelemetry/sdk-metrics')
const { Resource } = require('@opentelemetry/resources')
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions')
const onFinished = require('on-finished')

/**
 * @type {PrometheusExporter}
 */
let exporter

/**
 * @type {Histogram<Attributes>}
 */
let requestDurationHistogram

function startHttpInExporter (port, endpoint, instrumentName, serviceName = 'Node-RED') {
  return new Promise((resolve, reject) => {
    exporter = new PrometheusExporter({
      startServer: true,
      port,
      endpoint,
    }, (error) => {
      if (error) {
        logger.log({ level: logger.ERROR, msg: `Prometheus exporter startup failed: ${error.message}` })
        exporter = undefined
        requestDurationHistogram = undefined
        return reject(error)
      }
      logger.log({ level: logger.INFO, msg: `Prometheus scraping endpoint added: http://${hostname()}:${port}${endpoint}` })

      const meterProvider = new MeterProvider({
        views: [
          new View({
            aggregation: new ExplicitBucketHistogramAggregation([0, 25, 50, 75, 100, 250, 500, 1000, 2000]),
            instrumentName,
          }),
        ],
        readers: [exporter],
        resource: new Resource({
          [ATTR_SERVICE_NAME]: serviceName,
        }),
      })

      const meter = meterProvider.getMeter('prometheus')
      requestDurationHistogram = meter.createHistogram(instrumentName, {
        description: 'Response time for incoming http requests in milliseconds',
        unit: 'ms',
      })
      resolve()
    })
  })
}

async function stopHttpInExporter (port, endpoint) {
  if (exporter) {
    await exporter.shutdown()
    exporter = undefined
    requestDurationHistogram = undefined
    logger.log({ level: logger.INFO, msg: `Prometheus scraping endpoint removed: http://${hostname()}:${port}${endpoint}` })
  }
}

async function prometheusMiddleware (req, res, next) {
  if (requestDurationHistogram !== undefined) {
    req.startTimestamp = Date.now()
    onFinished(res, function (_err, res) {
      const { method, path: route, ip, startTimestamp } = req
      const { statusCode: status } = res
      const duration = Date.now() - startTimestamp
      const attributes = { method, route, status, ip }
      requestDurationHistogram.record(duration, attributes)
    })
  }
  next()
}

module.exports = {
  startHttpInExporter,
  stopHttpInExporter,
  prometheusMiddleware,
}
