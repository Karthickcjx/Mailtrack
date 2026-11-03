// P2 diagnostic panel — DOM APIs only (createElement/textContent/append). No HTML sinks, no policies.
export interface PanelLine { status: string; id: string }

export class DiagnosticPanel {
  private root: HTMLDivElement | null = null;
  constructor(private readonly title: string, private readonly onCopy: () => string, private readonly doc: Document = document) {}

  render(lines: PanelLine[], footer: string): HTMLDivElement | null {
    if (!this.doc.body) return null;
    if (!this.root) {
      this.root = this.doc.createElement('div');
      this.root.id = 'tracklet-p2-panel';
      this.root.setAttribute('role', 'status');
      this.root.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:2147483647;background:#fff;color:#202124;border:1px solid #888;border-radius:6px;padding:6px 8px;font:11px system-ui;max-width:380px;max-height:240px;overflow:auto;box-shadow:0 2px 8px rgba(0,0,0,.2)';
      this.doc.body.appendChild(this.root);
    }
    const title = this.doc.createElement('b');
    title.textContent = this.title;
    const copy = this.doc.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy results';
    copy.style.marginLeft = '8px';
    copy.addEventListener('click', () => { void navigator.clipboard?.writeText(this.onCopy()); copy.textContent = 'Copied'; });
    const rows = lines.slice(-10).map((l) => {
      const d = this.doc.createElement('div');
      d.className = 'tracklet-p2-line';
      d.textContent = `${l.status} ${l.id}`;
      return d;
    });
    const foot = this.doc.createElement('div');
    foot.textContent = footer;
    this.root.replaceChildren(title, copy, ...rows, foot);
    return this.root;
  }
}
