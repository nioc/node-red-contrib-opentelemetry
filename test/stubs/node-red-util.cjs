const handlers = new Set();

module.exports = {
	log: {
		log: () => {},
		INFO: "info",
		ERROR: "error",
		WARN: "warn",
		DEBUG: "debug",
		TRACE: "trace",
		FATAL: "fatal",
		AUDIT: "audit",
		METRIC: "metric",
		addHandler: (handler) => {
			handlers.add(handler);
		},
		removeHandler: (handler) => {
			handlers.delete(handler);
		},
		emit: (entry) => {
			for (const handler of handlers) {
				if (handler && typeof handler.emit === "function") {
					handler.emit("log", entry);
				}
			}
		},
		handlerCount: () => handlers.size,
		reset: () => {
			handlers.clear();
		},
	},
};
