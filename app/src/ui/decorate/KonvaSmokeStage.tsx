"use client";

import type Konva from "konva";
import { useState } from "react";
import { Layer, Line, Stage, Star } from "react-konva";

/*
 * Konva/react-konva 최소 호환 스모크(시험 fixture). 하루 꾸미기 편집기 UI가 아니다(별도 아트보드·계획 필요).
 * 스티커 1개 끌기와 펜 획 1개만 확인한다. 이 모듈은 브라우저 전용이며 서버 모듈에서 import하지 않는다.
 */
const W = 320;
const H = 240;

export default function KonvaSmokeStage() {
  const [sticker, setSticker] = useState({ x: 70, y: 70 });
  const [strokes, setStrokes] = useState<number[][]>([]);
  const [drawing, setDrawing] = useState(false);

  function point(e: Konva.KonvaEventObject<PointerEvent>): [number, number] | null {
    const p = e.target.getStage()?.getPointerPosition();
    return p ? [Math.round(p.x), Math.round(p.y)] : null;
  }

  return (
    <div
      className="smoke"
      data-testid="konva-smoke"
      data-sticker={`${Math.round(sticker.x)},${Math.round(sticker.y)}`}
      data-strokes={strokes.length}
      data-last-points={strokes.at(-1)?.length ?? 0}
    >
      <div className="smoke-stage">
        <Stage
          width={W}
          height={H}
          onPointerDown={(e) => {
            if (e.target !== e.target.getStage()) return; // 스티커 위에서는 끌기만
            const p = point(e);
            if (!p) return;
            setDrawing(true);
            setStrokes((s) => [...s, p]);
          }}
          onPointerMove={(e) => {
            if (!drawing) return;
            const p = point(e);
            if (p) setStrokes((s) => [...s.slice(0, -1), [...(s.at(-1) ?? []), ...p]]);
          }}
          onPointerUp={() => setDrawing(false)}
        >
          <Layer>
            {strokes.map((pts, i) => (
              <Line key={i} points={pts} stroke="#2A211C" strokeWidth={3} lineCap="round" lineJoin="round" />
            ))}
            <Star
              name="sticker"
              x={sticker.x}
              y={sticker.y}
              numPoints={5}
              innerRadius={14}
              outerRadius={30}
              fill="#F1DED2"
              stroke="#9E4527"
              strokeWidth={2}
              draggable
              onDragEnd={(e) => setSticker({ x: e.target.x(), y: e.target.y() })}
            />
          </Layer>
        </Stage>
      </div>
      <p className="hint">
        스티커 {Math.round(sticker.x)},{Math.round(sticker.y)} · 획 {strokes.length}개
      </p>
    </div>
  );
}
