"use client";

import { useEffect } from "react";

/** One IntersectionObserver adds .is-in to every [data-reveal] element the
 * first time it enters the viewport. Reduced motion reveals everything
 * immediately. */
export const Reveal = () => {
  useEffect(() => {
    // The hidden state is gated on this class, so a page without JavaScript
    // (or a failed hydration) never blanks its sections.
    document.documentElement.classList.add("hm-js");
    const els = document.querySelectorAll("[data-reveal]");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const el of els) {
        el.classList.add("is-in");
      }
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px" }
    );
    for (const el of els) {
      io.observe(el);
    }
    return () => io.disconnect();
  }, []);
  return null;
};
