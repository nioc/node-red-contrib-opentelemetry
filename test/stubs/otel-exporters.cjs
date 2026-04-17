class FastNoopExporter {
	constructor(_options) {}

	export(_items, resultCallback) {
		if (typeof resultCallback === "function") {
			resultCallback({ code: 0 });
		}
	}

	forceFlush() {
		return Promise.resolve();
	}

	shutdown() {
		return Promise.resolve();
	}
}

module.exports = {
	OTLPTraceExporter: FastNoopExporter,
	OTLPMetricExporter: FastNoopExporter,
	OTLPLogExporter: FastNoopExporter,
};
