import { useRef } from "react";

/** Two navigation levels share one roving-focus pattern; keyboard events stay in their own list. */
export function NavigationTabs<T extends string>({
  id,
  label,
  tabs,
  value,
  change,
}: {
  id: string;
  label: string;
  tabs: readonly { value: T; label: string }[];
  value: T;
  change(value: T): void;
}) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  return (
    <div className="navigation-tabs view-switch" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          key={tab.value}
          ref={(button) => {
            if (button) buttons.current.set(tab.value, button);
            else buttons.current.delete(tab.value);
          }}
          type="button"
          role="tab"
          id={`${id}-tab-${tab.value}`}
          aria-controls={`${id}-panel-${tab.value}`}
          aria-selected={value === tab.value}
          tabIndex={value === tab.value ? 0 : -1}
          onClick={() => change(tab.value)}
          onKeyDown={(event) => {
            let next: number;
            switch (event.key) {
              case "ArrowRight":
                next = (index + 1) % tabs.length;
                break;
              case "ArrowLeft":
                next = (index + tabs.length - 1) % tabs.length;
                break;
              case "Home":
                next = 0;
                break;
              case "End":
                next = tabs.length - 1;
                break;
              default:
                return;
            }
            event.preventDefault();
            const target = tabs[next];
            if (target) {
              change(target.value);
              buttons.current.get(target.value)?.focus();
            }
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
