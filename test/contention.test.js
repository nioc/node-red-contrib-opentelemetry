const Module = require("module");
const path = require("node:path");

const stubPath = path.join(__dirname, "stubs", "node-red-util.cjs");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
	if (request === "@node-red/util") {
		return stubPath;
	}
	return originalResolveFilename.call(this, request, parent, isMain, options);
};

const test = require("node:test");
const assert = require("node:assert/strict");
const otelModule = require("../lib/opentelemetry-node");
const exporterModule = require("../lib/prometheus-exporter");
Module._resolveFilename = originalResolveFilename;

test("OpenTelemetry node contention: nodes share state and hooks are reference counted", async () => {
	otelModule.__test__.resetState();
	const sharedState = otelModule.__test__.getSharedState();
	assert.equal(sharedState.refCount, 0);

	let hooksAdded = 0;
	let hooksRemoved = 0;
	const mockRed = {
		nodes: {
			createNode: (node, config) => {
				Object.assign(node, config);
			},
			registerType: (name, constructor) => {
				mockRed.nodes[name] = constructor;
			},
		},
		hooks: {
			add: () => {
				hooksAdded++;
			},
			remove: () => {
				hooksRemoved++;
			},
		},
	};

	otelModule(mockRed);
	const OpenTelemetry = mockRed.nodes["OpenTelemetry"];

	let close1, close2;
	const node1 = {
		on: (ev, cb) => {
			if (ev === "close") close1 = cb;
		},
		status: () => {},
	};
	const node2 = {
		on: (ev, cb) => {
			if (ev === "close") close2 = cb;
		},
		status: () => {},
	};

	OpenTelemetry.call(node1, {
		url: "http://localhost:4318/v1/traces",
		isLogging: true,
		timeout: 10,
	});

	// Verify first node registered hooks
	assert.equal(sharedState.refCount, 1);
	assert.equal(hooksAdded, 6); // onSend, preDeliver, postDeliver, postReceive, onReceive, onComplete
	assert.equal(sharedState.isLogging, true);

	OpenTelemetry.call(node2, {
		url: "http://localhost:4318/v1/traces",
		isLogging: false,
		timeout: 20,
	});

	// FIXED: Hooks NOT added again
	assert.equal(sharedState.refCount, 2);
	assert.equal(hooksAdded, 6);
	// FIXED: Latest config wins (expected behavior for global features)
	assert.equal(sharedState.isLogging, false);

	await close1.call(node1);
	// FIXED: Hooks NOT removed yet
	assert.equal(sharedState.refCount, 1);
	assert.equal(hooksRemoved, 0);

	await close2.call(node2);
	// FIXED: Hooks finally removed
	assert.equal(sharedState.refCount, 0);
	assert.equal(hooksRemoved, 1);
});

test("Prometheus exporter contention: multiple nodes on same port share exporter", async () => {
	exporterModule.__test__.resetState();
	const state = exporterModule.__test__.getState();
	assert.equal(state.exporter, undefined);

	// Mocking dependencies to avoid actual server start
	exporterModule.__test__.setDependencies({
		PrometheusExporter: class {
			constructor(opts, cb) {
				this.opts = opts;
				this.shutdownCalled = false;
				setImmediate(() => cb(null));
			}
			async shutdown() {
				this.shutdownCalled = true;
			}
		},
		MeterProvider: class {
			getMeter() {
				return { createHistogram: () => ({ record: () => {} }) };
			}
		},
		View: class {},
		ExplicitBucketHistogramAggregation: class {},
		Resource: class {},
	});

	await exporterModule.startHttpInExporter(9090, "/metrics", "h1");
	const exporter1 = exporterModule.__test__.getExporters().get("9090/metrics")
		.exporter;
	assert.equal(
		exporterModule.__test__.getExporters().get("9090/metrics").refCount,
		1,
	);

	await exporterModule.startHttpInExporter(9090, "/metrics", "h2");
	const exporter2 = exporterModule.__test__.getExporters().get("9090/metrics")
		.exporter;

	// FIXED: They share the same exporter instance
	assert.equal(exporter1, exporter2);
	assert.equal(
		exporterModule.__test__.getExporters().get("9090/metrics").refCount,
		2,
	);

	await exporterModule.stopHttpInExporter(9090, "/metrics");
	// FIXED: Exporter still active because refCount is 1
	assert.equal(
		exporterModule.__test__.getExporters().get("9090/metrics").refCount,
		1,
	);
	assert.equal(exporter1.shutdownCalled, false);

	await exporterModule.stopHttpInExporter(9090, "/metrics");
	// FIXED: Exporter finally shut down
	assert.equal(
		exporterModule.__test__.getExporters().has("9090/metrics"),
		false,
	);
	assert.equal(exporter1.shutdownCalled, true);
});
