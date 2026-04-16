// @ts-nocheck
const Module = require("node:module");
const path = require("node:path");

const stubPath = path.join(process.cwd(), "test", "stubs", "node-red-util.cjs");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
	if (request === "@node-red/util") {
		return stubPath;
	}
	return originalResolveFilename.call(this, request, parent, isMain, options);
};

const test = require("node:test");
const assert = require("node:assert/strict");
const otelModule = require("../src/nodes/opentelemetry");
Module._resolveFilename = originalResolveFilename;

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test("OpenTelemetry config node contention: nodes share state and hooks are reference counted", async () => {
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

	let close1: any, close2: any;
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
		tracesEnabled: true,
		metricsEnabled: false,
		logsEnabled: false,
		logLevel: "debug",
		timeout: 10,
	});
	await nextTick();

	// Verify first config node registered hooks and providers
	assert.equal(sharedState.refCount, 0);
	assert.equal(hooksAdded, 6); // onSend, preDeliver, postDeliver, postReceive, onReceive, onComplete
	assert.equal(sharedState.logLevel, "debug");
	assert.ok(sharedState.provider);
	assert.equal(sharedState.meterProvider, null);
	assert.equal(sharedState.loggerProvider, null);

	OpenTelemetry.call(node2, {
		url: "http://localhost:4318/v1/traces",
		logLevel: "warn",
		timeout: 20,
	});
	await nextTick();

	// Hooks are not added again and latest config wins globally
	assert.equal(sharedState.refCount, 0);
	assert.equal(hooksAdded, 6);
	assert.equal(sharedState.logLevel, "warn");

	await close1.call(node1);
	await nextTick();
	// first close should not tear down global providers while another config node exists
	assert.equal(sharedState.refCount, 0);
	assert.equal(hooksRemoved, 0);
	assert.ok(sharedState.provider);
	assert.equal(sharedState.meterProvider, null);
	assert.equal(sharedState.loggerProvider, null);

	await close2.call(node2);
	await nextTick();
	// hooks and providers are removed when last config node closes
	assert.equal(sharedState.refCount, 0);
	assert.equal(hooksRemoved, 6);
	assert.equal(sharedState.provider, null);
	assert.equal(sharedState.meterProvider, null);
	assert.equal(sharedState.loggerProvider, null);
});

