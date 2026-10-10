import type { Page } from "playwright-core";

/** Install a read-only picker; even a disabled submit control can be recorded. */
export async function installControlPicker(page: Page, label: string, kind: "button" | "account" | "editor") {
  await page.evaluate(({ label, kind }) => {
    const notice = document.createElement("div");
    notice.id = "builder-automation-picker-notice";
    notice.textContent = label + " (selection only; this click will not activate the control)";
    Object.assign(notice.style, { position: "fixed", top: "0", left: "0", right: "0", zIndex: "2147483647", background: "#153d4b", color: "white", padding: "15px", font: "14px sans-serif", pointerEvents: "none" });
    document.body.append(notice);
    // Object methods keep tsx from adding Node-side function-name helpers to
    // this callback, which Playwright serializes into the browser.
    const picker = {
      selectorFor(element: Element): string {
        if (element.id) {
          const selector = `#${CSS.escape(element.id)}`;
          if (document.querySelectorAll(selector).length === 1) return selector;
        }
        const parts: string[] = [];
        let node: Element | null = element;
        while (node && node !== document.documentElement) {
          const parent: Element | null = node.parentElement;
          if (!parent) break;
          parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(node) + 1})`);
          const selector = parts.join(" > ");
          if (document.querySelectorAll(selector).length === 1) return selector;
          node = parent;
        }
        throw new Error("Could not record a unique observed selector.");
      },
      blockClick(event: MouseEvent) { event.preventDefault(); event.stopImmediatePropagation(); },
      choose(event: PointerEvent) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const target = event.target instanceof Element ? event.target : document.elementFromPoint(event.clientX, event.clientY);
        const element = target?.closest(kind === "editor" ? 'textarea,input,[contenteditable="true"],[role="textbox"]' : kind === "account" ? 'a[href]' : 'button,[role="button"],input[type="submit"]');
        if (!element) { notice.textContent = "Choose the requested control. Other clicks are blocked until a valid control is selected."; return; }
        const selector = picker.selectorFor(element);
        const href = element instanceof HTMLAnchorElement ? element.href : null;
        document.removeEventListener("pointerdown", picker.choose, true);
        notice.remove();
        // Pointerdown also occurs on disabled buttons. Block its following click,
        // then remove interception so the owner can use normal AWS controls again.
        setTimeout(() => document.removeEventListener("click", picker.blockClick, true), 600);
        void (window as unknown as { recordAwsControl(value: { selector: string; href: string | null }): Promise<void> }).recordAwsControl({ selector, href });
      }
    };
    document.addEventListener("click", picker.blockClick, true);
    document.addEventListener("pointerdown", picker.choose, true);
  }, { label, kind });
}
