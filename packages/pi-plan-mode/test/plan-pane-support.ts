import { CustomEditor, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type Editor,
  type EditorTheme,
  getKeybindings,
  type OverlayHandle,
  ScrollView,
  Text,
  type TUI,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { FullscreenTerminal } from "@narumitw/pi-tui-kit/testing";

export const PANE_KEY = "plan-mode.pane";
type Widget = Component & { dispose?(): void };

export function createPlanPaneHost<E extends Editor = Editor>(
  mode: TUI["mode"] = "fullscreen",
  createEditor?: (tui: TUI, theme: EditorTheme) => E,
) {
  const terminal = new FullscreenTerminal();
  terminal.columns = 100;
  terminal.rows = 18;
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
  const keybindings = () => getKeybindings() as ConstructorParameters<typeof CustomEditor>[2];
  const makeEditor = () => {
    const component =
      createEditor?.(tui, editorTheme) ?? (new CustomEditor(tui, editorTheme, keybindings()) as Editor as E);
    component.onSubmit ??= () => {};
    return component;
  };
  let editor = makeEditor();
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
  const overlays: OverlayHandle[] = [];
  const cleanups = new Set<() => void>();
  let nextFactory: Promise<void> | undefined;
  let closes = 0;
  const custom: ExtensionContext["ui"]["custom"] = async (factory, options) => {
    const gate = nextFactory;
    nextFactory = undefined;
    return new Promise((resolve, reject) => {
      let component: Widget | undefined;
      let handle: OverlayHandle | undefined;
      let finished = false;
      const unmount = () => {
        if (!cleanups.delete(unmount)) return;
        if (handle) handle.hide();
        else if (component && editorContainer.children.includes(component)) {
          editorContainer.clear();
          editorContainer.addChild(editor);
          host.setFocus(editor);
        }
        component?.dispose?.();
      };
      const start = async () => {
        if (gate) await gate;
        component = await factory(tui, theme, keybindings(), (result) => {
          if (finished) return;
          finished = true;
          if (options?.overlay) closes++;
          unmount();
          resolve(result);
        });
        if (finished) return;
        cleanups.add(unmount);
        if (options?.overlay) {
          const { overlayOptions } = options;
          handle = host.showOverlay(
            component,
            typeof overlayOptions === "function" ? overlayOptions() : overlayOptions,
          );
          overlays.push(handle);
          options.onHandle?.(handle);
        } else {
          editorContainer.clear();
          editorContainer.addChild(component);
          host.setFocus(component);
          host.requestRender();
        }
      };
      void start().catch(reject);
    });
  };
  return {
    appendToTranscript(component: Component) {
      document.addChild(component);
      host.requestRender();
    },
    get editor() {
      return editor;
    },
    transcript,
    root,
    setWidget,
    custom,
    overlays,
    get closes() {
      return closes;
    },
    delayNextFactory(until: Promise<void>) {
      nextFactory = until;
    },
    resetCustomUi() {
      for (const cleanup of cleanups) cleanup();
    },
    replaceEditor() {
      const text = editor.getExpandedText();
      editorContainer.clear();
      editor = makeEditor();
      editor.setText(text);
      editorContainer.addChild(editor);
      host.setFocus(editor);
    },
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
      return host instanceof TuiAltScreen
        ? host.getScreenLines()
        : host.captureRenderState().previousLines.slice(-terminal.rows);
    },
    resize(width: number, height: number) {
      terminal.columns = width;
      terminal.rows = height;
      host.requestRender();
    },
    send(data: string) {
      terminal.input(data);
      host.renderNow();
    },
    stop() {
      for (const cleanup of cleanups) cleanup();
      widget?.dispose?.();
      host.stop();
    },
  };
}
