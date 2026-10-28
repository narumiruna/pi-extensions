import { formatClockTime } from "./time-format.js";
import { defineModule } from "./types.js";

export const timeModule = defineModule({
  name: "time",
  variables: ["symbol", "time"],
  defaults: {
    format: "[$symbol $time ]($style)",
    symbol: "🕒",
    style: "bold yellow",
    disabled: false,
  },
  options: {
    use_12hr: { kind: "boolean", default: false },
    time_format: { kind: "string", default: "", allowEmpty: true },
    utc_time_offset: { kind: "string", default: "local" },
    time_range: { kind: "string", default: "-", allowEmpty: true },
  },
  values: ({ runtime, options }) => {
    const time = formatClockTime(runtime.now, options);
    return time === undefined ? undefined : { time };
  },
});
