const {
	startHttpInExporter,
	stopHttpInExporter,
} = require("./prometheus-exporter");

module.exports = function (RED) {
	"use strict";

	async function initPrometheus(config) {
		const { endpoint, port, instrumentName, serviceName } = config;
		if (!endpoint || !port || !instrumentName) {
			return;
		}
		await startHttpInExporter(port, endpoint, instrumentName, serviceName);
	}

	async function closePrometheus(config) {
		const { endpoint, port } = config;
		await stopHttpInExporter(port, endpoint);
	}

	function PrometheusExporterNode(config) {
		// get config
		RED.nodes.createNode(this, config);
		const { endpoint, port, instrumentName } = config;
		if (!endpoint || !port || !instrumentName) {
			this.error("Invalid configuration");
			this.status({
				fill: "red",
				shape: "ring",
				text: "invalid configuration",
			});
			return;
		}

		// add export server
		const node = this;
		initPrometheus(config)
			.then(() =>
				node.status({ fill: "green", shape: "ring", text: "activated" }),
			)
			.catch((error) =>
				node.status({ fill: "red", shape: "ring", text: error.message }),
			);

		// on node stop, remove export server
		this.on("close", async (done) => {
			await closePrometheus(config);
			this.status({ fill: "red", shape: "ring", text: "disabled" });
			if (typeof done === "function") done();
		});
	}

	RED.nodes.registerType("Prometheus Exporter", PrometheusExporterNode);

	// Support Node-RED 4+ Runtime Plugin
	if (RED.plugins && typeof RED.plugins.registerRuntimePlugin === "function") {
		RED.plugins.registerRuntimePlugin({
			id: "prometheus-runtime",
			onSettings: async (settings) => {
				if (settings.prometheus) {
					// Support multiple exporters via settings.js
					const configs = Array.isArray(settings.prometheus)
						? settings.prometheus
						: [settings.prometheus];
					for (const config of configs) {
						await initPrometheus(config);
					}
				}
			},
			onClose: async () => {
				// We don't have the original configs here easily unless we store them,
				// but stopHttpInExporter can be called or we just let it be.
				// For now, the node 'close' handles individual node instances.
			},
		});
	}
};
