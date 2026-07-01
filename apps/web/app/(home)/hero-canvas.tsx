"use client";

import { GrainGradient } from "@paper-design/shaders-react";
import { useEffect, useState } from "react";

/** Hex mirrors of the tokens in tokens.css — WebGL uniforms can't read CSS
 * custom properties. Keep in sync: paper, deep violets, brass, coral. */
const COLOR_BACK = "#14111d";
const COLORS = ["#241b3a", "#4d3a6e", "#e0a15c", "#d96f5e"];

const BASE_SPEED = 0.45;

export const HeroCanvas = () => {
  const [speed, setSpeed] = useState(BASE_SPEED);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setSpeed(mq.matches ? 0 : BASE_SPEED);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  return (
    <GrainGradient
      aria-hidden="true"
      className="hm-hero-canvas"
      colorBack={COLOR_BACK}
      colors={COLORS}
      fit="contain"
      intensity={0.32}
      noise={0.45}
      offsetX={0.35}
      offsetY={-0.05}
      scale={1.5}
      shape="blob"
      softness={0.78}
      speed={speed}
    />
  );
};
