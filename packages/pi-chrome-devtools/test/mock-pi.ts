import { createMockPi as createBaseMockPi } from "../../../test/support.js";

// Model public registry replacement and hidden-tool filtering, not just active names.
export function createMockPi(options: Parameters<typeof createBaseMockPi>[0] = {}) {
  const mock = createBaseMockPi(options);
  const getActive = mock.rawPi.getActiveTools.bind(mock.rawPi);
  const setActive = mock.rawPi.setActiveTools.bind(mock.rawPi);
  const getAll = mock.rawPi.getAllTools.bind(mock.rawPi);
  mock.rawPi.registerTool = (value) => {
    const tool = value as (typeof mock.tools)[number];
    const index = mock.tools.findIndex((entry) => entry.name === tool.name);
    if (index >= 0) mock.tools[index] = tool;
    else mock.tools.push(tool);
    if (tool.exposure === "hidden") setActive(getActive().filter((name) => name !== tool.name));
  };
  mock.rawPi.setActiveTools = (names) =>
    setActive(names.filter((name) => mock.tools.find((tool) => tool.name === name)?.exposure !== "hidden"));
  mock.rawPi.getAllTools = () => [...getAll(), ...mock.tools];
  return mock;
}
