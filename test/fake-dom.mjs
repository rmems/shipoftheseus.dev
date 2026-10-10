// A deliberately small DOM for behavior tests of progressive-enhancement code
// without a browser or a new dependency. It implements only what the tested
// modules use: elements, text, fragments, attributes, `dataset`, `hidden`,
// `textContent`, `append`/`replaceChildren`, click listeners, and attribute
// selectors (`[data-x]`, `[data-x="v"]`). Anything else throws, so a test fails
// loudly instead of passing against behavior the fake does not model.

const ATTRIBUTE_SELECTOR = /^\[([a-z][a-z0-9-]*)(?:=(["'])(.*)\2)?\]$/;

function kebab(camel) {
  return camel.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

class FakeText {
  constructor(text) {
    this.parent = null;
    this.data = String(text);
  }

  get textContent() {
    return this.data;
  }
}

export class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.parent = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.dataset = new Proxy(
      {},
      {
        get: (_target, key) => (typeof key === 'string' ? this.getAttribute(`data-${kebab(key)}`) ?? undefined : undefined),
        set: (_target, key, value) => {
          this.setAttribute(`data-${kebab(key)}`, String(value));
          return true;
        },
        deleteProperty: (_target, key) => {
          this.removeAttribute(`data-${kebab(key)}`);
          return true;
        },
        has: (_target, key) => this.hasAttribute(`data-${kebab(key)}`),
      },
    );
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  get hidden() {
    return this.hasAttribute('hidden');
  }

  set hidden(value) {
    if (value) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof FakeElement);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this.replaceChildren(...(value === '' ? [] : [String(value)]));
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeFragment) {
        this.append(...node.childNodes);
        continue;
      }
      const child = typeof node === 'string' ? new FakeText(node) : node;
      if (child.parent) child.parent.childNodes = child.parent.childNodes.filter((other) => other !== child);
      child.parent = this;
      this.childNodes.push(child);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parent = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  querySelectorAll(selector) {
    const match = ATTRIBUTE_SELECTOR.exec(selector);
    if (!match) throw new Error(`fake DOM supports only attribute selectors, not ${selector}`);
    const [, name, , value] = match;
    const found = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (child.hasAttribute(name) && (value === undefined || child.getAttribute(name) === value)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  /** Dispatch to every listener and wait for async handlers to settle. */
  async dispatch(type) {
    await Promise.all((this.listeners.get(type) ?? []).map((listener) => listener({ type, target: this })));
  }
}

class FakeFragment extends FakeElement {
  constructor() {
    super('#fragment');
  }
}

export function createFakeDocument() {
  return {
    createElement: (tagName) => new FakeElement(tagName),
    createDocumentFragment: () => new FakeFragment(),
  };
}

/** Build an element tree: `h('p', { 'data-x': '' }, 'text', h(...))`. */
export function h(tagName, attributes = {}, ...children) {
  const element = new FakeElement(tagName);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.append(...children);
  return element;
}
