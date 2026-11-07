"use strict";
// Лендинг: пока класс .locked на <html>, страница не прокручивается колесом,
// клавишами или свайпом. Вниз переходим только по кнопкам с data-enter.
(function () {
  const root = document.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior = reduceMotion ? "auto" : "smooth";

  function scrollToSection(id) {
    const target = document.getElementById(id) || document.getElementById("app");
    const topbar = document.querySelector(".topbar");
    const offset = id === "how" || !topbar ? 0 : topbar.offsetHeight + 12;
    const y = target.getBoundingClientRect().top + window.scrollY - offset;
    if (target.tagName === "DETAILS") target.open = true;
    window.scrollTo({top: Math.max(0, y), behavior});
  }

  function enter(id) {
    root.classList.remove("locked");
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
    if (enterButton) { event.preventDefault(); enter(enterButton.dataset.enter); return; }
    const goto = event.target.closest("[data-goto]");
    if (goto) { event.preventDefault(); scrollToSection(goto.dataset.goto); return; }
    const home = event.target.closest("[data-home]");
    if (home) { event.preventDefault(); goHome(); }
  });

  // Если пользователь вернулся на лендинг сам (например, Home), снова блокируем.
  window.addEventListener("load", () => { if (window.scrollY > 2) root.classList.remove("locked"); });

  // Липкая шапка появляется, когда лендинг ушёл из видимости.
  const hero = document.getElementById("hero");
  const topbar = document.querySelector(".topbar");
  if ("IntersectionObserver" in window && hero && topbar) {
    new IntersectionObserver(([entry]) => topbar.classList.toggle("visible", !entry.isIntersecting),
      {threshold: 0.02}).observe(hero);
  }
})();
