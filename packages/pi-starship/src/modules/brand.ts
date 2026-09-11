import { defineModule } from "./types.js";

export const brandModule = defineModule({
  name: "brand",
  variables: ["symbol"],
  defaults: {
    format: "[ $symbol ]($style)",
    symbol: "π",
    style: "bold white",
    disabled: false,
  },
  values: () => ({}),
});
