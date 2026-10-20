/* Patch a container to new HTML in place.
 *
 * Re-rendering a panel with innerHTML replaces every element: inputs lose
 * focus and caret, scrolled lists jump back to the top and open menus close.
 * morph() keeps every element whose position and tag (and id, when set) are
 * unchanged, updates its attributes and text, and only creates or removes the
 * elements that really changed. A focused field keeps the value being typed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WebMeshDom = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function same(a, b) {
    if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
    if (a.nodeType !== 1) return true;
    // Distinct ids or keys mean distinct elements, even at the same position.
    return (a.id || '') === (b.id || '') && (a.getAttribute('data-key') || '') === (b.getAttribute('data-key') || '');
  }

  function attributes(target, source) {
    for (const { name } of [...target.attributes]) if (!source.hasAttribute(name)) target.removeAttribute(name);
    for (const { name, value } of [...source.attributes]) if (target.getAttribute(name) !== value) target.setAttribute(name, value);
  }

  function formState(target, source) {
    const focused = target.ownerDocument && target.ownerDocument.activeElement === target;
    if (target.nodeName === 'INPUT') {
      if (target.type === 'checkbox' || target.type === 'radio') target.checked = source.hasAttribute('checked');
      else if (!focused) {
        const value = source.getAttribute('value') ?? '';
        if (target.value !== value) target.value = value;
      }
    } else if (target.nodeName === 'TEXTAREA' && !focused) {
      if (target.value !== source.textContent) target.value = source.textContent;
    }
  }

  function children(target, source) {
    const before = [...target.childNodes], after = [...source.childNodes];
    for (let i = 0; i < after.length; i++) {
      const old = before[i], next = after[i];
      if (!old) { target.appendChild(next); continue; }
      if (!same(old, next)) { target.replaceChild(next, old); continue; }
      if (old.nodeType !== 1) {
        if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue;
        continue;
      }
      attributes(old, next);
      if (old.nodeName === 'TEXTAREA') { formState(old, next); continue; }
      children(old, next);
      formState(old, next);
      if (old.nodeName === 'SELECT') {
        const chosen = next.querySelector('option[selected]');
        if (chosen && old.ownerDocument.activeElement !== old) old.value = chosen.value;
      }
    }
    for (let i = before.length - 1; i >= after.length; i--) target.removeChild(before[i]);
  }

  /** Update `target`'s children to `html`, keeping unchanged elements (and their focus and scroll). */
  function morph(target, html) {
    if (!target) return;
    const template = target.ownerDocument.createElement('template');
    template.innerHTML = html;
    children(target, template.content);
  }

  return { morph };
}));
