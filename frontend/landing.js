"use strict";
// Лендинг: пока класс .locked на <html>, страница не прокручивается колесом,
// клавишами или свайпом. Вниз переходим только по кнопкам с data-enter.
(function () {
  const root = document.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior = reduceMotion ? "auto" : "smooth";

  function scrollToSection(id) {
    const target = document.getElementById(id) || document.getElementById("workspace");
    const y = target.getBoundingClientRect().top + window.scrollY - (id === "how" ? 0 : 12);
    window.scrollTo({top: Math.max(0, y), behavior});
  }

  function openView(view) {
    if (view) document.dispatchEvent(new CustomEvent("cqa:show-view", {detail: {view}}));
  }

  function enter(id, view) {
    root.classList.remove("locked");
    openView(view);
    // Даём браузеру снять overflow:hidden перед прокруткой.
    requestAnimationFrame(() => scrollToSection(id));
  }

  function goHome() {
    window.scrollTo({top: 0, behavior});
    const lockWhenTop = () => {
      if (window.scrollY <= 2) { root.classList.add("locked"); window.removeEventListener("scroll", lockWhenTop); }
    };
    window.addEventListener("scroll", lockWhenTop);
    lockWhenTop();
  }

  document.addEventListener("click", event => {
    const enterButton = event.target.closest("[data-enter]");
    if (enterButton) { event.preventDefault(); enter(enterButton.dataset.enter, enterButton.dataset.view); return; }
    const goto = event.target.closest("[data-goto]");
    if (goto) { event.preventDefault(); openView(goto.dataset.view); scrollToSection(goto.dataset.goto); return; }
    const home = event.target.closest("[data-home]");
    if (home) { event.preventDefault(); goHome(); }
  });

  window.addEventListener("load", () => { if (window.scrollY > 2) root.classList.remove("locked"); });
})();
