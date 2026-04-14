const { log: logger } = require("@node-red/util");
const { hostname } = require("os");
const { PrometheusExporter } = require("@opentelemetry/exporter-prometheus");
const {
	MeterProvider,
	View,
	ExplicitBucketHistogramAggregation,
} = require("@opentelemetry/sdk-metrics");
const { Resource } = require("@opentelemetry/resources");
const { ATTR_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");
const onFinished = require("on-finished");

const defaultDependencies = {
	PrometheusExporter,
	MeterProvider,
	View,
	ExplicitBucketHistogramAggregation,
	Resource,
	onFinished,
};

let dependencies = { ...defaultDependencies };

/**
 * @type {Map<string, {exporter: PrometheusExporter, requestDurationHistogram: any, refCount: number}>}
 */
const exporters = new Map();

function getExporterKey(port, endpoint) {
	return `${port}${endpoint}`;
}

function startHttpInExporter(
	port,
	endpoint,
	instrumentName,
	serviceName = "Node-RED",
) {
	const key = getExporterKey(port, endpoint);
	if (exporters.has(key)) {
		const entry = exporters.get(key);
		entry.refCount++;
		return Promise.resolve();
	}

	return new Promise((resolve, reject) => {
		const Exporter = dependencies.PrometheusExporter;
		const exporter = new Exporter(
			{
				startServer: true,
				port,
				endpoint,
			},
			(error) => {
				if (error) {
					logger.log({
						level: logger.ERROR,
						msg: `Prometheus exporter startup failed: ${error.message}`,
					});
					return reject(error);
				}
				logger.log({
					level: logger.INFO,
					msg: `Prometheus scraping endpoint added: http://${hostname()}:${port}${endpoint}`,
				});

				const MeterProviderImpl = dependencies.MeterProvider;
				const ViewImpl = dependencies.View;
				const ExplicitBucketHistogramAggregationImpl =
					dependencies.ExplicitBucketHistogramAggregation;
				const ResourceImpl = dependencies.Resource;
				const meterProvider = new MeterProviderImpl({
					views: [
						new ViewImpl({
							aggregation: new ExplicitBucketHistogramAggregationImpl([
								0, 25, 50, 75, 100, 250, 500, 1000, 2000,
							]),
							instrumentName,
						}),
					],
					readers: [exporter],
					resource: new ResourceImpl({
						[ATTR_SERVICE_NAME]: serviceName,
					}),
				});

				const meter = meterProvider.getMeter("prometheus");
				const requestDurationHistogram = meter.createHistogram(instrumentName, {
					description:
						"Response time for incoming http requests in milliseconds",
					unit: "ms",
				});

				exporters.set(key, {
					exporter,
					requestDurationHistogram,
					refCount: 1,
				});
				resolve();
			},
		);
	});
}

async function stopHttpInExporter(port, endpoint) {
	const key = getExporterKey(port, endpoint);
	const entry = exporters.get(key);
	if (entry) {
		entry.refCount--;
		if (entry.refCount <= 0) {
			await entry.exporter.shutdown();
			exporters.delete(key);
			logger.log({
				level: logger.INFO,
				msg: `Prometheus scraping endpoint removed: http://${hostname()}:${port}${endpoint}`,
			});
		}
	}
}

async function prometheusMiddleware(req, res, next) {
	const activeExporters = Array.from(exporters.values()).filter(
		(e) => e.requestDurationHistogram,
	);
	if (activeExporters.length > 0) {
		req.startTimestamp = Date.now();
		dependencies.onFinished(res, function (_err, res) {
			const { method, path: route, ip, startTimestamp } = req;
			const { statusCode: status } = res;
			const duration = Date.now() - startTimestamp;
			const attributes = { method, route, status, ip };
			for (const entry of activeExporters) {
				entry.requestDurationHistogram.record(duration, attributes);
			}
		});
	}
	next();
}

module.exports = {
	startHttpInExporter,
	stopHttpInExporter,
	prometheusMiddleware,
	__test__: {
		resetState: () => {
			exporters.clear();
		},
		getState: () => {
			if (exporters.size === 0) return { exporter: undefined, requestDurationHistogram: undefined };
			const first = exporters.values().next().value;
			return { exporter: first.exporter, requestDurationHistogram: first.requestDurationHistogram };
		},
		getExporters: () => exporters,
		setRequestDurationHistogram: (histogram) => {
			if (exporters.size > 0) {
				const first = exporters.values().next().value;
				first.requestDurationHistogram = histogram;
			} else {
				exporters.set("test", { requestDurationHistogram: histogram, refCount: 1 });
			}
		},
		setDependencies: (overrides) => {
			dependencies = { ...dependencies, ...overrides };
		},
		resetDependencies: () => {
			dependencies = { ...defaultDependencies };
		},
	},
};
