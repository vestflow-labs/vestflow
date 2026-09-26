/**
 * Recording stand-in for a 2D canvas context.
 *
 * The timeline's drawing code is pure with respect to the context, so asserting
 * on the sequence of calls (and the style in force when each was made) verifies
 * the visual treatments without a real canvas or pixel comparisons.
 */

export interface RecordedCall {
  method: string;
  args: number[];
  fillStyle: unknown;
  strokeStyle: unknown;
}

export interface StubContext {
  calls: RecordedCall[];
  fillRects(): RecordedCall[];
  linesAt(): { x: number; y0: number; y1: number }[];
}

const METHODS = [
  "clearRect",
  "fillRect",
  "strokeRect",
  "beginPath",
  "closePath",
  "moveTo",
  "lineTo",
  "arc",
  "rect",
  "clip",
  "fill",
  "stroke",
  "save",
  "restore",
  "fillText",
  "setTransform",
] as const;

/** A gradient stand-in that records its stops. */
export interface StubGradient {
  x0: number;
  x1: number;
  stops: { offset: number; color: string }[];
  addColorStop(offset: number, color: string): void;
}

export function createStubContext(): CanvasRenderingContext2D & StubContext {
  const calls: RecordedCall[] = [];
  const ctx = {
    fillStyle: "" as unknown,
    strokeStyle: "" as unknown,
    lineWidth: 1,
    font: "",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    calls,
    createLinearGradient(x0: number, _y0: number, x1: number): StubGradient {
      const gradient: StubGradient = {
        x0,
        x1,
        stops: [],
        addColorStop(offset: number, color: string) {
          gradient.stops.push({ offset, color });
        },
      };
      return gradient;
    },
    createPattern(): null {
      return null;
    },
    measureText(text: string) {
      return { width: text.length * 6 };
    },
    fillRects() {
      return calls.filter((c) => c.method === "fillRect");
    },
    /**
     * Vertical strokes recorded as moveTo/lineTo pairs — how the axis grid,
     * tranche markers and the cursor line are all drawn.
     */
    linesAt() {
      const lines: { x: number; y0: number; y1: number }[] = [];
      for (let i = 0; i < calls.length - 1; i++) {
        const a = calls[i];
        const b = calls[i + 1];
        if (a.method === "moveTo" && b.method === "lineTo" && a.args[0] === b.args[0]) {
          lines.push({ x: a.args[0], y0: a.args[1], y1: b.args[1] });
        }
      }
      return lines;
    },
  } as Record<string, unknown>;

  for (const method of METHODS) {
    ctx[method] = (...args: number[]) => {
      calls.push({
        method,
        args,
        fillStyle: ctx.fillStyle,
        strokeStyle: ctx.strokeStyle,
      });
    };
  }

  return ctx as unknown as CanvasRenderingContext2D & StubContext;
}

/** Installs the stub on every `<canvas>` in a jsdom document. */
export function stubCanvasElements(): CanvasRenderingContext2D & StubContext {
  const shared = createStubContext();
  HTMLCanvasElement.prototype.getContext = (() =>
    shared) as unknown as HTMLCanvasElement["getContext"];
  return shared;
}
