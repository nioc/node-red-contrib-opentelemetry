const Module = require("node:module");
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
const otelModule = require("../dist/opentelemetry-node");
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
			registerType: (name, nodeCtor) => {
				mockRed.nodes[name] = nodeCtor;
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
		plugins: {
			registerRuntimePlugin: () => {},
		},
	};

	otelModule(mockRed);
	const OpenTelemetry = mockRed.nodes.OpenTelemetry;

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
		metricsUrl: "http://localhost:4318/v1/metrics",
		logsUrl: "http://localhost:4318/v1/logs",
		tracesEnabled: true,
		metricsEnabled: true,
		logsEnabled: true,
		isLogging: true,
		timeout: 10,
	});

	// Verify first node registered hooks and providers
	assert.equal(sharedState.refCount, 1);
	assert.equal(hooksAdded, 6); // onSend, preDeliver, postDeliver, postReceive, onReceive, onComplete
	assert.equal(sharedState.isLogging, true);
	assert.ok(sharedState.provider);
	assert.ok(sharedState.meterProvider);
	assert.ok(sharedState.loggerProvider);

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
	assert.equal(sharedState.provider, null);
	assert.equal(sharedState.meterProvider, null);
	assert.equal(sharedState.loggerProvider, null);
});
