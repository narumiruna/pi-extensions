export interface CommandOptions {
  yes: boolean;
  force: boolean;
  stale: boolean;
  silent: boolean;
  reload: boolean;
  auto: boolean;
  setup?: string;
  signal?: AbortSignal;
  onCommit?: () => void;
  args: string[];
}

export interface CommandArgumentCompletion {
  value: string;
  label: string;
  description?: string;
}
