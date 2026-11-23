import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Editor,
  type EditorTheme,
  ScrollView,
  type Terminal,
  Text,
  type TUI,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
} from "@earendil-works/pi-tui";

export const PANE_KEY = "plan-mode.pane";
type Widget = Component & { dispose?(): void };

export function createPlanPaneHost<E extends Editor = Editor>(
  mode: TUI["mode"] = "fullscreen",
  createEditor?: (tui: TUI, theme: EditorTheme) => E,
) {
  let columns = 100;
  let rows = 18;
  let input: (data: string) => void = () => {};
  const noop = () => {};
  const terminal: Terminal = {
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    kittyProtocolActive: false,
    start(onInput) {
      input = onInput;
    },
    stop: noop,
    drainInput: async () => {},
    write: noop,
    moveBy: noop,
    hideCursor: noop,
    showCursor: noop,
    clearLine: noop,
    clearFromCursor: noop,
    clearScreen: noop,
    setTitle: noop,
    setProgress: noop,
    setProgramStatus: noop,
  };
  const makeRenderer = (mode: TUI["mode"]) =>
    mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  let host = makeRenderer(mode);
  const tui = new Proxy({} as TUI, {
    get(_target, property) {
      const current = host;
      const value = Reflect.get(current, property);
      return typeof value === "function" ? value.bind(current) : value;
    },
  });
  let titleStyle = "\u001b[31m";
  const theme = {
    fg: (role: string, text: string) => (role === "accent" ? `${titleStyle}${text}\u001b[39m` : text),
    bold: (text: string) => text,
  } as Theme;
  const editorTheme: EditorTheme = {
    borderColor: (text) => text,
    selectList: {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    },
  };
  const editor = createEditor?.(tui, editorTheme) ?? (new Editor(tui, editorTheme) as E);
  editor.setText("main draft");
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  const document = new Container();
  document.addChild(new Text(Array.from({ length: 100 }, (_, index) => `history ${index}`).join("\n"), 0, 0));
  const widgetsAbove = new Container();
  const mainComponents = [document, widgetsAbove, editorContainer];
  const transcript = new ScrollView(document, { primary: true, follow: "end" });
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, minSize: 1 },
    new VStack([widgetsAbove, editorContainer]),
  ]);
  function mount() {
    for (const child of mainComponents) host.addChild(child);
    if (host instanceof TuiAltScreen) host.setLayoutRoot(root);
    host.setFocus(editor);
    host.start();
    host.renderNow();
  }
  mount();
  let widget: Widget | undefined;
  const setWidget: ExtensionContext["ui"]["setWidget"] = (key, factory) => {
    if (key !== PANE_KEY) return;
    widget?.dispose?.();
    widgetsAbove.clear();
    widget = typeof factory === "function" ? factory(tui, theme) : undefined;
    if (widget) widgetsAbove.addChild(widget);
    host.requestRender();
  };
  return {
    appendToTranscript(component: Component) {
      document.addChild(component);
      host.requestRender();
    },
    editor,
    transcript,
    root,
    setWidget,
    get host() {
      return host;
    },
    get fullscreen() {
      if (!(host instanceof TuiAltScreen)) throw new Error("Host is not fullscreen");
      return host;
    },
    changeTheme() {
      titleStyle = "\u001b[32m";
      host.invalidate();
    },
    switchMode(mode: TUI["mode"]) {
      host.stop();
      host.setFocus(null);
      host.clear();
      if (host instanceof TuiAltScreen) host.setLayoutRoot(undefined);
      host = makeRenderer(mode);
      mount();
    },
    render() {
      host.renderNow();
      return host instanceof TuiAltScreen ? host.getScreenLines() : [];
    },
    resize(width: number, height: number) {
      columns = width;
      rows = height;
      host.requestRender();
    },
    send(data: string) {
      input(data);
      host.renderNow();
    },
    stop() {
      widget?.dispose?.();
      host.stop();
    },
  };
}
