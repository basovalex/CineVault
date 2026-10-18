(() => {
  "use strict";

  // Android-only WebView layout fix for Alloha's intro-skip overlay.
  if (location.hostname !== "theatre.stravers.live") return;

  const LABEL = "пропустить заставку";
  const selector = "button,[role='button'],a,div";

  function moveSkipIntro() {
    const matches = [...document.querySelectorAll(selector)]
      .filter((element) => (element.innerText || element.textContent || "")
        .replace(/\s+/g, " ").trim().toLowerCase().includes(LABEL))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width >= 120 && rect.height >= 30)
      .sort((left, right) =>
        left.rect.width * left.rect.height - right.rect.width * right.rect.height);

    const target = matches[0]?.element;
    if (!target) return;

    // Transform moves the clickable area together with the visual button.
    target.style.setProperty("transform", "translateY(-56px)", "important");
    target.style.setProperty("z-index", "2147483646", "important");
  }

  const observe = () => {
    if (!document.documentElement) {
      requestAnimationFrame(observe);
      return;
    }
    const observer = new MutationObserver(moveSkipIntro);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    moveSkipIntro();
    window.addEventListener("resize", moveSkipIntro, { passive: true });
  };

  observe();
})();
