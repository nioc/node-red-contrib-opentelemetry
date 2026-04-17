// @ts-nocheck
const Module = require("node:module");
const path = require("node:path");

const stubPath = path.join(process.cwd(), "test", "stubs", "node-red-util.cjs");
const exporterStubPath = path.join(process.cwd(), "test", "stubs", "otel-exporters.cjs");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
	if (request === "@node-red/util") {
		return stubPath;
	}
	if (
		typeof request === "string" &&
		request.startsWith("@opentelemetry/exporter-")
	) {
		return exporterStubPath;
	}
	return originalResolveFilename.call(this, request, parent, isMain, options);
};

const test = require("node:test");
const assert = require("node:assert/strict");
const otelModule = require("../src/plugins/opentelemetry-runtime");

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test("OpenTelemetry runtime plugin contention: settings updates reuse hooks and latest config wins", async () => {
	otelModule.__test__.resetState();
	const sharedState = otelModule.__test__.getSharedState();

	let hooksAdded = 0;
	let hooksRemoved = 0;
	let runtimePlugin: any;
	const mockRed = {
		nodes: {
			getNode: () => undefined,
		},
		settings: {},
		hooks: {
			add: () => {
				hooksAdded++;
			},
			remove: () => {
				hooksRemoved++;
			},
		},
		plugins: {
			registerPlugin: (_id, plugin) => {
				runtimePlugin = {
					onSettings: async (settings) => {
						mockRed.settings.opentelemetry =
							(settings && settings.opentelemetry) || settings || {};
						return plugin.onadd?.();
					},
					onClose: async () => plugin.onremove?.(),
				};
			},
		},
	};

	otelModule(mockRed);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
		url: "http://localhost:4318/v1/traces",
		tracesEnabled: true,
		metricsEnabled: false,
		logsEnabled: false,
		logLevel: "debug",
		timeout: 10,
		},
	});
	await nextTick();

	// Verify first plugin settings registration registered hooks and providers
	assert.equal(hooksAdded, 6); // onSend, preDeliver, postDeliver, postReceive, onReceive, onComplete
	assert.equal(sharedState.logLevel, "debug");
	assert.ok(sharedState.provider);
	assert.equal(sharedState.meterProvider, null);
	assert.equal(sharedState.loggerProvider, null);

	await runtimePlugin.onSettings({
		opentelemetry: {
		url: "http://localhost:4318/v1/traces",
		logLevel: "warn",
		timeout: 20,
		},
	});
	await nextTick();

	// Hooks are not added again and latest config wins globally
	assert.equal(hooksAdded, 6);
	assert.equal(sharedState.logLevel, "warn");

	await runtimePlugin.onClose();
	await nextTick();
	// hooks and providers are removed when plugin closes
	assert.equal(hooksRemoved, 6);
	assert.equal(sharedState.provider, null);
	assert.equal(sharedState.meterProvider, null);
	assert.equal(sharedState.loggerProvider, null);
});


