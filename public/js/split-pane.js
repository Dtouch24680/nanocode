/**
 * initSplitPane — drag-to-resize divider between two panes.
 * Sets --split CSS custom property on the container.
 */

export function initSplitPane(container, divider, onResize) {
  if (!divider) return;
  let dragging = false;

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    divider.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = (x / rect.width) * 100;
    const clamped = Math.min(80, Math.max(20, pct));
    container.style.setProperty('--split', `${clamped}%`);
    if (onResize) onResize();
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (onResize) onResize();
  });
}
