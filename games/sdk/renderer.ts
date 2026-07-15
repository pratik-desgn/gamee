/**
 * Base canvas renderer that game renderers extend.
 *
 * Provides drawing primitives: background, sprites (rect/circle/image),
 * and UI overlay text.
 */
export abstract class Renderer {
  protected ctx: CanvasRenderingContext2D;
  protected width: number;
  protected height: number;

  constructor(ctx: CanvasRenderingContext2D, width: number, height: number) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
  }

  /** Clear the entire canvas */
  clear(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  /** Draw a solid-color background */
  drawBackground(color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  /** Draw a filled rectangle */
  fillRect(x: number, y: number, w: number, h: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, w, h);
  }

  /** Draw a stroked rectangle */
  strokeRect(x: number, y: number, w: number, h: number, color: string, lineWidth: number = 2): void {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.strokeRect(x, y, w, h);
  }

  /** Draw a filled circle */
  fillCircle(x: number, y: number, radius: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    this.ctx.fill();
  }

  /** Draw text on the canvas */
  drawText(
    text: string,
    x: number,
    y: number,
    color: string,
    fontSize: number = 16,
    fontFamily: string = 'monospace',
    align: CanvasTextAlign = 'left',
    baseline: CanvasTextBaseline = 'top',
  ): void {
    this.ctx.fillStyle = color;
    this.ctx.font = `${fontSize}px ${fontFamily}`;
    this.ctx.textAlign = align;
    this.ctx.textBaseline = baseline;
    this.ctx.fillText(text, x, y);
  }

  /** Draw a sprite image (scaled to fit) */
  drawImage(
    image: CanvasImageSource,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    this.ctx.drawImage(image, x, y, w, h);
  }

  /** Draw a UI overlay with semi-transparent background */
  drawOverlay(
    text: string,
    color: string = 'rgba(0,0,0,0.7)',
    textColor: string = '#fff',
    fontSize: number = 24,
  ): void {
    this.fillRect(0, 0, this.width, this.height, color);
    this.drawText(
      text,
      this.width / 2,
      this.height / 2,
      textColor,
      fontSize,
      'monospace',
      'center',
      'middle',
    );
  }

  /** Subclasses must implement this to render their game state */
  abstract render(state: Record<string, unknown>): void;
}
