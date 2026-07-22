import type {
	Observation,
	ObservationAttributes,
	ObservationType,
	TraceBackend,
} from "../src/tracing.js";

export class FakeObservation implements Observation {
	readonly updates: ObservationAttributes[] = [];
	readonly traceUpdates: ObservationAttributes[] = [];
	ended = false;
	endCalls = 0;
	endTime: number | undefined;

	constructor(
		readonly name: string,
		readonly attributes: ObservationAttributes,
		readonly type: ObservationType,
		readonly parent?: Observation,
	) {}

	update(attributes: ObservationAttributes) {
		this.updates.push(attributes);
		return this;
	}

	updateTrace(attributes: ObservationAttributes) {
		this.traceUpdates.push(attributes);
		return this;
	}

	end(endTime?: number) {
		this.ended = true;
		this.endCalls += 1;
		this.endTime = endTime;
		return this;
	}
}

export class FakeBackend implements TraceBackend {
	readonly observations: FakeObservation[] = [];
	flushes = 0;
	shutdowns = 0;

	start(
		name: string,
		attributes: ObservationAttributes,
		options: { asType: ObservationType; parent?: Observation },
	) {
		const observation = new FakeObservation(name, attributes, options.asType, options.parent);
		this.observations.push(observation);
		return observation;
	}

	async forceFlush() {
		this.flushes += 1;
	}

	async shutdown() {
		this.shutdowns += 1;
	}
}

export function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}
