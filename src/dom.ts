/** Tiny DOM builder shared by the panel modules. Browser only. */

export type Child = Node | string | null | undefined | false;

/**
 * Creates an element. `class` and `text` are shortcuts, `on*` functions become
 * listeners, non-string values for known properties (checked, disabled,
 * selected, open) are set as properties, and everything else is an attribute.
 * Null, undefined, and false props and children are skipped.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value as EventListener);
    else if (key in node && typeof value !== "string") (node as unknown as Record<string, unknown>)[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}
