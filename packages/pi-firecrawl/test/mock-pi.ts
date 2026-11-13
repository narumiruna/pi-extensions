import { createMockPi as createBaseMockPi } from "../../../test/support.js";

// Mirrors AgentSession exposure filtering and same-name replacement without changing shared mocks.
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
    else if (
      (tool.exposure === undefined || tool.exposure === "direct" || tool.exposure === "model-only") &&
      tool.defaultActive !== false
    ) {
      setActive([...new Set([...getActive(), tool.name as string])]);
    }
  };
  mock.rawPi.setActiveTools = (names) =>
    setActive(names.filter((name) => mock.tools.find((tool) => tool.name === name)?.exposure !== "hidden"));
  mock.rawPi.getAllTools = () => [...getAll(), ...mock.tools];
  return mock;
}
